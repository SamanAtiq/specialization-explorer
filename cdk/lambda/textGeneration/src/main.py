import os
import json
import time
import logging
import threading

# Set up basic logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
REGION = os.environ["REGION"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
BEDROCK_LLM_PARAM = os.environ.get("BEDROCK_LLM_PARAM")
EMBEDDING_MODEL_PARAM = os.environ.get("EMBEDDING_MODEL_PARAM")
EMBEDDING_MODEL_PARAM = os.environ.get("EMBEDDING_MODEL_PARAM")
BEDROCK_REGION_PARAM = os.environ.get("BEDROCK_REGION_PARAM")
DAILY_TOKEN_LIMIT_PARAM = os.environ.get("DAILY_TOKEN_LIMIT_PARAM")
WEBSOCKET_API_ENDPOINT = os.environ.get("WEBSOCKET_API_ENDPOINT", "")
KB_SECRET_NAME = "knowledge-base-id" # Secret name for KB ID
COLD_START_METRIC = os.environ.get("COLD_START_METRIC", "false").lower() == "true"
FORCE_COLD_START_TEST = os.environ.get("FORCE_COLD_START_TEST", "false").lower() == "true"
#comment to invoke code pipeline
# Lazy-loaded globals - initialized only when needed
_secrets_manager = None
_ssm_client = None
_bedrock_runtime = None
_db_connection_pool = None
_pool_lock = threading.Lock()
_db_secret = None
_embeddings = None
_is_cold_start = True
_startup_ts = time.time()

# Pre-loaded configuration - loaded at container startup
BEDROCK_LLM_ID = None
EMBEDDING_MODEL_ID = None
BEDROCK_REGION = None
KNOWLEDGE_BASE_ID = None

# Pre-load critical configuration during container startup (outside handler)
try:
    logger.info("Pre-loading critical configuration...")
    import boto3
    
    _ssm_client = boto3.client("ssm", region_name=REGION)
    _secrets_manager = boto3.client("secretsmanager", region_name=REGION)
    
    # Pre-fetch SSM parameters
    if BEDROCK_LLM_PARAM:
        BEDROCK_LLM_ID = _ssm_client.get_parameter(Name=BEDROCK_LLM_PARAM, WithDecryption=True)["Parameter"]["Value"]
        logger.info(f"Pre-loaded BEDROCK_LLM_ID: {BEDROCK_LLM_ID}")
    
    if EMBEDDING_MODEL_PARAM:
        EMBEDDING_MODEL_ID = _ssm_client.get_parameter(Name=EMBEDDING_MODEL_PARAM, WithDecryption=True)["Parameter"]["Value"]
        logger.info(f"Pre-loaded EMBEDDING_MODEL_ID: {EMBEDDING_MODEL_ID}")
    
    if BEDROCK_REGION_PARAM:
        BEDROCK_REGION = _ssm_client.get_parameter(Name=BEDROCK_REGION_PARAM, WithDecryption=True)["Parameter"]["Value"]
        logger.info(f"Pre-loaded BEDROCK_REGION: {BEDROCK_REGION}")
    else:
        BEDROCK_REGION = REGION
        logger.info(f"Using deployment region as BEDROCK_REGION: {BEDROCK_REGION}")
    
    else:
        BEDROCK_REGION = REGION
        logger.info(f"Using deployment region as BEDROCK_REGION: {BEDROCK_REGION}")
    
    # Pre-fetch KB ID from Secrets Manager
    try:
        secret_response = _secrets_manager.get_secret_value(SecretId=KB_SECRET_NAME)
        if 'SecretString' in secret_response:
            KNOWLEDGE_BASE_ID = secret_response['SecretString']
            logger.info(f"Pre-loaded KNOWLEDGE_BASE_ID from secret")
    except Exception as secret_error:
        logger.warning(f"Failed to pre-load KB ID from secret: {secret_error}")
    
    logger.info(f"Pre-loading completed in {time.time() - _startup_ts:.2f}s")
except Exception as e:
    logger.warning(f"Pre-loading failed (will load on-demand): {e}")


def get_secrets_manager():
    """Lazy-load secrets manager client"""
    global _secrets_manager
    if _secrets_manager is None:
        import boto3
        _secrets_manager = boto3.client("secretsmanager", region_name=REGION)
    return _secrets_manager


def get_ssm_client():
    """Lazy-load SSM client"""
    global _ssm_client
    if _ssm_client is None:
        import boto3
        _ssm_client = boto3.client("ssm", region_name=REGION)
    return _ssm_client


def get_bedrock_runtime():
    """Lazy-load Bedrock runtime client"""
    global _bedrock_runtime
    if _bedrock_runtime is None:
        import boto3
        _bedrock_runtime = boto3.client("bedrock-runtime", region_name='us-east-1')
    return _bedrock_runtime


def get_embeddings():
    """Lazy-load embeddings model"""
    global _embeddings
    if _embeddings is None:
        from langchain_aws import BedrockEmbeddings
        bedrock_runtime = get_bedrock_runtime()
        _embeddings = BedrockEmbeddings(
            model_id=EMBEDDING_MODEL_ID,
            client=bedrock_runtime,
            region_name='us-east-1',
            model_kwargs={"input_type": "search_document"}
        )
        logger.info(f"Initialized embeddings with model: {EMBEDDING_MODEL_ID}")
    return _embeddings


def emit_cold_start_metrics(function_name: str, execution_ms: int, cold_start_ms: int | None) -> None:
    """Emit embedded CloudWatch metrics for cold start and execution time."""
    if not COLD_START_METRIC:
        return

    metrics_payload = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": "Lambda/ColdStart",
                    "Dimensions": [["FunctionName"]],
                    "Metrics": [
                        {"Name": "ColdStart", "Unit": "Count"},
                        {"Name": "ColdStartDurationMs", "Unit": "Milliseconds"},
                        {"Name": "ExecutionTimeMs", "Unit": "Milliseconds"},
                    ],
                }
            ],
        },
        "FunctionName": function_name,
        "ColdStart": 1 if cold_start_ms is not None else 0,
        "ColdStartDurationMs": cold_start_ms or 0,
        "ExecutionTimeMs": execution_ms,
    }

    print(json.dumps(metrics_payload))


