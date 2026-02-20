
import boto3
import logging
from typing import Dict, Any, Optional, List, Tuple
from helpers.db import (
    fetch_recent_messages, ensure_session_exists, insert_message, touch_session
)
from helpers.logic import get_current_prompt
from helpers.bedrock import retrieve_documents, format_context_for_prompt
import helpers.config as config

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

def _prepare_conversation(
    query: str,
    knowledge_base_id: str,
    bedrock_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    db_connection,
    max_history_messages: Optional[int] = None,
    search_type: Optional[str] = None,
    save_user_message: bool = True
) -> Tuple[List[Dict[str, Any]], str, List[Dict[str, Any]]]:
    """
    Handles validation, history fetching, user msg saving, retrieval, and prompt construction.
    Returns: (bedrock_messages, full_system_prompt, sources)
    """
    # Resolve dynamic defaults
    if max_history_messages is None:
        max_history_messages = config.MAX_MESSAGES_PER_SESSION
    if search_type is None:
        search_type = config.SEARCH_TYPE

    # 1. Validation
    if not query or not query.strip():
        raise ValueError("Please provide a non-empty question.")

    # 2. Retrieve History
    raw_history = fetch_recent_messages(db_connection, chat_session_id, limit=max_history_messages * 2)
    
    # 3. Save User Message
    try:
        if save_user_message:
            ensure_session_exists(db_connection, chat_session_id, user_id)
            insert_message(db_connection, chat_session_id, "user", query, None)
            touch_session(db_connection, chat_session_id)
            db_connection.commit()
    except Exception as e:
        db_connection.rollback()
        logger.error(f"DB Error: {e}")
        raise e

    # 4. Determine Phase & Prompt
    current_system_prompt, num_retrieval_results = get_current_prompt(
        chat_session_id, 
        db_connection
    )

    # 5. RAG Retrieval
    sources = retrieve_documents(
        query, 
        knowledge_base_id, 
        bedrock_region, 
        num_retrieval_results, 
        search_type=search_type
    )
    
    # 6. Build Context
    context_block = format_context_for_prompt(sources)
    
    # 7. Construct Final System Prompt
    full_system_prompt = f"""{current_system_prompt}

You have access to the following retrieved information from the university database:
<retrieved_context>
{context_block}
</retrieved_context>

INSTRUCTIONS:
1. Answer the user's question using the <retrieved_context> if relevant.
2. If the user is just chatting (e.g. "hello", "thanks"), respond naturally.
3. ALWAYS ANSWER. Never refuse. If the context is empty, say what you know or ask for clarification.
"""

    # 8. Build Messages
    bedrock_messages = []
    for msg in raw_history:
        role = "user" if msg["sender"] == "user" else "assistant"
        if msg["content"]:
            bedrock_messages.append({
                "role": role,
                "content": [{"text": msg["content"]}]
            })
            
    bedrock_messages.append({
        "role": "user",
        "content": [{"text": query}]
    })

    return bedrock_messages, full_system_prompt, sources

def _save_ai_response(db_connection, chat_session_id: str, answer_text: str, sources: List[Dict[str, Any]]):
    try:
        sources_for_db = [{k: v for k, v in s.items() if k != 'content'} for s in sources]
        insert_message(db_connection, chat_session_id, "AI", answer_text, sources_for_db)
        touch_session(db_connection, chat_session_id)
        db_connection.commit()
    except Exception as e:
        db_connection.rollback()
        logger.error(f"Failed to save AI response: {e}")

def get_response(
    query: str,
    knowledge_base_id: str,
    model_arn: str,
    bedrock_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    db_connection,
    save_user_message: bool = True
) -> Dict[str, Any]:
    
    try:
        bedrock_messages, full_system_prompt, sources = _prepare_conversation(
            query, knowledge_base_id, bedrock_region, chat_session_id, user_id, db_connection,
            save_user_message=save_user_message
        )
    except ValueError as e:
        return {"response": str(e), "sources_used": []}
    except Exception as e:
         logger.error(f"Prepare conversation failed: {e}")
         return {"response": "An error occurred.", "sources_used": []}

    bedrock_runtime = boto3.client("bedrock-runtime", region_name=bedrock_region)
    
    answer_text = ""
    try:
        response = bedrock_runtime.converse(
            modelId=model_arn,
            messages=bedrock_messages,
            system=[{"text": full_system_prompt}],
            inferenceConfig={"maxTokens": config.MAX_TOKENS, "temperature": config.TEMPERATURE, "topP": config.TOP_P}
        )
        answer_text = response["output"]["message"]["content"][0]["text"]
    except Exception as e:
        logger.error(f"Generation Failed: {e}")
        answer_text = "I encountered an error generating the response."

    _save_ai_response(db_connection, chat_session_id, answer_text, sources)

    return {
        "response": answer_text,
        "sources_used": sources,
        "sessionId": chat_session_id,
        "is_first_message": False
    }
