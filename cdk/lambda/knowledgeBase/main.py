import os
import json
import boto3
import logging
import psycopg2

from helpers.add_website import add_website

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
# TODO: will be an evironment variable passed in from API stack with Knowledge Base stack is completed
KB_SECRET_NAME = "SpecEx/KnowledgeBase/Id/playground"
REGION = os.environ["REGION"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]

# Cached resources
connection = None
secret_cache = {}

# AWS Clients
secrets_manager_client = boto3.client("secretsmanager", region_name=REGION)

def _get_secret(secret_name: str, expect_json: bool = True):
    if secret_name in secret_cache:
        return secret_cache[secret_name]

    try:
        response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
        value = json.loads(response) if expect_json else response
        secret_cache[secret_name] = value
        return value
    except json.JSONDecodeError as e:
        logger.error(f"Failed to decode JSON for secret '{secret_name}': {e}")
        raise ValueError(f"Secret '{secret_name}' is not properly formatted as JSON.")
    except Exception as e:
        logger.error(f"Error fetching secret '{secret_name}': {e}")
        raise

def _connect_to_db():
    global connection
    if connection is None or connection.closed:
        try:
            db_secret = _get_secret(DB_SECRET_NAME, expect_json=True)
            connection_params = {
                'dbname': db_secret["dbname"],
                'user': db_secret["username"],
                'password': db_secret["password"],
                'host': RDS_PROXY_ENDPOINT,
                'port': db_secret["port"]
            }
            connection_string = " ".join([f"{key}={value}" for key, value in connection_params.items()])
            connection = psycopg2.connect(connection_string)
            logger.info("Connected to the database!")
        except Exception as e:
            logger.error(f"Failed to connect to database: {e}")
            if connection:
                connection.rollback()
                connection.close()
            raise
    return connection

def _response(status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "*",
        },
        "body": json.dumps(body),
    }


def _parse_body(event):
    body = {}
    raw_body = event.get("body")

    if not raw_body:
        return body

    try:
        if isinstance(raw_body, str):
            body = json.loads(raw_body)
        elif isinstance(raw_body, dict):
            body = raw_body
        else:
            raise ValueError("Unsupported body format")
    except Exception as e:
        logger.error("Failed to parse body: %s", e)
        raise ValueError("Invalid JSON body")

    return body


def handler(event, context=None):
    logger.info("Event: %s", json.dumps(event))

    try:
        method = event.get("httpMethod", "")
        resource = event.get("resource", "")
        path = event.get("path", "")

        try:
            body = _parse_body(event)
        except ValueError as e:
            return _response(400, {"error": str(e)})
        
        # connect to database
        try:
            connection = _connect_to_db()
        except Exception as e:
            logger.error(f"Error connecting to database: {e}")
            return {
                'statusCode': 500,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "*",
                },
                'body': json.dumps({"error": "Error connecting to database"})
            }
        
        # get knowledge base ID
        try:
            kb_id = _get_secret(KB_SECRET_NAME, expect_json=False)
        except Exception as e:
            logger.error(f"Error getting knowledge base ID: {e}")
            return {
                'statusCode': 500,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "*",
                },
                'body': json.dumps({"error": "Error getting knowledge base ID"})
            }

        # Route: POST /admin/data_sources/website
        if method == "POST" and (
            resource == "/admin/data_sources/website"
            or path.endswith("/admin/data_sources/website")
        ):
            return add_website(event=event, body=body, connection=connection, kb_id=kb_id)

        return _response(
            404,
            {
                "error": "Route not found",
                "method": method,
                "resource": resource,
                "path": path,
            },
        )

    except Exception as e:
        logger.error("Error: %s", e, exc_info=True)
        return _response(500, {"error": "Internal server error"})