def get_secret(secret_name, expect_json=True):
    """Get secret from Secrets Manager with caching"""
    global _db_secret
    if _db_secret is None:
        try:
            secrets_manager = get_secrets_manager()
            response = secrets_manager.get_secret_value(SecretId=secret_name)["SecretString"]
            _db_secret = json.loads(response) if expect_json else response
        except Exception as e:
            logger.error(f"Error fetching secret: {e}")
            raise
    return _db_secret


def get_parameter(param_name, cached_var):
    """Get parameter from SSM Parameter Store"""
    if cached_var is None and param_name:
        try:
            ssm = get_ssm_client()
            response = ssm.get_parameter(Name=param_name, WithDecryption=True)
            cached_var = response["Parameter"]["Value"]
        except Exception as e:
            logger.error(f"Error fetching parameter {param_name}: {e}")
            raise
    return cached_var


def initialize_constants():
    """Initialize constants - now mostly a no-op since we pre-load at startup"""
    # Constants are already pre-loaded at module level
    # This function is kept for compatibility but does nothing now
    if BEDROCK_LLM_ID is None:
        logger.warning("BEDROCK_LLM_ID not pre-loaded. This may indicate configuration issues.")
    if KNOWLEDGE_BASE_ID is None:
        logger.warning("KNOWLEDGE_BASE_ID not pre-loaded.")
    pass


def get_db_connection_pool():
    """Get or create database connection pool with thread-safe singleton pattern"""
    global _db_connection_pool
    
    if _db_connection_pool is None:
        with _pool_lock:
            # Double-check locking pattern
            if _db_connection_pool is None:
                import psycopg2.pool
                try:
                    secret = get_secret(DB_SECRET_NAME)
                    _db_connection_pool = psycopg2.pool.ThreadedConnectionPool(
                        minconn=1,
                        maxconn=5,
                        host=RDS_PROXY_ENDPOINT,
                        database=secret["dbname"],
                        user=secret["username"],
                        password=secret["password"],
                        port=int(secret["port"])
                    )
                    logger.info("Database connection pool created")
                except Exception as e:
                    logger.error(f"Failed to create connection pool: {e}")
                    raise
    
    return _db_connection_pool


def get_db_credentials():
    """Get database credentials from Secrets Manager"""
    try:
        return get_secret(DB_SECRET_NAME)
    except Exception as e:
        logger.error(f"Error fetching DB credentials: {e}")
        raise


def connect_to_db():
    """Get a database connection from the pool"""
    try:
        pool = get_db_connection_pool()
        connection = pool.getconn()
        logger.info("Got database connection from pool")
        return connection
    except Exception as e:
        logger.error(f"Failed to get database connection: {e}")
        raise


