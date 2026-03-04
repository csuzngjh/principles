# Product Guidelines

## Tone and Prose Style
- **Helpful & Guiding**: Interactions should focus on providing guidance, suggestions, and collaborative assistance to the user. The agent acts as a peer programmer, offering constructive insights while executing tasks.

## Error Handling
- **Interactive Guidance**: When encountering errors, policy violations, or blocked actions, the system should not just fail silently. It must explain the error clearly and offer actionable suggestions or workarounds for the user to resolve the issue.

## User Interaction and Verbosity
- **Verbose Logging**: The system should provide detailed explanations of the steps it is taking and the decisions it makes. Transparency is key, ensuring the user always understands the "why" and "how" behind the agent's actions.

## Core Design Principles
- **Maximum Autonomy**: The architecture should allow the agent maximum freedom to explore, formulate strategies, and implement solutions independently, reducing the need for constant micro-management from the user while remaining within the defined guardrails.