import os
import json
from helpers.cors import get_cors_headers
import logging
import boto3
from uuid import uuid4

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
REGION = os.environ["REGION"]
SCHEDULER_ROLE_ARN = os.environ["SCHEDULER_ROLE_ARN"]
SCHEDULER_TARGET_ARN = os.environ["SCHEDULER_TARGET_ARN"]

MAX_TOTAL_DATA_SOURCES = 5
RESERVED_NON_WEB_DATA_SOURCES = 1
MAX_WEB_DATA_SOURCES = MAX_TOTAL_DATA_SOURCES - RESERVED_NON_WEB_DATA_SOURCES

NEAR_CAPACITY_THRESHOLD = 0.85
FULL_THRESHOLD = 0.95

SYNCING_STATUSES = {"STARTING", "IN_PROGRESS", "STOPPING"}
FAILED_STATUSES = {"FAILED"}
SUCCESS_STATUSES = {"COMPLETE"}

# AWS Clients
bedrock_agent = boto3.client("bedrock-agent", region_name=REGION)
scheduler_client = boto3.client("scheduler", region_name=REGION)

def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            **get_cors_headers(event),
        },
        "body": json.dumps(body),
    }


def _list_all_data_sources(knowledge_base_id: str) -> list[dict]:
    items = []
    next_token = None

    while True:
        kwargs = {
            "knowledgeBaseId": knowledge_base_id,
            "maxResults": 100,
        }
        if next_token:
            kwargs["nextToken"] = next_token

        resp = bedrock_agent.list_data_sources(**kwargs)
        items.extend(resp.get("dataSourceSummaries", []))
        next_token = resp.get("nextToken")

        if not next_token:
            break

    return items


def _get_data_source(knowledge_base_id: str, data_source_id: str) -> dict:
    resp = bedrock_agent.get_data_source(
        knowledgeBaseId=knowledge_base_id,
        dataSourceId=data_source_id,
    )
    return resp["dataSource"]


def _list_all_ingestion_jobs(knowledge_base_id: str, data_source_id: str) -> list[dict]:
    items = []
    next_token = None

    while True:
        kwargs = {
            "knowledgeBaseId": knowledge_base_id,
            "dataSourceId": data_source_id,
            "maxResults": 100,
        }
        if next_token:
            kwargs["nextToken"] = next_token

        resp = bedrock_agent.list_ingestion_jobs(**kwargs)
        items.extend(resp.get("ingestionJobSummaries", []))
        next_token = resp.get("nextToken")

        if not next_token:
            break

    return items


def _sort_jobs_latest_first(jobs: list[dict]) -> list[dict]:
    return sorted(
        jobs,
        key=lambda j: j.get("updatedAt") or j.get("startedAt") or j.get("createdAt"),
        reverse=True,
    )


def _get_latest_ingestion_job(knowledge_base_id: str, data_source_id: str) -> dict | None:
    jobs = _list_all_ingestion_jobs(knowledge_base_id, data_source_id)
    if not jobs:
        return None
    return _sort_jobs_latest_first(jobs)[0]


def _is_web_data_source(data_source: dict) -> bool:
    return data_source.get("dataSourceConfiguration", {}).get("type") == "WEB"


def _get_seed_urls(data_source: dict) -> list[str]:
    seed_url_objs = (
        data_source.get("dataSourceConfiguration", {})
        .get("webConfiguration", {})
        .get("sourceConfiguration", {})
        .get("urlConfiguration", {})
        .get("seedUrls", [])
    )
    return [x.get("url") for x in seed_url_objs if x.get("url")]


def _get_max_pages(data_source: dict) -> int:
    return (
        data_source.get("dataSourceConfiguration", {})
        .get("webConfiguration", {})
        .get("crawlerConfiguration", {})
        .get("crawlerLimits", {})
        .get("maxPages", 25000)
    )


def _latest_failure_reasons(latest_job: dict | None) -> list[str]:
    if not latest_job:
        return []
    return latest_job.get("failureReasons", []) or []


