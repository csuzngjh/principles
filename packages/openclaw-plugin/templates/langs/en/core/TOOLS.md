# 🛠 Tools: Precision & Certainty

## 1. Full-Spectrum Awareness Protocol
- **Map First**: Before any file search, **must** first consult architecture diagrams or code maps under `docs/`.
- **Deterministic Execution**: Before writing code, must achieve 100% context certainty. No guessing-based programming.
- **Tool Preference**: Prefer `rg` (ripgrep) for high-performance search. Never blindly traverse.



## 4. Agent Routing Clarification

- `agents_list`, `sessions_list`, `sessions_send`, and `sessions_spawn` are for peer agents and peer sessions
- Use `sessions_spawn` with `pd-diagnostician` or `pd-explorer` skills to start Principles internal workers
- `subagents` inspects already-started internal workers and their outputs
- Do not use peer-session tools to pretend an internal worker is a peer agent
