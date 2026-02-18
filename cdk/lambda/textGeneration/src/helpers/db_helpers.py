import json
import logging
import uuid
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

def get_exchange_count(chat_session_id: str, db_connection) -> int:
    """
    Counts the number of exchanges (User + AI pairs) in a session.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM chat_messages WHERE chat_session_id = %s", (chat_session_id,))
            msg_count = cur.fetchone()[0]
            # Each exchange is roughly 2 messages (User + AI)
            exchange_count = msg_count // 2
            return exchange_count
    except Exception as e:
        logger.error(f"Could not count history: {e}")
        return 0

def fetch_recent_messages(
    db_connection,
    chat_session_id: str,
    limit: int = 20
) -> List[Dict[str, Any]]:
    """
    Fetch recent messages for a chat session (oldest->newest).
    """
    with db_connection.cursor() as cur:
        cur.execute(
            """
            SELECT sender, content, created_at
            FROM chat_messages
            WHERE chat_session_id = %s
            ORDER BY created_at ASC
            LIMIT %s
            """,
            (chat_session_id, limit)
        )
        rows = cur.fetchall()

    messages = []
    for sender, content, created_at in rows:
        messages.append({
            "sender": sender,          # 'user' or 'AI'
            "content": content,
            "created_at": created_at.isoformat() if created_at else None
        })
    return messages

def ensure_user_exists(db_connection, user_id: str) -> None:
    with db_connection.cursor() as cur:
        # We use a dummy email for now as we don't have it from the token in all cases yet
        # Adjust if we have real email
        dummy_email = f"user_{user_id[:8]}@example.com" 
        cur.execute(
            """
            INSERT INTO users (id, email, display_name, role, created_at, last_seen_at, tokens_used, token_window_started_at, metadata)
            VALUES (%s, %s, %s, %s, NOW(), NOW(), 0, NOW(), %s::jsonb)
            ON CONFLICT (id) DO NOTHING
            """,
            (user_id, dummy_email, "Student", "student", "{}")
        )

def ensure_session_exists(db_connection, chat_session_id: str, user_id: Optional[str]) -> None:
    if not user_id:
        return
    ensure_user_exists(db_connection, user_id)
    with db_connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO chat_sessions (id, user_id, title, created_at, last_active_at)
            VALUES (%s, %s, %s, NOW(), NOW())
            ON CONFLICT (id) DO NOTHING
            """,
            (chat_session_id, user_id, "New Session")
        )

def insert_message(
    db_connection,
    chat_session_id: str,
    sender: str,
    content: str,
    sources: Optional[List[Dict[str, Any]]] = None
) -> str:
    message_id = str(uuid.uuid4())
    sources_json = json.dumps(sources or [])
    with db_connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO chat_messages (id, chat_session_id, sender, content, sources, created_at)
            VALUES (%s, %s, %s, %s, %s::jsonb, NOW())
            """,
            (message_id, chat_session_id, sender, content, sources_json)
        )
    return message_id

def touch_session(db_connection, chat_session_id: str) -> None:
    with db_connection.cursor() as cur:
        cur.execute("UPDATE chat_sessions SET last_active_at = NOW() WHERE id = %s", (chat_session_id,))

def get_current_prompt(
    chat_session_id: str, 
    db_connection, 
    system_messages: Dict[str, str],
    min_exchanges_before_suggest: int = 4
) -> Tuple[str, int]:
    """
    Determines the current conversation phase and constructs the system prompt.
    Returns (full_prompt, retrieval_count)
    """
    # 1. Auto-calculate exchange count
    exchange_count = get_exchange_count(chat_session_id, db_connection)
    logger.info(f"Calculated Exchange Count: {exchange_count}")

    # 2. Set mode based on history
    if exchange_count < min_exchanges_before_suggest:
        phase_instructions = system_messages.get("detective_phase_prompt", "")
        retrieval_count = 1 
    else:
        phase_instructions = system_messages.get("suggestion_phase_prompt", "")
        retrieval_count = 5

    # 3. Construct full prompt
    # Expected keys in system_messages: guardrails, system_role, system_checklist, system_instructions
    
    full_prompt = f"""
{system_messages.get('guardrails', '')}

{system_messages.get('system_role', '')}

{phase_instructions}

{system_messages.get('system_checklist', '')}

{system_messages.get('system_instructions', '')}
""".strip()

    return full_prompt, retrieval_count