def _looks_like_capacity_failure(failure_reasons: list[str]) -> bool:
    combined = " ".join(failure_reasons).lower()
    keywords = [
        "maxpages",
        "max pages",
        "25,000",
        "25000",
        "page limit",
        "crawl limit",
        "exceeded",
        "too many pages",
    ]
    return any(k in combined for k in keywords)


def _get_documents_scanned(latest_job: dict | None) -> int:
    if not latest_job:
        return 0
    stats = latest_job.get("statistics", {}) or {}
    return stats.get("numberOfDocumentsScanned", 0) or 0


def _classify_data_source(data_source: dict, latest_job: dict | None) -> dict:
    data_source_id = data_source["dataSourceId"]
    seed_urls = _get_seed_urls(data_source)
    max_pages = _get_max_pages(data_source)
    scanned = _get_documents_scanned(latest_job)
    status = latest_job.get("status") if latest_job else None
    failure_reasons = _latest_failure_reasons(latest_job)

    if status in SYNCING_STATUSES:
        state = "syncing"
    elif status in FAILED_STATUSES:
        state = "full" if _looks_like_capacity_failure(failure_reasons) else "error"
    elif status in SUCCESS_STATUSES:
        ratio = (scanned / max_pages) if max_pages else 0
        if ratio >= FULL_THRESHOLD:
            state = "full"
        elif ratio >= NEAR_CAPACITY_THRESHOLD:
            state = "near_capacity"
        else:
            state = "available"
    else:
        # no ingestion history yet or unknown state
        ratio = (scanned / max_pages) if max_pages else 0
        if ratio >= FULL_THRESHOLD:
            state = "full"
        elif ratio >= NEAR_CAPACITY_THRESHOLD:
            state = "near_capacity"
        else:
            state = "available"

    return {
        "data_source_id": data_source_id,
        "name": data_source.get("name"),
        "state": state,
        "seed_urls": seed_urls,
        "max_pages": max_pages,
        "documents_scanned": scanned,
        "headroom_ratio": 1 - ((scanned / max_pages) if max_pages else 0),
        "latest_ingestion_job": latest_job,
        "failure_reasons": failure_reasons,
        "data_source": data_source,
    }


def _select_best_available(classified: list[dict]) -> dict | None:
    candidates = [x for x in classified if x["state"] == "available"]
    if not candidates:
        return None

    # prefer the crawler with the most headroom.
    return sorted(candidates, key=lambda x: x["headroom_ratio"], reverse=True)[0]


def _all_web_crawlers_syncing(classified: list[dict]) -> bool:
    if not classified:
        return False
    return all(x["state"] == "syncing" for x in classified)


def _build_updated_web_config(data_source: dict, new_url: str, include_patterns: list[str], exclude_patterns: list[str]) -> dict:
    config = data_source["dataSourceConfiguration"]
    web_config = config["webConfiguration"]
    crawler_config = web_config["crawlerConfiguration"]
    source_config = web_config["sourceConfiguration"]

    existing_seed_urls = (
        source_config.get("urlConfiguration", {}).get("seedUrls", [])
    )
    existing_urls = [x["url"] for x in existing_seed_urls if "url" in x]

    if new_url not in existing_urls:
        existing_seed_urls.append({"url": new_url})

    updated_crawler_config = dict(crawler_config)

    # only include filters when non-empty
    effective_includes = include_patterns if include_patterns else crawler_config.get("inclusionFilters")
    effective_excludes = exclude_patterns if exclude_patterns else crawler_config.get("exclusionFilters")

    if effective_includes:
        updated_crawler_config["inclusionFilters"] = effective_includes
    else:
        updated_crawler_config.pop("inclusionFilters", None)

    if effective_excludes:
        updated_crawler_config["exclusionFilters"] = effective_excludes
    else:
        updated_crawler_config.pop("exclusionFilters", None)

    user_agent_header = updated_crawler_config.get("userAgentHeader")
    if user_agent_header and len(user_agent_header) < 61:
        updated_crawler_config["userAgentHeader"] = (
            "Mozilla/5.0 (compatible; SpecExKnowledgeBaseCrawler/1.0; +https://example.com/bot)"
        )

    updated_source_config = {
        **source_config,
        "urlConfiguration": {
            "seedUrls": existing_seed_urls
        }
    }

    return {
        "type": "WEB",
        "webConfiguration": {
            "crawlerConfiguration": updated_crawler_config,
            "sourceConfiguration": updated_source_config,
        },
    }


