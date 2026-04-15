
from typing import Tuple
import helpers.config as config
from helpers.crud import get_exchange_count

def get_current_prompt(chat_session_id: str, db_connection) -> Tuple[str, int, str]:
    """
    Determines the current conversation phase and constructs the system prompt.
    Returns (full_prompt, retrieval_count, phase_name)
    phase_name is one of: "DETECTIVE", "SUGGESTION"
    """
    # 1. Auto-calculate exchange count
    exchange_count = get_exchange_count(chat_session_id, db_connection)

    # 2. Set mode based on history
    if exchange_count < config.MIN_EXCHANGES_BEFORE_SUGGEST:
        phase_instructions = config.DETECTIVE_PHASE_PROMPT
        retrieval_count = 5
        phase_name = "DETECTIVE"
    else:
        phase_instructions = config.SUGGESTION_PHASE_PROMPT
        retrieval_count = 15
        phase_name = "SUGGESTION"

    full_prompt = f"""<role>
{config.ROLE}
</role>

<phase>
{phase_instructions}
</phase>

<checklist>
{config.CHECKLIST}
</checklist>

<allowed_specializations>
{config.SPEC_PROMPT}
</allowed_specializations>

<instructions>
{config.INSTRUCTIONS}
</instructions>

<guardrails>
{config.GUARDRAILS}
</guardrails>
""".strip()

    return full_prompt, retrieval_count, phase_name
