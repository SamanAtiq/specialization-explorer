import json
import logging
import time
from urllib.parse import urlparse

import boto3
from opensearchpy import OpenSearch, RequestsHttpConnection, exceptions
from requests_aws4auth import AWS4Auth

logger = logging.getLogger()
logger.setLevel(logging.INFO)

MAX_FORBIDDEN_RETRY_WINDOW_SECONDS = 5 * 60
FORBIDDEN_RETRY_SLEEP_SECONDS = 15
INDEX_STABILIZE_MAX_WINDOW_SECONDS = 3 * 60
INDEX_STABILIZE_POLL_SECONDS = 10
INDEX_STABILIZE_EXTRA_DELAY_SECONDS = 20


def sleep(seconds: int) -> None:
    time.sleep(seconds)


def normalize_endpoint(endpoint: str) -> str:
    trimmed = str(endpoint or "").strip()
    if not trimmed:
        raise ValueError("CollectionEndpoint is required")
    if not trimmed.startswith("https://") and not trimmed.startswith("http://"):
        trimmed = f"https://{trimmed}"
    return trimmed.rstrip("/")


def build_client(endpoint: str, region: str) -> OpenSearch:
    session = boto3.Session()
    credentials = session.get_credentials()
    if credentials is None:
        raise RuntimeError("Unable to load AWS credentials for SigV4 signing")
    frozen = credentials.get_frozen_credentials()

    auth = AWS4Auth(
        frozen.access_key,
        frozen.secret_key,
        region,
        "aoss",
        session_token=frozen.token,
    )

    normalized = normalize_endpoint(endpoint)
    parsed = urlparse(normalized)
    host = parsed.netloc or parsed.path
    if "/" in host:
        host = host.split("/")[0]

    return OpenSearch(
        hosts=[{"host": host, "port": 443}],
        http_auth=auth,
        use_ssl=True,
        verify_certs=True,
        connection_class=RequestsHttpConnection,
        timeout=30,
        retry_on_timeout=False,
        max_retries=0,
    )


def error_message(error: Exception) -> str:
    info = getattr(error, "info", None)
    if isinstance(info, str):
        return info
    if info is not None:
        try:
            return json.dumps(info)
        except Exception:
            return str(info)
    return str(error)


def is_index_already_exists(error_text: str) -> bool:
    text = error_text.lower()
    return "resource_already_exists_exception" in text or "already exists" in text


def ensure_index_with_propagation(client: OpenSearch, props: dict) -> None:
    index_name = props["indexName"]
    vector_field = props["vectorField"]
    text_field = props["textField"]
    metadata_field = props["metadataField"]
    dimensions = int(props["dimensions"])

    deadline = time.time() + MAX_FORBIDDEN_RETRY_WINDOW_SECONDS
    attempt = 0

    body = {
        "settings": {
            "index": {
                "knn": True
            }
        },
        "mappings": {
            "properties": {
                vector_field: {
                    "type": "knn_vector",
                    "dimension": dimensions,
                    "method": {
                        "engine": "faiss",
                        "name": "hnsw",
                        "space_type": "l2"
                    }
                },
                text_field: {
                    "type": "text"
                },
                metadata_field: {
                    "type": "text",
                    "index": False
                }
            }
        }
    }

    while time.time() < deadline:
        attempt += 1

        try:
            if client.indices.exists(index=index_name):
                logger.info("Index '%s' already exists. Skipping create.", index_name)
                return

            client.indices.create(index=index_name, body=body)
            logger.info("Index '%s' created successfully on attempt %s.", index_name, attempt)
            return
        except exceptions.TransportError as error:
            status_code = getattr(error, "status_code", 0)
            text = error_message(error)
            lowered = text.lower()
            transient_auth_or_readiness = (
                status_code in (401, 403, 429, 500, 502, 503, 504)
                or "forbidden" in lowered
                or "authentication" in lowered
                or "unauthorized" in lowered
            )

            if is_index_already_exists(text):
                logger.info("Index '%s' already exists (race condition). Treating as success.", index_name)
                return

            if transient_auth_or_readiness:
                seconds_left = max(0, int(deadline - time.time()))
                logger.warning(
                    "Attempt %s received transient auth/readiness error (status=%s). "
                    "Waiting %ss for AOSS policy propagation/readiness. Remaining retry window: %ss. Error: %s",
                    attempt,
                    status_code,
                    FORBIDDEN_RETRY_SLEEP_SECONDS,
                    seconds_left,
                    text,
                )
                sleep(FORBIDDEN_RETRY_SLEEP_SECONDS)
                continue

            raise

    raise RuntimeError(
        f"Timed out after 5 minutes waiting for AOSS policy propagation while creating index '{index_name}'."
    )


def wait_for_index_stabilization(client: OpenSearch, index_name: str) -> None:
    deadline = time.time() + INDEX_STABILIZE_MAX_WINDOW_SECONDS
    attempt = 0

    while time.time() < deadline:
        attempt += 1
        try:
            exists = client.indices.exists(index=index_name)
            if not exists:
                logger.info("Index stabilization attempt %s: index not visible yet.", attempt)
                sleep(INDEX_STABILIZE_POLL_SECONDS)
                continue

            client.indices.get(index=index_name)
            logger.info(
                "Index '%s' is visible and retrievable. Applying final delay for Bedrock consistency.",
                index_name,
            )
            sleep(INDEX_STABILIZE_EXTRA_DELAY_SECONDS)
            return
        except exceptions.TransportError as error:
            status_code = getattr(error, "status_code", 0)
            text = error_message(error).lower()
            transient = (
                status_code in (401, 403, 404, 429, 500, 502, 503, 504)
                or "no such index" in text
                or "forbidden" in text
                or "authentication" in text
                or "unauthorized" in text
            )

            if transient:
                logger.info(
                    "Index stabilization attempt %s: status=%s, waiting for AOSS data-plane consistency.",
                    attempt,
                    status_code,
                )
                sleep(INDEX_STABILIZE_POLL_SECONDS)
                continue

            raise

    raise RuntimeError(f"Timed out waiting for index '{index_name}' to become visible to downstream services.")


def handler(event, context):
    logger.info("VectorIndexManager event: %s", json.dumps(event))

    request_type = event.get("RequestType")
    existing_physical_id = event.get("PhysicalResourceId") or "vector-index-custom-resource"

    if request_type == "Delete":
        return {
            "PhysicalResourceId": existing_physical_id,
            "Data": {
                "SkippedDelete": "true"
            }
        }

    props = event.get("ResourceProperties") or {}
    endpoint = normalize_endpoint(props.get("CollectionEndpoint"))
    region = props.get("Region")
    index_name = props.get("IndexName")

    if not region or not index_name:
        raise ValueError("Region and IndexName are required resource properties")

    client = build_client(endpoint, region)

    ensure_index_with_propagation(
        client,
        {
            "indexName": index_name,
            "vectorField": props.get("VectorField"),
            "textField": props.get("TextField"),
            "metadataField": props.get("MetadataField"),
            "dimensions": int(props.get("Dimensions")),
        },
    )

    wait_for_index_stabilization(client, index_name)

    physical_resource_id = existing_physical_id
    if existing_physical_id == "vector-index-custom-resource":
        physical_resource_id = f"{index_name}-vector-index"

    return {
        "PhysicalResourceId": physical_resource_id,
        "Data": {
            "IndexName": index_name
        }
    }