def _update_existing_web_data_source(data_source: dict, knowledge_base_id: str, new_url: str, include_patterns: list[str], exclude_patterns: list[str]) -> dict:
    updated_data_source_config = _build_updated_web_config(
        data_source=data_source,
        new_url=new_url,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
    )

    kwargs = {
        "knowledgeBaseId": knowledge_base_id,
        "dataSourceId": data_source["dataSourceId"],
        "name": data_source["name"],
        "dataSourceConfiguration": updated_data_source_config,
        "vectorIngestionConfiguration": data_source["vectorIngestionConfiguration"],
    }

    if data_source.get("description"):
        kwargs["description"] = data_source["description"]

    if data_source.get("dataDeletionPolicy"):
        kwargs["dataDeletionPolicy"] = data_source["dataDeletionPolicy"]

    if data_source.get("serverSideEncryptionConfiguration"):
        kwargs["serverSideEncryptionConfiguration"] = data_source["serverSideEncryptionConfiguration"]

    logger.info(
        "Updating data source %s with crawlerConfiguration=%s",
        data_source["dataSourceId"],
        json.dumps(updated_data_source_config["webConfiguration"]["crawlerConfiguration"])
    )

    resp = bedrock_agent.update_data_source(**kwargs)
    return resp["dataSource"]


def _build_new_web_data_source_payload(template_data_source: dict, new_url: str, include_patterns: list[str], exclude_patterns: list[str]) -> dict:
    template_config = template_data_source["dataSourceConfiguration"]
    template_web = template_config["webConfiguration"]
    template_crawler = template_web["crawlerConfiguration"]

    crawler_config = dict(template_crawler)

    effective_includes = include_patterns if include_patterns else template_crawler.get("inclusionFilters")
    effective_excludes = exclude_patterns if exclude_patterns else template_crawler.get("exclusionFilters")

    if effective_includes:
        crawler_config["inclusionFilters"] = effective_includes
    else:
        crawler_config.pop("inclusionFilters", None)

    if effective_excludes:
        crawler_config["exclusionFilters"] = effective_excludes
    else:
        crawler_config.pop("exclusionFilters", None)

    user_agent_header = crawler_config.get("userAgentHeader")
    if user_agent_header and len(user_agent_header) < 61:
        crawler_config["userAgentHeader"] = (
            "Mozilla/5.0 (compatible; SpecExKnowledgeBaseCrawler/1.0; +https://example.com/bot)"
        )

    return {
        "name": f"web-crawler-{uuid4().hex[:8]}",
        "dataSourceConfiguration": {
            "type": "WEB",
            "webConfiguration": {
                "crawlerConfiguration": crawler_config,
                "sourceConfiguration": {
                    "urlConfiguration": {
                        "seedUrls": [{"url": new_url}]
                    }
                },
            },
        },
        "vectorIngestionConfiguration": template_data_source["vectorIngestionConfiguration"],
    }


def _create_new_web_data_source(template_data_source: dict, knowledge_base_id: str, new_url: str, include_patterns: list[str], exclude_patterns: list[str]) -> dict:
    payload = _build_new_web_data_source_payload(
        template_data_source=template_data_source,
        new_url=new_url,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
    )

    resp = bedrock_agent.create_data_source(
        knowledgeBaseId=knowledge_base_id,
        name=payload["name"],
        dataSourceConfiguration=payload["dataSourceConfiguration"],
        vectorIngestionConfiguration=payload["vectorIngestionConfiguration"],
        description=f"Auto-created web crawler for {new_url}",
    )
    return resp["dataSource"]


