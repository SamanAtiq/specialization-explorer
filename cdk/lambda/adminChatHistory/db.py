import os
import json
import logging
import psycopg2
from psycopg2.extras import RealDictCursor
import boto3

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Fetch Secret Manager
sm_client = boto3.client('secretsmanager', region_name=os.environ.get('REGION', 'ca-central-1'))

def get_db_credentials():
    secret_name = os.environ.get('SM_DB_CREDENTIALS')
    if not secret_name:
        raise ValueError("SM_DB_CREDENTIALS environment variable not set")
    try:
        response = sm_client.get_secret_value(SecretId=secret_name)
        return json.loads(response['SecretString'])
    except Exception as e:
        logger.error(f"Error fetching DB credentials from SM: {e}")
        raise

def get_db_connection():
    creds = get_db_credentials()
    host = os.environ.get('RDS_PROXY_ENDPOINT', creds.get('host'))
    
    conn = psycopg2.connect(
        host=host,
        database=creds.get('dbname', 'postgres'),
        user=creds.get('username'),
        password=creds.get('password'),
        port=creds.get('port', 5432),
        connect_timeout=10
    )
    return conn
