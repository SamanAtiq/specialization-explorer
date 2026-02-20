import json
import logging
import uuid
from typing import Any, Dict, List, Optional

import boto3

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


# -----------------------------
# DB helpers
# -----------------------------
def _fetch_recent_messages(
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


def _ensure_user_exists(db_connection, user_id: str) -> None:
    with db_connection.cursor() as cur:
        dummy_email = f"test_{user_id[:8]}@example.com"
        cur.execute(
            """
            INSERT INTO users (id, email, display_name, role, created_at, last_seen_at, tokens_used, token_window_started_at, metadata)
            VALUES (%s, %s, %s, %s, NOW(), NOW(), 0, NOW(), %s::jsonb)
            ON CONFLICT (id) DO NOTHING
            """,
            (user_id, dummy_email, "Test User", "student", "{}")
        )


def _ensure_session_exists(db_connection, chat_session_id: str, user_id: Optional[str]) -> None:
    if not user_id:
        return
    _ensure_user_exists(db_connection, user_id)
    with db_connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO chat_sessions (id, user_id, title, created_at, last_active_at)
            VALUES (%s, %s, %s, NOW(), NOW())
            ON CONFLICT (id) DO NOTHING
            """,
            (chat_session_id, user_id, "New Session")
        )


def _insert_message(
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


def _touch_session(db_connection, chat_session_id: str) -> None:
    with db_connection.cursor() as cur:
        cur.execute("UPDATE chat_sessions SET last_active_at = NOW() WHERE id = %s", (chat_session_id,))


# -----------------------------
# RETRIEVAL HELPERS (The "Manual" Part)
# -----------------------------
def _retrieve_documents(
    query: str,
    knowledge_base_id: str,
    bedrock_region: str,
    num_results: int, 
    search_type: str = "HYBRID"
) -> List[Dict[str, Any]]:
    """
    Manually retrieve documents from the Knowledge Base.
    """
    agent_runtime = boto3.client("bedrock-agent-runtime", region_name=bedrock_region)
    
    try:
        response = agent_runtime.retrieve(
            knowledgeBaseId=knowledge_base_id,
            retrievalQuery={'text': query},
            retrievalConfiguration={
                'vectorSearchConfiguration': {
                    'numberOfResults': num_results,
                    "overrideSearchType": search_type
                }
            }
        )
        
        results = response.get('retrievalResults', [])
        logger.info(f"Manual Retrieval found {len(results)} chunks.")
        
        # Normalize the results into our standard "source" format
        sources = []
        for r in results:
            location = r.get("location", {})
            metadata = r.get("metadata", {})
            content = r.get("content", {}).get("text", "")
            
            loc_type = location.get("type", "UNKNOWN")
            url = None
            if loc_type == "WEB":
                url = location.get("webLocation", {}).get("url")
            elif loc_type == "S3":
                url = location.get("s3Location", {}).get("uri")
                
            sources.append({
                "type": loc_type,
                "uri": metadata.get("x-amz-bedrock-kb-source-uri") or url,
                "url": url,
                "content": content, # We need the actual text for the prompt!
                "score": r.get("score")
            })
            
        return sources
    except Exception as e:
        logger.error(f"Retrieval failed: {e}")
        return []


def _format_context_for_prompt(sources: List[Dict[str, Any]]) -> str:
    """Turn the list of sources into a text block for the prompt."""
    if not sources:
        return "No specific documents found."
    
    context_str = ""
    for i, source in enumerate(sources, 1):
        context_str += f"<source_{i}>\n{source['content']}\n</source_{i}>\n\n"
    return context_str

# -----------------------------
# Decide conversation phase 
# -----------------------------

def decide_conversation_phase(chat_history_text, current_user_input):
    """
    Asks the LLM: 'Do we have enough info to suggest?'
    Returns: 'INTERVIEW' (if missing info) or 'SUGGEST' (if ready).
    """
    bedrock = boto3.client("bedrock-runtime", region_name="ca-central-1")
    
    # The Router Prompt: Fast and logical
    router_prompt = f"""
    You are a Logic Router. Analyze the conversation history below.
    
    REQUIRED INFORMATION FOR A RECOMMENDATION:
    1. Academic Interest (e.g. "I like Math/Bio/CS")
    2. Career Goal (e.g. "Industry", "Research", "Med School")
    3. Work Style (e.g. "Hands-on", "Theory", "Outdoors")
    
    HISTORY:
    {chat_history_text}
    User: {current_user_input}
    
    DECISION:
    - If ALL 3 requirements are clear (even vaguely), output: SUGGEST
    - If ANY requirement is missing, output: INTERVIEW
    
    Output ONE WORD only.
    """
    
    try:
        response = bedrock.converse(
            modelId="mistral.mistral-large-2402-v1:0",
            messages=[{"role": "user", "content": [{"text": router_prompt}]}],
            inferenceConfig={"maxTokens": 10, "temperature": 0} # Deterministic
        )
        decision = response["output"]["message"]["content"][0]["text"].strip().upper()
        if "SUGGEST" in decision: return "SUGGEST"
        return "INTERVIEW"
    except:
        return "INTERVIEW" # Default to safety


# -----------------------------
# Public API called by notebook
# -----------------------------
def get_response(
    query: str,
    knowledge_base_id: str,
    model_arn: str,
    bedrock_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    system_prompt: str,
    db_connection,
    bedrock_session_id: Optional[str] = None, # Ignored in this version
    max_history_messages: int = 10,
    max_chars_user: int = 2000,
    max_chars_ai: int = 4000,
    num_retrieval_results: int = 5,
    search_type: str = "HYBRID",
    max_tokens: int = 2048,
    temperature: float = 0.3, # Slightly higher for better chat
    top_p: float = 0.9,
) -> Dict[str, Any]:
    
    # 1. Validation
    if not query.strip():
        return {"response": "Please provide a non-empty question.", "sources_used": []}

    # 2. Retrieve History (Postgres)
    # We fetch the raw history to build the prompt context
    raw_history = _fetch_recent_messages(db_connection, chat_session_id, limit=max_history_messages * 2)
    
    # 3. Save User Message
    try:
        _ensure_session_exists(db_connection, chat_session_id, user_id)
        _insert_message(db_connection, chat_session_id, "user", query, None)
        _touch_session(db_connection, chat_session_id)
        db_connection.commit()
    except Exception as e:
        db_connection.rollback()
        return {"response": "Database Error", "sources_used": []}

    # 4. MANUAL RAG STEP 1: Retrieve
    # We ignore the "previous conversation" for the search query to ensure we actually find facts.
    # If the user asks "What are the options?", we search for "What are the options?".
    sources = _retrieve_documents(query, knowledge_base_id, bedrock_region, num_retrieval_results, search_type=search_type)
    
    # 5. Build the Prompt
    context_block = _format_context_for_prompt(sources)
    
    # Construct the "System" instruction
    # We modify the system prompt slightly to inject the context instructions
    full_system_prompt = f"""{system_prompt}

You have access to the following retrieved information from the university database:
<retrieved_context>
{context_block}
</retrieved_context>

INSTRUCTIONS:
1. Answer the user's question using the <retrieved_context> if relevant.
2. If the user is just chatting (e.g. "hello", "thanks"), respond naturally.
3. ALWAYS ANSWER. Never refuse. If the context is empty, say what you know or ask for clarification.
"""

    # 6. Build Message History for Bedrock Converse API
    # Bedrock 'converse' expects: [{'role': 'user', 'content': [{'text': ...}]}, ...]
    bedrock_messages = []
    
    # Add history
    for msg in raw_history:
        role = "user" if msg["sender"] == "user" else "assistant"
        # Skip empty messages or system messages if any
        if msg["content"]:
            bedrock_messages.append({
                "role": role,
                "content": [{"text": msg["content"]}]
            })
            
    # Add current user query
    bedrock_messages.append({
        "role": "user",
        "content": [{"text": query}]
    })

    # 7. MANUAL RAG STEP 2: Generate (Converse API)
    bedrock_runtime = boto3.client("bedrock-runtime", region_name=bedrock_region)
    
    try:
        response = bedrock_runtime.converse(
            modelId=model_arn,
            messages=bedrock_messages,
            system=[{"text": full_system_prompt}],
            inferenceConfig={
                "maxTokens": max_tokens,
                "temperature": temperature,
                "topP": top_p
            }
        )
        
        answer_text = response["output"]["message"]["content"][0]["text"]
        
    except Exception as e:
        logger.error(f"Generation Failed: {e}")
        answer_text = "I encountered an error generating the response"

    # 8. Save AI Response
    try:
        # Strip content from sources before saving to DB to save space (optional, but good practice)
        sources_for_db = [{k: v for k, v in s.items() if k != 'content'} for s in sources]
        
        _insert_message(db_connection, chat_session_id, "AI", answer_text, sources_for_db)
        _touch_session(db_connection, chat_session_id)
        db_connection.commit()
    except Exception as e:
        db_connection.rollback()
        logger.error(f"Failed to save AI response: {e}")

    return {
        "response": answer_text,
        "sources_used": sources,
        "sessionId": chat_session_id, # We return our DB ID, since we manage the session
        "is_first_message": False
    }