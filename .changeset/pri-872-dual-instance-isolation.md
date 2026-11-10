---
"@principles/install-layout": minor
"create-principles-disciple": patch
---

PRI-872: add a fail-closed PD home contract so a second (experiment) instance can run on the same user account without touching the production installation.

- `resolvePdHome()` / `PD_EXPERIMENT_ROOT` (install-layout): the single authority for "which PD home does this process own". Production keeps the historical `os.homedir()` derivation; an experiment root derives `.pd`, `.pd-console`, `.openclaw` and `.codex` under itself. Unusable values (empty, relative, missing, not a directory, overlapping `~/.pd`/`~/.pd-console`/`~/.openclaw`, or a derived path linked outside the root) return a structured refusal — never a silent fallback to the real user home.
- `create-principles-disciple`: the detached bootstrap executor resolves its PD home through the same contract, so an experiment console's update transaction can never target the production runtime.
- pd-console: every user-level path (workspace registry, update page/history, bootstrap executor lookup, backups, gateway config) now derives from that resolution instead of `os.homedir()`; an experiment instance defaults to console port 13100, refuses product updates (`experimental_instance`) and refuses machine-level `openclaw gateway stop|start` (its gateway is a foreground `openclaw gateway run` owned by the launcher). New `npm run dev:console:experiment -- --root <abs dir>` starts the isolated instance with port preflight and child-process lifecycle.
