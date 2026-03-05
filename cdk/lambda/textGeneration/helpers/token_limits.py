import logging
from datetime import datetime, timezone, timedelta
import helpers.config as config

logger = logging.getLogger(__name__)

def estimate_tokens(text: str) -> int:
    """
    Rough estimation of tokens based on word count.
    Used for cost/limit tracking without exact tokenizer overhead.
    """
    if not text:
        return 0
    return int(len(text.split()) * 1.33)

def check_limit(user_id: str, db_connection) -> tuple[bool, dict]:
    """
    Checks if a user has exceeded their daily token limit.
    Always reads directly from the DB.
    Does NOT write to the DB.
    
    Returns:
        (is_under_limit: bool, usage_info: dict)
    """
    now_utc = datetime.now(timezone.utc)
    
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                "SELECT tokens_used, token_window_started_at FROM users WHERE id = %s",
                (user_id,)
            )
            row = cur.fetchone()
            if not row:
                usage_info = {
                    "tokens_used": 0, 
                    "limit": config.DAILY_TOKEN_LIMIT, 
                    "remaining": config.DAILY_TOKEN_LIMIT,
                    "reset_at": (now_utc + timedelta(hours=24)).isoformat()
                }
                return True, usage_info
                
            tokens_used = row[0] or 0
            window_start = row[1]
            
            # Make window start timezone aware if it isn't (psycopg2 returns aware if DB type is timestamptz)
            if window_start.tzinfo is None:
                window_start = window_start.replace(tzinfo=timezone.utc)
                
            # Check 24-hour rollover
            if now_utc - window_start > timedelta(hours=24):
                tokens_used = 0
                window_start = now_utc
                
            reset_at = (window_start + timedelta(hours=24)).isoformat()
                
            usage_info = {
                "tokens_used": tokens_used,
                "limit": config.DAILY_TOKEN_LIMIT,
                "remaining": max(0, config.DAILY_TOKEN_LIMIT - tokens_used),
                "reset_at": reset_at
            }
            
            return tokens_used < config.DAILY_TOKEN_LIMIT, usage_info
            
    except Exception as e:
        logger.error(f"Error checking token limit DB: {e}")
        # Fail open if DB read fails but everything else is fine
        usage_info = {
            "tokens_used": 0, 
            "limit": config.DAILY_TOKEN_LIMIT, 
            "remaining": config.DAILY_TOKEN_LIMIT,
            "reset_at": (now_utc + timedelta(hours=24)).isoformat()
        }
        return True, usage_info

def record_usage(user_id: str, response_text: str, db_connection) -> dict:
    """
    Calculates consumed tokens and atomically increments the user's DB counter,
    resetting the window if 24 hours have passed.
    
    Returns:
        usage_info: dict with token stats
    """
    tokens_generated = estimate_tokens(response_text)
    now_utc = datetime.now(timezone.utc)
    
    if tokens_generated == 0:
        return {
            "tokens_used": 0, 
            "limit": config.DAILY_TOKEN_LIMIT, 
            "remaining": config.DAILY_TOKEN_LIMIT,
            "reset_at": (now_utc + timedelta(hours=24)).isoformat()
        }
    
    try:
        with db_connection.cursor() as cur:
            # Atomic update that handles 24h reset
            cur.execute(
                """
                UPDATE users 
                SET 
                    tokens_used = CASE 
                        WHEN token_window_started_at < NOW() - INTERVAL '24 hours' THEN %s 
                        ELSE tokens_used + %s 
                    END,
                    token_window_started_at = CASE 
                        WHEN token_window_started_at < NOW() - INTERVAL '24 hours' THEN NOW() 
                        ELSE token_window_started_at 
                    END
                WHERE id = %s
                RETURNING tokens_used, token_window_started_at
                """,
                (tokens_generated, tokens_generated, user_id)
            )
            row = cur.fetchone()
            if not row:
                return {
                    "tokens_used": 0, 
                    "limit": config.DAILY_TOKEN_LIMIT, 
                    "remaining": config.DAILY_TOKEN_LIMIT,
                    "reset_at": (now_utc + timedelta(hours=24)).isoformat()
                }
                
            tokens_used = row[0]
            window_start = row[1]
            db_connection.commit()
            
            if window_start.tzinfo is None:
                window_start = window_start.replace(tzinfo=timezone.utc)
            reset_at = (window_start + timedelta(hours=24)).isoformat()
                
            return {
                "tokens_used": tokens_used,
                "limit": config.DAILY_TOKEN_LIMIT,
                "remaining": max(0, config.DAILY_TOKEN_LIMIT - tokens_used),
                "reset_at": reset_at
            }
            
    except Exception as e:
        logger.error(f"Error recording token usage: {e}")
        db_connection.rollback()
        return {
            "tokens_used": 0, 
            "limit": config.DAILY_TOKEN_LIMIT, 
            "remaining": 0,
            "reset_at": (now_utc + timedelta(hours=24)).isoformat()
        }
