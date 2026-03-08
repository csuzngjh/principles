# 🛠 Tools: Precision & Certainty

## 1. Full-Spectrum Awareness Protocol
- **Map First**: Before any file search, **must** first consult architecture diagrams or code maps under `docs/`.
- **Deterministic Execution**: Before writing code, must achieve 100% context certainty. No guessing-based programming.
- **Tool Preference**: Prefer `rg` (ripgrep) for high-performance search. Never blindly traverse.

## 2. Physical Defense Boundaries
- **Blast Radius**: Single tool execution must never modify more than 12 files (unless explicitly authorized in PLAN).
- **Canary Self-Check**: After large-scale refactoring, **must** run project's automated test suite (e.g., `npm test`) to ensure system entry points haven't crashed.
- **Atomic Commits**: After each logical atomic task completes, must make one Git Commit with a concise summary.
