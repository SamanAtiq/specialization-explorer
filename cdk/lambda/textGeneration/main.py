
import json
import logging
import os
import boto3
from helpers.chat import get_response
from helpers.db_connection import get_db_connection
import helpers.config as config

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    logger.info("Event: %s", json.dumps(event))
    
    body = {}
    if 'body' in event and event['body']:
        try:
            if isinstance(event['body'], str):
                body = json.loads(event['body'])
            else:
                body = event['body']
        except Exception as e:
            logger.error(f"Failed to parse body: {e}")
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Invalid JSON body'})
            }

    query = body.get('query')
    chat_session_id = body.get('chat_session_id')
    
    # Fallback to path parameters
    if not chat_session_id and 'pathParameters' in event and event['pathParameters']:
        chat_session_id = event['pathParameters'].get('chat_session_id') or event['pathParameters'].get('id')

    user_id = body.get('user_id')
    
    if not query or not chat_session_id:
        return {
            'statusCode': 400,
            'body': json.dumps({'error': 'Missing query or chat_session_id'})
        }

    conn = None
    try:
        conn = get_db_connection()
        conn.autocommit = False
        
        # Load dynamic configuration from DB
        config.load_config(conn)
        
        response_data = get_response(
            query=query,
            knowledge_base_id=config.KB_ID,
            model_arn=config.MODEL_ARN,
            bedrock_region=config.BEDROCK_REGION,
            chat_session_id=chat_session_id,
            user_id=user_id,
            db_connection=conn
        )
        
        # Format response to match API contract
        # Map sources_used -> sources
        response_body = {
            "response": response_data.get("response", ""),
            "sources": response_data.get("sources_used", []),
            "chat_session_id": response_data.get("sessionId")
        }
        
        # Send WebSocket response if connection_id is present
        request_context = event.get('requestContext', {})
        connection_id = request_context.get('connectionId')
        if connection_id:
            domain_name = request_context.get('domainName')
            stage = request_context.get('stage')
            if domain_name and stage:
                endpoint_url = f"https://{domain_name}/{stage}"
                try:
                    apigw_management = boto3.client('apigatewaymanagementapi', endpoint_url=endpoint_url)
                    
                    # 1. Send text chunk
                    chunk_msg = {
                        'type': 'chunk',
                        'content': response_body['response']
                    }
                    apigw_management.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps(chunk_msg)
                    )
                    
                    # 2. Send complete message with sources
                    complete_msg = {
                        'type': 'complete',
                        'sources': response_body['sources'],
                        'chat_session_id': response_body['chat_session_id']
                    }
                    apigw_management.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps(complete_msg)
                    )
                    
                    logger.info(f"Sent WebSocket responses (chunk+complete) to {connection_id}")
                except Exception as e:
                    logger.error(f"Failed to post to WebSocket connection: {e}")

        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Methods': '*'
            },
            'body': json.dumps(response_body)
        }
        
    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Methods': '*'
            },
            'body': json.dumps({'error': str(e)})
        }
    finally:
        if conn:
            conn.close()
