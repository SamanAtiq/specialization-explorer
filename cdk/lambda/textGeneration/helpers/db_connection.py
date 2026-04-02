
import os
import boto3
import json
import psycopg2
import logging

logger = logging.getLogger(__name__)

# Environment variables
REGION = os.environ.get("REGION", "ca-central-1")
DB_SECRET_NAME = os.environ.get("SM_DB_CREDENTIALS")
RDS_PROXY_ENDPOINT = os.environ.get("RDS_PROXY_ENDPOINT")

# Cached resources
connection = None
secret_cache = {}

# AWS Clients
secrets_manager_client = boto3.client("secretsmanager", region_name=REGION)

def get_secret():

    if not DB_SECRET_NAME:
        raise ValueError("SM_DB_CREDENTIALS environment variable not set")

    if DB_SECRET_NAME in secret_cache:
        logger.info("Using cached database credentials")
        return secret_cache[DB_SECRET_NAME]

    try:
        get_secret_value_response = secrets_manager_client.get_secret_value(
            SecretId=DB_SECRET_NAME
        )
    except Exception as e:
        logger.error(f"Error retrieving secret {DB_SECRET_NAME}: {e}")
        raise e

    if 'SecretString' in get_secret_value_response:
        secret = get_secret_value_response['SecretString']
        secret_value = json.loads(secret)
        secret_cache[DB_SECRET_NAME] = secret_value
        return secret_value
    else:
        raise ValueError("SecretString not found in secret response")

def get_db_connection():
    global connection
    try:
        if connection is None or connection.closed:
            secret = get_secret()

            # If proxy endpoint is not set, fallback to secret's host (direct connection, might fail if in private subnet without VPC config?)
            host = RDS_PROXY_ENDPOINT if RDS_PROXY_ENDPOINT else secret.get('host')

            connection = psycopg2.connect(
                sslmode='require',
                host=host,
                user=secret.get('username'),
                password=secret.get('password'),
                dbname=secret.get('dbname'),
                port=secret.get('port', 5432)
            )
        return connection
    except Exception as e:
        logger.error(f"Failed to connect to database: {e}")
        raise e
