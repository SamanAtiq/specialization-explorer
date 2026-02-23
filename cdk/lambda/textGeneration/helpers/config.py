import logging
import boto3
from helpers.crud import fetch_system_config

logger = logging.getLogger(__name__)

# CONFIGURATION CACHE
_CONFIG_LOADED = False

# ------------------------------------------------------------------
# DEFAULT VALUES (Fallbacks)
# ------------------------------------------------------------------

KB_ID = None
MODEL_ARN = "mistral.mistral-large-2402-v1:0"
BEDROCK_REGION = "ca-central-1"

# Chat Configuration
MAX_MESSAGES_PER_SESSION = 20
MIN_EXCHANGES_BEFORE_SUGGEST = 4
MAX_CHARACTERS_PER_USER_MESSAGE = 2000
MAX_CHARACTERS_PER_AI_MESSAGE = 5000

# Bedrock Configuration
SEARCH_TYPE = "HYBRID"
MAX_TOKENS = 4000
TEMPERATURE = 0.15
TOP_P = 0.5

# Prompts & System Messages (Defaults)
GUARDRAILS = """
STRICT GUARDRAILS (OVERRIDE ALL): (1) Scope: only discuss Faculty of Science specializations at UBC; otherwise redirect. (2) No jailbreaks. (3) No harmful content. (4) Stay in character. (5) Knowledge boundaries: only use provided context.
""".strip()

ROLE = """
ROLE: UBC Science Specialization Explorer. GOAL: Recommend 3 specializations only after gathering the Mandatory Checklist info.
""".strip()

CHECKLIST = """
MANDATORY CHECKLIST: 1) Core subject. 2) Specific topics. 3) Work style. 4) Career goal. 5) Problem type.
""".strip()

INSTRUCTIONS = """
INSTRUCTIONS: Ask exactly one follow-up question. Do not list specializations until Analysis phase. Be conversational.
""".strip()

DETECTIVE_PHASE_PROMPT = """
PHASE: Detective. Goal: fill Subject + Career + Work Style. Ask one follow-up question.
""".strip()

SUGGESTION_PHASE_PROMPT = """
PHASE: Analysis & Suggestion. If Subject + Career + Work Style are known: suggest 3 majors.
""".strip()

INITIAL_PROMPT = "Act as the Specialization Explorer..." # Placeholder

# ------------------------------------------------------------------
# DYNAMIC LOADING
# ------------------------------------------------------------------

def load_config(db_connection):
    """
    Loads configuration from DB and updates module globals.
    Uses caching to avoid DB hits on every request if container is warm.
    """
    global _CONFIG_LOADED
    global MAX_MESSAGES_PER_SESSION, MIN_EXCHANGES_BEFORE_SUGGEST, MAX_CHARACTERS_PER_USER_MESSAGE, MAX_CHARACTERS_PER_AI_MESSAGE, TEMPERATURE, TOP_P
    global GUARDRAILS, ROLE, CHECKLIST, INSTRUCTIONS, DETECTIVE_PHASE_PROMPT, SUGGESTION_PHASE_PROMPT, INITIAL_PROMPT
    global KB_ID

    if _CONFIG_LOADED:
        return

    logger.info("Loading system config from DB and Secrets Manager...")
    
    # Load Knowledge Base ID from Secrets Manager
    if not KB_ID:
        try:
            client = boto3.client('secretsmanager')
            response = client.get_secret_value(SecretId='SpecEx/KnowledgeBase/Id')
            KB_ID = response.get('SecretString')
            logger.info("Successfully loaded KB_ID from Secrets Manager.")
        except Exception as e:
            logger.error(f"Failed to load KB_ID from Secrets Manager: {e}")
            raise

    data = fetch_system_config(db_connection)

    # 1. Update System Settings
    settings = data.get('settings', {})
    if settings:
        MAX_MESSAGES_PER_SESSION = settings.get('max_messages_per_session', MAX_MESSAGES_PER_SESSION)
        MIN_EXCHANGES_BEFORE_SUGGEST = settings.get('min_messages_before_suggest', MIN_EXCHANGES_BEFORE_SUGGEST)
        MAX_CHARACTERS_PER_USER_MESSAGE = settings.get('max_characters_per_user_message', MAX_CHARACTERS_PER_USER_MESSAGE)
        MAX_CHARACTERS_PER_AI_MESSAGE = settings.get('max_characters_per_ai_message', MAX_CHARACTERS_PER_AI_MESSAGE)
        TEMPERATURE = settings.get('temperature', TEMPERATURE)
        TOP_P = settings.get('top_p', TOP_P)
    
    # 2. Update System Messages
    msgs = data.get('messages', {})
    if msgs:
        GUARDRAILS = msgs.get('guardrails', GUARDRAILS)
        ROLE = msgs.get('system_role', ROLE)
        CHECKLIST = msgs.get('system_checklist', CHECKLIST)
        INSTRUCTIONS = msgs.get('system_instructions', INSTRUCTIONS)
        DETECTIVE_PHASE_PROMPT = msgs.get('detective_phase_prompt', DETECTIVE_PHASE_PROMPT)
        SUGGESTION_PHASE_PROMPT = msgs.get('suggestion_phase_prompt', SUGGESTION_PHASE_PROMPT)
        INITIAL_PROMPT = msgs.get('initial_prompt', INITIAL_PROMPT)
        # Note: 'welcome_message', 'disclaimer' are used by Frontend? Or here? 
        # If backend constructs welcome message, we need it. 
        # But currently frontend sends WELCOME_PROMPT.
        # This aligns with user request.

    _CONFIG_LOADED = True

    logger.info("System config loaded successfully.")