def return_db_connection(connection):
    """Return a database connection to the pool"""
    if _db_connection_pool and connection:
        try:
            _db_connection_pool.putconn(connection)
            logger.debug("Returned database connection to pool")
        except Exception as e:
            logger.error(f"Error returning connection to pool: {e}")


def estimate_token_count(text: str) -> int:
    """
    Estimate the number of tokens in a text string.
    Uses a simple word-based approximation: ~1.3 tokens per word for English text.
    
    Args:
        text: The text to estimate tokens for
    
    Returns:
        Estimated token count
    """
    if not text:
        return 0
    # Simple approximation: split by whitespace and multiply by 1.3
    word_count = len(text.split())
    return int(word_count * 1.3)


# This function is now a wrapper for the helper function in chat.py
def process_query_streaming(query, textbook_id, retriever, chat_session_id, websocket_endpoint, connection_id, connection=None):
    """
    Process a query using streaming response via WebSocket
    """
    # Lazy import
    from helpers.chat import get_bedrock_llm, get_response_streaming
    
    logger.info(f"Processing streaming query with LLM model ID: '{BEDROCK_LLM_ID}'")
    
    try:
        # Initialize LLM
        logger.info(f"Initializing Bedrock LLM with model ID: {BEDROCK_LLM_ID}")
        llm = get_bedrock_llm(BEDROCK_LLM_ID, bedrock_region=BEDROCK_REGION)
        
        # Use the streaming helper function from chat.py
        logger.info(f"Calling get_response_streaming with textbook_id: {textbook_id}")
        return get_response_streaming(
            query=query,
            textbook_id=textbook_id,
            llm=llm,
            retriever=retriever,
            chat_session_id=chat_session_id,
            connection=connection,
            guardrail_id=GUARDRAIL_ID,
            websocket_endpoint=websocket_endpoint,
            connection_id=connection_id,
            bedrock_llm_id=BEDROCK_LLM_ID
        )
    except Exception as e:
        logger.error(f"Error in process_query_streaming: {str(e)}", exc_info=True)
        # Send error message via WebSocket
        try:
            import boto3
            apigatewaymanagementapi = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
            apigatewaymanagementapi.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps({
                    "type": "error",
                    "message": "I'm sorry, I encountered an error while processing your question."
                })
            )
        except Exception as ws_error:
            logger.error(f"Failed to send the error via WebSocket: {ws_error}")
        
        return {
            "response": f"I'm sorry, I encountered an error while processing your question.",
            "sources_used": []
        }


# Legacy process_query removed. Use helpers.chat.get_response instead.