def _start_ingestion(knowledge_base_id: str, data_source_id: str) -> dict:
    resp = bedrock_agent.start_ingestion_job(
        knowledgeBaseId=knowledge_base_id,
        dataSourceId=data_source_id,
        description="Triggered by admin Add Web URL",
    )
    return resp["ingestionJob"]

def _get_user_id_by_email(connection, email: str) -> str | None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id
            FROM users
            WHERE email = %s
            LIMIT 1
            """,
            (email,),
        )
        row = cursor.fetchone()
        return str(row[0]) if row else None


def _upsert_data_source_row(
    connection,
    *,
    bedrock_data_source_id: str,
    name: str,
    data_source_type: str,
    include_patterns: list[str],
    exclude_patterns: list[str],
    created_by_user_id: str,
    metadata: dict,
) -> str:
    with connection.cursor() as cursor:
        # try to find existing website URL
        cursor.execute(
            """
            SELECT id
            FROM data_sources
            WHERE metadata->>'bedrock_data_source_id' = %s
            LIMIT 1
            """,
            (bedrock_data_source_id,),
        )
        existing = cursor.fetchone()

        if existing:
            data_source_row_id = str(existing[0])
            cursor.execute(
                """
                UPDATE data_sources
                SET
                    name = %s,
                    type = %s::data_source_type,
                    include_patterns = %s,
                    exclude_patterns = %s,
                    metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                WHERE id = %s::uuid
                """,
                (
                    name,
                    data_source_type,
                    include_patterns if include_patterns else None,
                    exclude_patterns if exclude_patterns else None,
                    json.dumps(metadata),
                    data_source_row_id,
                ),
            )
            return data_source_row_id

        cursor.execute(
            """
            INSERT INTO data_sources (
                name,
                type,
                include_patterns,
                exclude_patterns,
                created_by,
                metadata
            )
            VALUES (%s, %s::data_source_type, %s, %s, %s::uuid, %s::jsonb)
            RETURNING id
            """,
            (
                name,
                data_source_type,
                include_patterns if include_patterns else None,
                exclude_patterns if exclude_patterns else None,
                created_by_user_id,
                json.dumps(metadata),
            ),
        )
        inserted = cursor.fetchone()
        return str(inserted[0])


def _insert_ingestion_run_row(
    connection,
    *,
    data_source_row_id: str,
    bedrock_ingestion_job_id: str,
) -> str:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ingestion_runs (
                data_source_id,
                status,
                error_message,
                metadata
            )
            VALUES (%s::uuid, %s::ingestion_status, NULL, %s::jsonb)
            RETURNING id
            """,
            (
                data_source_row_id,
                "running",
                json.dumps({
                    "bedrock_ingestion_job_id": bedrock_ingestion_job_id
                }),
            ),
        )
        row = cursor.fetchone()
        return str(row[0])

def _create_ingestion_polling_schedule(
    *,
    knowledge_base_id: str,
    bedrock_data_source_id: str,
    bedrock_ingestion_job_id: str,
    db_ingestion_run_id: str,
) -> str:
    schedule_name = f"kb-ingestion-{db_ingestion_run_id}"

    payload = {
        "task": "poll_ingestion_run",
        "knowledge_base_id": knowledge_base_id,
        "bedrock_data_source_id": bedrock_data_source_id,
        "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
        "db_ingestion_run_id": db_ingestion_run_id,
        "schedule_name": schedule_name,
    }

    scheduler_client.create_schedule(
        Name=schedule_name,
        GroupName="default",
        ScheduleExpression="rate(30 minutes)",
        FlexibleTimeWindow={"Mode": "OFF"},
        State="ENABLED",
        Target={
            "Arn": SCHEDULER_TARGET_ARN,
            "RoleArn": SCHEDULER_ROLE_ARN,
            "Input": json.dumps(payload),
        },
        Description=f"Poll Bedrock ingestion job {bedrock_ingestion_job_id} for run {db_ingestion_run_id}",
    )

    return schedule_name

