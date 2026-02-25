import logging
import json
from psycopg2.extras import RealDictCursor

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

def get_users(db_connection, limit=50, offset=0):
    try:
        with db_connection.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT id, email, display_name, role, created_at, last_seen_at
                FROM users
                ORDER BY last_seen_at DESC NULLS LAST
                LIMIT %s OFFSET %s
            """, (limit, offset))
            rows = cur.fetchall()
            
            # Convert datetime objects to ISO strings
            for row in rows:
                if row.get('created_at'):
                    row['created_at'] = row['created_at'].isoformat()
                if row.get('last_seen_at'):
                    row['last_seen_at'] = row['last_seen_at'].isoformat()
            
            return rows
    except Exception as e:
        logger.error(f"Error fetching users: {e}")
        raise

def get_user_sessions(db_connection, user_id, limit=50, offset=0):
    try:
        with db_connection.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT id, user_id, title, created_at, last_active_at, metadata
                FROM chat_sessions
                WHERE user_id = %s
                ORDER BY last_active_at DESC
                LIMIT %s OFFSET %s
            """, (user_id, limit, offset))
            rows = cur.fetchall()
            
            for row in rows:
                if row.get('created_at'):
                    row['created_at'] = row['created_at'].isoformat()
                if row.get('last_active_at'):
                    row['last_active_at'] = row['last_active_at'].isoformat()
            
            return rows
    except Exception as e:
        logger.error(f"Error fetching sessions for user {user_id}: {e}")
        raise

def get_session_messages(db_connection, chat_session_id, limit=200, offset=0):
    try:
        with db_connection.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT id, chat_session_id, sender, content, sources, created_at
                FROM chat_messages
                WHERE chat_session_id = %s
                ORDER BY created_at ASC
                LIMIT %s OFFSET %s
            """, (chat_session_id, limit, offset))
            rows = cur.fetchall()
            
            for row in rows:
                if row.get('created_at'):
                    row['created_at'] = row['created_at'].isoformat()
                # Sources is already JSON/jsonb, depending on psycopg2 it might be returned as dict or string
                # Ensure it's serializable if not already
                
            return rows
    except Exception as e:
        logger.error(f"Error fetching messages for session {chat_session_id}: {e}")
        raise
