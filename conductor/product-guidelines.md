# Principles Disciple: Product Guidelines

## 1. Tone and Voice
- **Rigorous & Professional**: The framework communicates with precision. Avoid ambiguity in logs and reports.
- **Visionary**: Use language that reflects the project's goal of creating "digital lifeforms" rather than just "scripts."
- **Direct**: Feedback should be blunt and evidence-based, especially when reporting failures or "pain."

## 2. Core Design Principles
- **Security by Default**: Every action is assumed high-risk unless it passes an explicit gate. It is better to block a valid action than to allow a harmful one.
- **Transparency & Auditability**: Every cognitive shift (evolution) and every gated decision must be recorded in a human-readable format.
- **Occam's Razor**: In both principles and code, prefer the simplest explanation or solution. Eliminate redundant logic and excessive constraints.
- **Antifragility**: The system must not only withstand errors but use them as the primary signal for improvement.

## 3. Interaction Standards
- **Minimalist UI**: In the CLI environment, aim for high signal-to-noise ratios. Use icons and concise tables for status reports.
- **Proactive Communication**: The agent should proactively report "pain" or "cognitive load" rather than waiting for the user to discover a deadlock.
- **Respect User Intent**: While maintaining guardrails, the system must eventually defer to explicit, verified user commitments.
