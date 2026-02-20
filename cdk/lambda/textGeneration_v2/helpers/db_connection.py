
import os
import boto3
import json
import psycopg2
import logging

logger = logging.getLogger(__name__)

def get_secret():
    secret_name = os.environ.get("SM_DB_CREDENTIALS")
    region_name = os.environ.get("REGION", "ca-central-1")

    if not secret_name:
        raise ValueError("SM_DB_CREDENTIALS environment variable not set")

    session = boto3.session.Session()
    client = session.client(
        service_name='secretsmanager',
        region_name=region_name
    )

    try:
        get_secret_value_response = client.get_secret_value(
            SecretId=secret_name
        )
    except Exception as e:
        logger.error(f"Error retrieving secret {secret_name}: {e}")
        raise e

    if 'SecretString' in get_secret_value_response:
        secret = get_secret_value_response['SecretString']
        return json.loads(secret)
    else:
        raise ValueError("SecretString not found in secret response")

def get_db_connection():
    try:
        secret = get_secret()
        rds_proxy_endpoint = os.environ.get("RDS_PROXY_ENDPOINT")
        
        # If proxy endpoint is not set, fallback to secret's host (direct connection, might fail if in private subnet without VPC config?)
        host = rds_proxy_endpoint if rds_proxy_endpoint else secret.get('host')
        
        conn = psycopg2.connect(
            host=host,
            user=secret.get('username'),
            password=secret.get('password'),
            dbname=secret.get('dbname'),
            port=secret.get('port', 5432)
        )
        return conn
    except Exception as e:
        logger.error(f"Failed to connect to database: {e}")
        raise e
