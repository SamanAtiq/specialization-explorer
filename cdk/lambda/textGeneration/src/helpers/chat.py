
import json
import logging
import boto3
from typing import Any, Dict, List, Optional, Tuple, Generator
from helpers.db_helpers import (
    get_current_prompt,
    fetch_recent_messages,
    ensure_session_exists,
    insert_message,
    touch_session
)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# -----------------------------
# RETRIEVAL HELPERS
# -----------------------------
def _retrieve_documents(
    query: str,
    knowledge_base_id: str,
    bedrock_region: str,
    num_results: int, 
    search_type: str = "HYBRID",
) -> List[Dict[str, Any]]:
    """
    Retrieve documents from the Knowledge Base.
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
        logger.info(f"Retrieval found {len(results)} chunks.")
        
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
                "content": content,
                "score": r.get("score")
            })
            
        return sources
    except Exception as e:
        logger.error(f"Retrieval failed: {e}")
        return []

def _format_context_for_prompt(sources: List[Dict[str, Any]]) -> str:
    if not sources:
        return "No specific documents found."
    context_str = ""
    for i, source in enumerate(sources, 1):
        context_str += f"<source_{i}>\n{source['content']}\n</source_{i}>\n\n"
    return context_str

# -----------------------------
# SHARED PREPARATION LOGIC
# -----------------------------
def _prepare_conversation(
    query: str,
    knowledge_base_id: str,
    bedrock_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    system_messages: Dict[str, str],
    db_connection,
    max_history_messages: int = 10,
    search_type: str = "HYBRID"
) -> Tuple[List[Dict[str, Any]], str, List[Dict[str, Any]]]:
    """
    Handles validation, history fetching, user msg saving, retrieval, and prompt construction.
    Returns: (bedrock_messages, full_system_prompt, sources)
    """
    # 1. Validation
    if not query or not query.strip():
        raise ValueError("Please provide a non-empty question.")

    # 2. Retrieve History
    raw_history = fetch_recent_messages(db_connection, chat_session_id, limit=max_history_messages * 2)
    
    # 3. Save User Message
    try:
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
        db_connection, 
        system_messages
    )

    # 5. RAG Retrieval
    sources = _retrieve_documents(
        query, 
        knowledge_base_id, 
        bedrock_region, 
        num_retrieval_results, 
        search_type=search_type
    )
    
    # 6. Build Context
    context_block = _format_context_for_prompt(sources)
    
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

# -----------------------------
# CORE EXPORTS
# -----------------------------
def get_response(
    query: str,
    knowledge_base_id: str,
    model_arn: str,
    bedrock_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    system_messages: Dict[str, str],
    db_connection,
    retriever=None, # signature compat
    guardrail_id=None # signature compat
) -> Dict[str, Any]:
    
    try:
        bedrock_messages, full_system_prompt, sources = _prepare_conversation(
            query, knowledge_base_id, bedrock_region, chat_session_id, user_id, system_messages, db_connection
        )
    except ValueError as e:
        return {"response": str(e), "sources_used": []}
    except Exception as e:
         return {"response": "An error occurred.", "sources_used": []}

    bedrock_runtime = boto3.client("bedrock-runtime", region_name=bedrock_region)
    
    answer_text = ""
    try:
        response = bedrock_runtime.converse(
            modelId=model_arn,
            messages=bedrock_messages,
            system=[{"text": full_system_prompt}],
            inferenceConfig={"maxTokens": 2048, "temperature": 0.3, "topP": 0.9}
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

def get_response_streaming(
    query: str,
    textbook_id: str, # maps to knowledge_base_id
    llm, # ignored, using boto3
    retriever, # ignored
    chat_session_id: str,
    connection, # db_connection
    websocket_endpoint: str,
    connection_id: str,
    bedrock_llm_id: str,
    table_name: str = None, # ignored
    guardrail_id: str = None # ignored
):
    # Adapter for main.py's process_query_streaming signature
    # Note: main.py passes textbook_id, we treat it as KB_ID
    # We need system_messages. main.py doesn't pass it to process_query_streaming signature in old code
    # BUT main.py's process_query_streaming calls THIS function.
    # We need to fetch system_messages inside here if not passed.
    
    from helpers.config_loader import load_system_messages
    system_messages = load_system_messages(connection)
    
    # We also need bedrock_region. default to 'us-east-1' or from env if not passed
    # passing bedrock_llm_id is good.
    import os
    bedrock_region = os.environ.get("BEDROCK_REGION_PARAM", "us-east-1")
    if not bedrock_region.startswith("us-"): # simple check, or just use os.environ['REGION']
         bedrock_region = os.environ.get("REGION", "us-east-1")

    try:
        bedrock_messages, full_system_prompt, sources = _prepare_conversation(
            query, textbook_id, bedrock_region, chat_session_id, None, system_messages, connection
        )
    except Exception as e:
        logger.error(f"Prep failed: {e}")
        return {"response": "Error", "sources_used": []}

    bedrock_runtime = boto3.client("bedrock-runtime", region_name=bedrock_region)
    apigatewaymanagementapi = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)

    full_response_text = ""
    try:
        response = bedrock_runtime.converse_stream(
            modelId=bedrock_llm_id,
            messages=bedrock_messages,
            system=[{"text": full_system_prompt}],
            inferenceConfig={"maxTokens": 2048, "temperature": 0.3, "topP": 0.9}
        )
        
        stream = response.get('stream')
        if stream:
            for event in stream:
                if 'contentBlockDelta' in event:
                    chunk = event['contentBlockDelta']['delta']['text']
                    full_response_text += chunk
                    # Send chunk to WS
                    apigatewaymanagementapi.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps({"type": "content_block_delta", "delta": {"text": chunk}})
                    )
    except Exception as e:
        logger.error(f"Streaming failed: {e}")
        # Try to send error to WS
        try:
             apigatewaymanagementapi.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps({"type": "error", "message": "Streaming failed."})
            )
        except: pass
        return {"response": "Error", "sources_used": []}

    _save_ai_response(connection, chat_session_id, full_response_text, sources)
    
    return {
        "response": full_response_text,
        "sources_used": sources
    }
