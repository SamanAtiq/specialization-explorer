import logging
import time
from typing import Dict, Optional

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Global cache
_SYSTEM_MESSAGES_CACHE: Optional[Dict[str, str]] = None
_LAST_CACHE_UPDATE: float = 0
_CACHE_TTL: int = 300  # 5 minutes

def load_system_messages(db_connection) -> Dict[str, str]:
    """
    Fetches active system messages from the database.
    Uses a simple global cache with TTL.
    """
    global _SYSTEM_MESSAGES_CACHE, _LAST_CACHE_UPDATE
    
    current_time = time.time()
    
    if _SYSTEM_MESSAGES_CACHE is not None and (current_time - _LAST_CACHE_UPDATE) < _CACHE_TTL:
        return _SYSTEM_MESSAGES_CACHE
    
    logger.info("Refreshing system messages from DB")
    
    messages = {}
    try:
        with db_connection.cursor() as cur:
            # Fetch the active version of each message type
            # We assume there's only one active version per type or we take the latest
            cur.execute(
                """
                SELECT type, content 
                FROM system_messages 
                WHERE is_active = TRUE
                """
            )
            rows = cur.fetchall()
            
            for msg_type, content in rows:
                messages[msg_type] = content
                
        _SYSTEM_MESSAGES_CACHE = messages
        _LAST_CACHE_UPDATE = current_time
        logger.info(f"Loaded {len(messages)} system messages")
        
    except Exception as e:
        logger.error(f"Failed to load system messages: {e}")
        # If cache exists (even expired), return it as fallback
        if _SYSTEM_MESSAGES_CACHE:
            logger.warning("Returning expired cache due to DB error")
            return _SYSTEM_MESSAGES_CACHE
        # Otherwise re-raise or return empty (which might break things, but better than crashing?)
        # For now, let's return empty and let the caller handle it or fail
        return {}

    return messages