def handler(event, context):
    """
    Lambda handler function for textbook question answering API endpoint
    
    Takes an API Gateway event with a textbook_id and question,
    retrieves relevant passages from the vectorstore, and generates
    an answer using the helper functions in chat.py
    
    Supports both regular API calls and WebSocket streaming
    """
    global _is_cold_start
    start_time = time.time()
    cold_start_duration_ms = None
    if FORCE_COLD_START_TEST:
        _is_cold_start = True  # force a cold path on every invocation for testing
    if _is_cold_start:
        # Use module import timestamp for real cold starts; fall back to handler start for forced tests
        baseline = _startup_ts if not FORCE_COLD_START_TEST else start_time
        cold_start_duration_ms = int((time.time() - baseline) * 1000)
        logger.info(f"⚡ COLD START detected: {cold_start_duration_ms}ms since container start")
        _is_cold_start = False
    else:
        logger.info("♻️ WARM START")

    def finalize(resp):
        execution_ms = int((time.time() - start_time) * 1000)
        emit_cold_start_metrics(context.function_name, execution_ms, cold_start_duration_ms)
        logger.info(f"Total execution time: {execution_ms}ms")
        return resp

    logger.info("Starting textbook question answering Lambda")
    logger.info(f"AWS Region: {REGION}")
    logger.info(f"Lambda function ARN: {context.invoked_function_arn}")
    logger.info(f"Lambda function name: {context.function_name}")
    logger.info(f"Model parameter paths - LLM: {BEDROCK_LLM_PARAM}, Embeddings: {EMBEDDING_MODEL_PARAM}, Bedrock Region: {BEDROCK_REGION_PARAM}")
    
    # Check if this is a WebSocket invocation
    is_websocket = event.get("requestContext", {}).get("connectionId") is not None
    logger.info(f"Request type: {'WebSocket' if is_websocket else 'API Gateway'}")
    
    # Extract parameters from the request
    query_params = event.get("queryStringParameters", {})
    path_params = event.get("pathParameters", {})
    logger.info(f"Request path parameters: {path_params}")
    
    # Parse request body
    body = {} if event.get("body") is None else json.loads(event.get("body"))
    
    # PARAMETER EXTRACTION UPDATE:
    # 1. Try to get from path parameters (REST API standard: /chat_sessions/{id}/text_generation)
    # 2. Try to get from body (WebSocket standard)
    chat_session_id = path_params.get("chat_session_id") or path_params.get("id") or body.get("chat_session_id")
    
    question = body.get("query", "")
    textbook_id = body.get("textbook_id", "")

    try:
    try:
        initialize_constants()
        logger.info(f"✅ Initialized constants - LLM: {BEDROCK_LLM_ID}, Region: {BEDROCK_REGION}")
    except Exception as e:
        logger.error(f"❌ Failed to initialize constants: {e}")
        return finalize({
            'statusCode': 500,
            'body': json.dumps(f'Configuration error: {str(e)}')
        })
    
    # Validate required parameters
    if not textbook_id:
        return finalize({
            "statusCode": 400,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"error": "Missing textbook_id parameter"})
        })
    
    if not question:
        return finalize({
            "statusCode": 400,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"error": "No question provided in the query field"})
        })
    
    connection = None
    
        # Lazy-load SSM client once for token limit checks
        ssm_client = get_ssm_client()
        
        # Get database credentials for vectorstore
        db_creds = get_db_credentials()
        vectorstore_config = {
            "dbname": db_creds["dbname"],
            "user": db_creds["username"],
            "password": db_creds["password"],
            "host": RDS_PROXY_ENDPOINT,
            "port": db_creds["port"]
        }
        
        # Get embeddings (lazy-loaded)
        embeddings = get_embeddings()
        
        # Get retriever for the textbook
        try:
            retriever = get_textbook_retriever(
                llm=None,  # Not needed for basic retriever initialization
                textbook_id=textbook_id,
                vectorstore_config_dict=vectorstore_config,
                embeddings=embeddings
            )
            
            if retriever is None:
                logger.warning(f"No retriever available for textbook {textbook_id}")
                return finalize({
                    "statusCode": 404,
                    "headers": {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Headers": "*",
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "*"
                    },
                    "body": json.dumps({"error": f"No embeddings found for textbook {textbook_id}"})
                })
        except Exception as retriever_error:
            logger.error(f"Error initializing retriever: {str(retriever_error)}", exc_info=True)
            return finalize({
                "statusCode": 500,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "*"
                },
                "body": json.dumps({"error": f"Failed to initialize retriever: {str(retriever_error)}"})
            })
        
        # Get database connection from pool
        connection = connect_to_db()

        # Load System Messages from DB
        from helpers.config_loader import load_system_messages
        system_messages = load_system_messages(connection)
        
        if not system_messages:
            logger.warning("No system messages loaded from DB. Using defaults/empty.")

        
        # Pre-check: Verify user hasn't exceeded daily token limit before processing
        if chat_session_id and DAILY_TOKEN_LIMIT_PARAM:
            try:
                # Get user_session_id from chat_session_id
                user_session_id = get_user_session_from_chat_session(connection, chat_session_id)
                
                if user_session_id:
                    # Check current token status
                    token_status = get_session_token_status(
                        connection=connection,
                        user_session_id=user_session_id,
                        global_limit_param_name=DAILY_TOKEN_LIMIT_PARAM,
                        ssm_client=ssm_client
                    )
                    
                    # Check if user has already exceeded their limit
                    daily_limit = token_status.get('daily_limit')
                    tokens_used = token_status.get('tokens_used', 0)
                    remaining_tokens = token_status.get('remaining_tokens', 0)
                    
                    # If limit is set (not infinity) and user has no remaining tokens
                    if daily_limit != float('inf') and remaining_tokens <= 0:
                        hours_until_reset = token_status.get('hours_until_reset', 0)
                        reset_time = token_status.get('reset_time', '')
                        
                        error_message = f"You have reached your daily token limit of {daily_limit:,} tokens. Your limit will reset in {hours_until_reset:.1f} hours."
                        
                        logger.warning(f"Token limit exceeded for user_session {user_session_id}: {tokens_used}/{daily_limit}")
                        
                        # For WebSocket, send error message
                        if is_websocket:
                            try:
                                connection_id = event['requestContext']['connectionId']
                                domain_name = event['requestContext']['domainName']
                                stage = event['requestContext']['stage']
                                websocket_endpoint = f"https://{domain_name}/{stage}"
                                apigatewaymanagementapi = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
                                
                                apigatewaymanagementapi.post_to_connection(
                                    ConnectionId=connection_id,
                                    Data=json.dumps({
                                        "type": "error",
                                        "message": error_message,
                                        "error_code": "TOKEN_LIMIT_EXCEEDED"
                                    })
                                )
                            except Exception as ws_error:
                                logger.error(f"Failed to send token limit error via WebSocket: {ws_error}")
                        
                        # Return 429 Too Many Requests
                        return finalize({
                            "statusCode": 429,
                            "headers": {
                                "Content-Type": "application/json",
                                "Access-Control-Allow-Headers": "*",
                                "Access-Control-Allow-Origin": "*",
                                "Access-Control-Allow-Methods": "*"
                            },
                            "body": json.dumps({
                                "error": "Daily token limit exceeded",
                                "message": error_message,
                                "usage_info": {
                                    "tokens_used": tokens_used,
                                    "daily_limit": daily_limit,
                                    "remaining_tokens": 0,
                                    "hours_until_reset": hours_until_reset,
                                    "reset_time": reset_time
                                }
                            })
                        })
                    
                    # Log current status
                    if daily_limit != float('inf'):
                        logger.info(f"Token pre-check passed. Current usage: {tokens_used}/{daily_limit}, Remaining: {remaining_tokens}")
                    else:
                        logger.info(f"Token tracking enabled but no limit set (unlimited)")
                        
            except Exception as token_error:
                logger.error(f"Error in token pre-check: {token_error}", exc_info=True)
                # Continue processing even if pre-check fails (fail open)
        
        # Check FAQ cache first for WebSocket requests (only non-chat-session queries)
        cached_response = None
        from_cache = False
        if is_websocket:
            logger.info("Checking FAQ cache for similar questions...")
            cached_response = check_faq_cache(
                question=question,
                textbook_id=textbook_id,
                embeddings=embeddings,
                connection=connection
            )
            
            if cached_response:
                logger.info(f"Found cached response (similarity: {cached_response.get('similarity', 0):.4f})")
                # Stream the cached response via WebSocket
                connection_id = event['requestContext']['connectionId']
                domain_name = event['requestContext']['domainName']
                stage = event['requestContext']['stage']
                websocket_endpoint = f"https://{domain_name}/{stage}"
                
                response_data = stream_cached_response(
                    cached_faq=cached_response,
                    websocket_endpoint=websocket_endpoint,
                    connection_id=connection_id
                )
                from_cache = True
        
        # Generate response using helper function if not found in cache
        if not from_cache:
            try:
                if is_websocket:
                    # For WebSocket, use streaming response
                    connection_id = event['requestContext']['connectionId']
                    domain_name = event['requestContext']['domainName']
                    stage = event['requestContext']['stage']
                    websocket_endpoint = f"https://{domain_name}/{stage}"
                    response_data = process_query_streaming(
                        query=question,
                        textbook_id=textbook_id,
                        retriever=retriever,
                        connection=connection,
                        chat_session_id=chat_session_id,
                        websocket_endpoint=websocket_endpoint,
                        connection_id=connection_id
                    )
                    
                    # Cache the response for future use (only for non-chat-session WebSocket queries)
                    # Validate that the response is appropriate for caching
                    should_cache = (
                        response_data.get("response") and
                        # Don't cache if guardrails blocked the content
                        not response_data.get("guardrail_blocked", False) and
                        # Don't cache error messages or very short responses (likely errors)
                        len(response_data.get("response", "")) > 50 and
                        # Ensure we have actual content from sources
                        len(response_data.get("sources_used", [])) > 0
                    )
                    
                    if should_cache:
                        logger.info("Caching FAQ response for future use...")
                        cache_metadata = {
                            "sources_count": len(response_data.get("sources_used", []))
                        }
                        cache_faq(
                            question=question,
                            answer=response_data["response"],
                            textbook_id=textbook_id,
                            embeddings=embeddings,
                            connection=connection,
                            sources=response_data.get("sources_used", []),
                            metadata=cache_metadata
                        )
                    else:
                        logger.info("Skipping FAQ cache: Response does not meet quality criteria for caching")
                else:
                    logger.info(f"Processing query for session {chat_session_id}")
                    
                    # Use the new get_response function (Logic from chat_mistral.py)
                    from helpers.chat import get_response
                    
                    response_data = get_response(
                        query=question,
                        knowledge_base_id=KNOWLEDGE_BASE_ID, # Use fetched KB ID
                        model_arn=BEDROCK_LLM_ID,
                        bedrock_region=BEDROCK_REGION,
                        chat_session_id=chat_session_id,
                        user_id=None, # Extract from token if available, else None
                        system_messages=system_messages,
                        db_connection=connection,
                        # Pass other params if needed
                    )
            except Exception as query_error:
                logger.error(f"Error processing query: {str(query_error)}", exc_info=True)
                response_data = {
                    "response": "I apologize, but I'm experiencing technical difficulties at the moment.",
                    "sources_used": []
                }
        
        # Track token usage after processing (only if chat_session_id is provided and not from cache)
        if chat_session_id and DAILY_TOKEN_LIMIT_PARAM and not from_cache:
            try:
                # Get user_session_id from chat_session_id
                user_session_id = get_user_session_from_chat_session(connection, chat_session_id)
                
                if user_session_id:
                    # Get actual token usage from response_data if available
                    token_usage = response_data.get('token_usage')
                    
                    if token_usage:
                        # Use actual token count from Bedrock
                        tokens_used = token_usage.get('total_tokens', 0)
                        logger.info(f"Using actual token usage from Bedrock: {tokens_used} tokens (input: {token_usage.get('input_tokens', 0)}, output: {token_usage.get('output_tokens', 0)})")
                    else:
                        # Fallback to estimation if actual usage not available
                        input_tokens = estimate_token_count(question)
                        output_tokens = estimate_token_count(response_data.get('response', ''))
                        tokens_used = input_tokens + output_tokens
                        logger.info(f"Using estimated token usage: {tokens_used} tokens (input: {input_tokens}, output: {output_tokens})")
                    
                    # Update token count in database
                    can_proceed, usage_info = check_and_update_token_limit(
                        connection=connection,
                        user_session_id=user_session_id,
                        tokens_to_add=tokens_used,
                        global_limit_param_name=DAILY_TOKEN_LIMIT_PARAM,
                        ssm_client=ssm_client
                    )
                    
                    if can_proceed:
                        logger.info(f"Token usage tracked successfully. Total: {usage_info.get('tokens_used')}/{usage_info.get('daily_limit')}, Remaining: {usage_info.get('remaining_tokens')}")
                    else:
                        # This shouldn't happen in post-processing, but log it
                        logger.warning(f"Token limit would be exceeded after processing: {usage_info.get('message')}")
                        # Note: We don't reject the response since it's already been generated
                        # This is just for tracking purposes
                else:
                    logger.warning(f"Could not find user_session for chat_session {chat_session_id}, skipping token tracking")
            except Exception as token_error:
                logger.error(f"Error tracking token usage: {token_error}", exc_info=True)
                # Continue even if token tracking fails (fail open)
        
        try:
            # Log the interaction for analytics purposes
            with connection.cursor() as cur:
                # Check if chat_session_id is provided for the log
                if chat_session_id:
                    cur.execute(
                        """
                        INSERT INTO user_interactions
                        (chat_session_id, sender_role, query_text, response_text, source_chunks)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (chat_session_id, "User", question, response_data["response"], json.dumps(response_data["sources_used"]))
                    )
            
            connection.commit()
            logger.info(f"Logged question for textbook {textbook_id}")
            
            # Update session name if this is a chat session (only for non-WebSocket requests)
            
        except Exception as db_error:
            connection.rollback()
            logger.error(f"Error logging question: {db_error}")
        finally:
            # Return connection to pool instead of closing
            if connection:
                return_db_connection(connection)
                connection = None
        
        # Return successful response
        response_body = {
            "textbook_id": textbook_id,
            "response": response_data["response"],
            "sources": response_data["sources_used"],
            "session_name": None # Session naming disabled in this version
        }
        
        # Include cache metadata if response was from cache
        if from_cache or response_data.get("from_cache"):
            response_body["from_cache"] = True
            if "cache_similarity" in response_data:
                response_body["cache_similarity"] = response_data["cache_similarity"]
        
        return finalize({
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*", 
                "Access-Control-Allow-Methods": "*"
            },
            "body": json.dumps(response_body)
        })
        
    except Exception as e:
        logger.error(f"Error processing request: {e}", exc_info=True)
        # Ensure connection is returned to pool on error
        if connection:
            return_db_connection(connection)
        return finalize({
            "statusCode": 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*"
            },
            "body": json.dumps({"error": f"Internal server error: {str(e)}"})
        })