def _update_ingestion_run_schedule_name(connection, *, ingestion_run_row_id: str, schedule_name: str):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ingestion_runs
            SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
            WHERE id = %s::uuid
            """,
            (
                json.dumps({"scheduler_name": schedule_name}),
                ingestion_run_row_id,
            ),
        )

def add_website(event, body, connection, kb_id):
    name = body.get("name")
    include_patterns = body.get("include_patterns", [])
    exclude_patterns = body.get("exclude_patterns", [])
    created_by = body.get("created_by")

    if not name:
        return _response(event, 400, {"error": "Missing name of the website"})

    if not created_by:
        return _response(event, 400, {"error": "Missing admin who is trying to add this website to knowledge base"})

    if not isinstance(include_patterns, list):
        return _response(event, 400, {"error": "include_patterns must be an array"})

    if not isinstance(exclude_patterns, list):
        return _response(event, 400, {"error": "exclude_patterns must be an array"})

    logger.info(
        "Received add website request: name=%s include_patterns=%s exclude_patterns=%s created_by=%s",
        name,
        include_patterns,
        exclude_patterns,
        created_by,
    )

    try:
        all_data_sources = _list_all_data_sources(kb_id)

        web_crawlers = []
        for summary in all_data_sources:
            data_source_id = summary["dataSourceId"]
            data_source = _get_data_source(kb_id, data_source_id)
            if _is_web_data_source(data_source):
                web_crawlers.append(data_source)

        classified = []
        for data_source in web_crawlers:
            latest_job = _get_latest_ingestion_job(kb_id, data_source["dataSourceId"])
            classified.append(_classify_data_source(data_source, latest_job))

        # prevent duplicates across all web crawler seed URLs
        for item in classified:
            if name in item["seed_urls"]:
                return _response(
                    event,
                    200,
                    {
                        "message": "URL already exists in a web crawler data source.",
                        "name": name,
                        "created_by": created_by,
                        "data_source_id": item["data_source_id"],
                        "state": item["state"],
                    },
                )

        selected = _select_best_available(classified)

        if selected:
            updated_data_source = _update_existing_web_data_source(
                data_source=selected["data_source"],
                knowledge_base_id=kb_id,
                new_url=name,
                include_patterns=include_patterns,
                exclude_patterns=exclude_patterns,
            )
            ingestion_job = _start_ingestion(kb_id, updated_data_source["dataSourceId"])

            created_by_user_id = _get_user_id_by_email(connection, created_by)
            if not created_by_user_id:
                return _response(event, 400, {"error": "Admin user not found in database"})

            try:
                db_metadata = {
                    "bedrock_data_source_id": updated_data_source["dataSourceId"],
                    "bedrock_data_source_name": updated_data_source["name"],
                    "seed_url": name,
                    "source": "bedrock_web_crawler",
                    "action": "updated_existing_data_source",
                }

                data_source_row_id = _upsert_data_source_row(
                    connection,
                    bedrock_data_source_id=updated_data_source["dataSourceId"],
                    name=name,
                    data_source_type="website",
                    include_patterns=include_patterns,
                    exclude_patterns=exclude_patterns,
                    created_by_user_id=created_by_user_id,
                    metadata=db_metadata,
                )

                ingestion_run_row_id = _insert_ingestion_run_row(
                    connection,
                    data_source_row_id=data_source_row_id,
                    bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
                )

                connection.commit()

                schedule_name = _create_ingestion_polling_schedule(
                    knowledge_base_id=kb_id,
                    bedrock_data_source_id=updated_data_source["dataSourceId"],
                    bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
                    db_ingestion_run_id=ingestion_run_row_id,
                )

                _update_ingestion_run_schedule_name(
                    connection=connection,
                    ingestion_run_row_id=ingestion_run_row_id,
                    schedule_name=schedule_name
                )
                connection.commit()
            except Exception:
                connection.rollback()
                raise

            return _response(
                event,
                200,
                {
                    "message": "Website URL added to existing web crawler data source and ingestion started.",
                    "action": "updated_existing_data_source",
                    "name": name,
                    "created_by": created_by,
                    "data_source_id": updated_data_source["dataSourceId"],
                    "data_source_name": updated_data_source["name"],
                    "ingestion_job_id": ingestion_job["ingestionJobId"],
                    "db_data_source_id": data_source_row_id,
                    "db_ingestion_run_id": ingestion_run_row_id,
                    "schedule_name": schedule_name,
                },
            )

        web_count = len(web_crawlers)

        if web_count < MAX_WEB_DATA_SOURCES:
            if not web_crawlers:
                return _response(
                    event,
                    500,
                    {
                        "error": "No existing web crawler template found. At least one web crawler data source must already exist."
                    },
                )

            template_data_source = web_crawlers[0]
            created_data_source = _create_new_web_data_source(
                template_data_source=template_data_source,
                knowledge_base_id=kb_id,
                new_url=name,
                include_patterns=include_patterns,
                exclude_patterns=exclude_patterns,
            )
            ingestion_job = _start_ingestion(kb_id, created_data_source["dataSourceId"])

            created_by_user_id = _get_user_id_by_email(connection, created_by)
            if not created_by_user_id:
                return _response(event, 400, {"error": "Admin user not found in database"})

            try:
                db_metadata = {
                    "bedrock_data_source_id": created_data_source["dataSourceId"],
                    "bedrock_data_source_name": created_data_source["name"],
                    "seed_url": name,
                    "source": "bedrock_web_crawler",
                    "action": "created_new_data_source",
                }

                data_source_row_id = _upsert_data_source_row(
                    connection,
                    bedrock_data_source_id=created_data_source["dataSourceId"],
                    name=name,
                    data_source_type="website",
                    include_patterns=include_patterns,
                    exclude_patterns=exclude_patterns,
                    created_by_user_id=created_by_user_id,
                    metadata=db_metadata,
                )

                ingestion_run_row_id = _insert_ingestion_run_row(
                    connection,
                    data_source_row_id=data_source_row_id,
                    bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
                )

                connection.commit()

                schedule_name = _create_ingestion_polling_schedule(
                    knowledge_base_id=kb_id,
                    bedrock_data_source_id=created_data_source["dataSourceId"],
                    bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
                    db_ingestion_run_id=ingestion_run_row_id,
                )

                _update_ingestion_run_schedule_name(
                    connection=connection,
                    ingestion_run_row_id=ingestion_run_row_id,
                    schedule_name=schedule_name
                )
                connection.commit()
            except Exception:
                connection.rollback()
                raise

            return _response(
                event,
                200,
                {
                    "message": "Website URL added by creating a new web crawler data source and starting ingestion.",
                    "action": "created_new_data_source",
                    "name": name,
                    "created_by": created_by,
                    "data_source_id": created_data_source["dataSourceId"],
                    "data_source_name": created_data_source["name"],
                    "ingestion_job_id": ingestion_job["ingestionJobId"],
                    "db_data_source_id": data_source_row_id,
                    "db_ingestion_run_id": ingestion_run_row_id,
                    "schedule_name": schedule_name,
                },
            )

        if _all_web_crawlers_syncing(classified):
            return _response(
                event,
                409,
                {
                    "error": "All web crawler data sources are currently syncing. Please wait for current ingestions to finish before adding more URLs."
                },
            )

        return _response(
            event,
            409,
            {
                "error": "The knowledge base is at capacity for website crawling. No additional web crawler data sources are available."
            },
        )

    except Exception as e:
        logger.error("Failed to add website URL to Bedrock knowledge base: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Failed to add website URL to knowledge base"})