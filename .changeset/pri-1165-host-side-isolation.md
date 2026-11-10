---
"@principles/install-layout": minor
---

PRI-1165: make PD's `openclawHome` follow OpenClaw's explicit state dir, and move the experiment instance's runtime cache into its root.

- `resolvePdHome()` now treats `OPENCLAW_STATE_DIR` as authoritative over `OPENCLAW_HOME` in production (matching OpenClaw) and requires it to stay inside the experiment root in experiment mode. Relative values are refused fail-closed (`openclaw_state_dir_not_absolute`; `openclaw_state_dir_outside_experiment`).
- `dev:console:experiment` now sets `XDG_CACHE_HOME=<root>/.cache` — OpenClaw's private SQLite snapshot staging root and rolling logs resolve through it instead of `%LOCALAPPDATA%\openclaw` — and `OPENCLAW_PROFILE=experiment` so the rolling log filename is namespaced. `%LOCALAPPDATA%\OpenClaw\locks` stays shared but is safe: lock files are keyed by the canonical state-db path.
