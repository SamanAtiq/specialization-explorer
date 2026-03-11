
import boto3
import logging
from typing import Dict, Any, Optional, List, Tuple
from helpers.crud import (
    fetch_recent_messages, ensure_session_exists, insert_message, update_last_active_session
)
from helpers.logic import get_current_prompt
from helpers.bedrock import retrieve_documents, format_context_for_prompt
import helpers.config as config
from helpers.token_limits import check_limit, record_usage

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

def _rewrite_query_for_retrieval(
    raw_query: str,
    chat_history: List[Dict[str, Any]],
    bedrock_region: str,
    model_arn: str
) -> str:
    """
    Uses a fast LLM call to rewrite a conversational user query into a
    keyword-rich search query optimized for vector database retrieval.
    Falls back to the raw query on any error.
    """
    # Build a condensed history string (last few exchanges only)
    history_lines = []
    for msg in chat_history[-6:]:
        role = "User" if msg["sender"] == "user" else "Assistant"
        history_lines.append(f"{role}: {msg['content']}")
    history_block = "\n".join(history_lines) if history_lines else "(no prior conversation)"

    rewrite_prompt = (
        "You are a search query optimizer for a university specialization database. "
        "Given the conversation history and the user's latest message, generate a short, "
        "keyword-rich search query to find relevant university specialization documents. "
        "Focus on academic subjects, career goals, and interests mentioned. "
        "Output ONLY the search query — no explanation, no quotes."
    )

    user_message = f"""<conversation_history>
{history_block}
</conversation_history>

<latest_user_message>
{raw_query}
</latest_user_message>

Generate the optimized search query:"""

    try:
        bedrock_runtime = boto3.client("bedrock-runtime", region_name=bedrock_region)
        response = bedrock_runtime.converse(
            modelId=model_arn,
            messages=[{"role": "user", "content": [{"text": user_message}]}],
            system=[{"text": rewrite_prompt}],
            inferenceConfig={"maxTokens": 100, "temperature": 0.0}
        )
        rewritten = response["output"]["message"]["content"][0]["text"].strip()
        logger.info(f"Query rewrite: '{raw_query}' -> '{rewritten}'")
        return rewritten if rewritten else raw_query
    except Exception as e:
        logger.warning(f"Query rewrite failed, using raw query: {e}")
        return raw_query

def _prepare_conversation(
    query: str,
    knowledge_base_id: str,
    bedrock_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    db_connection,
    search_type: Optional[str] = None,
    save_user_message: bool = True
) -> Tuple[List[Dict[str, Any]], str, List[Dict[str, Any]]]:
    """
    Handles validation, history fetching, user msg saving, retrieval, and prompt construction.
    Returns: (bedrock_messages, full_system_prompt, sources)
    """
    # Resolve dynamic defaults
    if search_type is None:
        search_type = config.SEARCH_TYPE

    # 1. Validation
    if not query or not query.strip():
        raise ValueError("Please provide a non-empty question.")

    # 2. Retrieve History
    raw_history = fetch_recent_messages(db_connection, chat_session_id)
    
    # 3. Save User Message
    try:
        if save_user_message:
            ensure_session_exists(db_connection, chat_session_id, user_id)
            insert_message(db_connection, chat_session_id, "user", query, None)
            update_last_active_session(db_connection, chat_session_id)
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

    # 5. Rewrite query for better retrieval
    search_query = _rewrite_query_for_retrieval(
        raw_query=query,
        chat_history=raw_history,
        bedrock_region=bedrock_region,
        model_arn=config.MODEL_ARN
    )

    # 6. RAG Retrieval (using rewritten query)
    sources = retrieve_documents(
        search_query, 
        knowledge_base_id, 
        bedrock_region, 
        num_retrieval_results, 
        search_type=search_type
    )
    
    # 7. Build Context
    context_block = format_context_for_prompt(sources)
    
    # 8. Construct Final System Prompt
    full_system_prompt = f"""{current_system_prompt}

<retrieved_context>
{context_block}
</retrieved_context>

<response_instructions>
1. Answer the user's question using the retrieved_context if relevant.
2. If the user is just chatting (e.g. "hello", "thanks"), respond naturally.
3. ALWAYS ANSWER. Never refuse. If the context is empty, say what you know or ask for clarification.
</response_instructions>
"""

    # 9. Build Messages
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
        sources_for_db = []
        for s in sources:
            s_copy = s.copy()
            if 'content' in s_copy and isinstance(s_copy['content'], str):
                s_copy['content'] = s_copy['content']
            sources_for_db.append(s_copy)

        insert_message(db_connection, chat_session_id, "AI", answer_text, sources_for_db)
        update_last_active_session(db_connection, chat_session_id)
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
    
    usage_info = {}
    is_under_limit = True

    try:
        if user_id:
            is_under_limit, usage_info = check_limit(user_id, db_connection)
            if not is_under_limit:
                return {
                    "response": "Daily token limit exceeded. Please try again tomorrow.",
                    "sources_used": [],
                    "sessionId": chat_session_id,
                    "is_first_message": False,
                    "token_limit_exceeded": True,
                    "token_usage": usage_info
                }

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

    if user_id and answer_text and not answer_text.startswith("I encountered an error"):
        usage_info = record_usage(user_id, answer_text, db_connection)

    return {
        "response": answer_text,
        "sources_used": sources,
        "sessionId": chat_session_id,
        "is_first_message": False,
        "token_usage": usage_info
    }
