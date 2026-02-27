
from typing import Tuple
import helpers.config as config
from helpers.crud import get_exchange_count

def get_current_prompt(chat_session_id: str, db_connection) -> Tuple[str, int]:
    """
    Determines the current conversation phase and constructs the system prompt.
    Returns (full_prompt, retrieval_count)
    """
    # 1. Auto-calculate exchange count
    exchange_count = get_exchange_count(chat_session_id, db_connection)

    # 2. Set mode based on history
    if exchange_count < config.MIN_EXCHANGES_BEFORE_SUGGEST:
        phase_instructions = config.DETECTIVE_PHASE_PROMPT
        retrieval_count = 1 
    else:
        phase_instructions = config.SUGGESTION_PHASE_PROMPT
        retrieval_count = 8

    # 3. Construct full prompt
    full_prompt = f"""
{config.GUARDRAILS}

{config.ROLE}

{phase_instructions}

{config.CHECKLIST}

{config.INSTRUCTIONS}

{config.SPEC_PROMPT}
""".strip()

    return full_prompt, retrieval_count
