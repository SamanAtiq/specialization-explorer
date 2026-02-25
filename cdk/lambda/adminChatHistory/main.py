import json
import logging
from db import get_db_connection
from crud import get_users, get_user_sessions, get_session_messages

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

def handler(event, context):
    try:
        http_method = event.get('httpMethod')
        path = event.get('path', '')
        
        # We only support GET methods for this handler
        if http_method != 'GET':
            return {
                'statusCode': 405,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Credentials': True
                },
                'body': json.dumps({'error': 'Method Not Allowed'})
            }
        
        query_params = event.get('queryStringParameters') or {}
        limit = int(query_params.get('limit', 50))
        offset = int(query_params.get('offset', 0))
        
        conn = get_db_connection()
        
        # Route: /admin/users
        # Route: /admin/users/{userId}/chat_sessions
        # Route: /admin/chat_sessions/{sessionId}/messages
        
        # Note: Depending on API Gateway configuration, the path might include the stage (e.g., /prod/admin/...)
        # We will parse based on standard segments.
        parts = [p for p in path.split('/') if p]
        
        # Remove stage if present, typically the first part if not "admin"
        if parts and parts[0] != 'admin':
            parts = parts[1:]
        
        if not parts or parts[0] != 'admin':
            return _respond_error(400, "Invalid path")
        
        path_remainder = parts[1:]
        
        response_data = None
        
        # /admin/users
        if len(path_remainder) == 1 and path_remainder[0] == 'users':
            response_data = get_users(conn, limit, offset)
            
        # /admin/users/{userId}/chat_sessions
        elif len(path_remainder) == 3 and path_remainder[0] == 'users' and path_remainder[2] == 'chat_sessions':
            user_id = path_remainder[1]
            response_data = get_user_sessions(conn, user_id, limit, offset)
            
        # /admin/chat_sessions/{sessionId}/messages
        elif len(path_remainder) == 3 and path_remainder[0] == 'chat_sessions' and path_remainder[2] == 'messages':
            session_id = path_remainder[1]
            response_data = get_session_messages(conn, session_id, limit, offset)
            
        else:
            return _respond_error(404, f"API Route not found for path: {path}")

        conn.close()

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': True
            },
            'body': json.dumps(response_data)
        }
    
    except Exception as e:
        logger.exception(f"Error processing request: {str(e)}")
        return _respond_error(500, "Internal Server Error")

def _respond_error(status_code, message):
    return {
        'statusCode': status_code,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': True
        },
        'body': json.dumps({'error': message})
    }
