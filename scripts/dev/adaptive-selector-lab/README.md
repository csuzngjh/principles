# Adaptive selector diagnostic

Owner-approved isolated synthetic protocol diagnostic for PRI-1141 / PRI-1122.
No production hooks, installation, governance writes, actor tasks or private conversations.

## Scope and execution

- Approved card: `docs/specs/PD-AA-PRI-1122-DECISIONS-GLM-EXPERIMENT-CARD-v0.1.md`.
- Original synthetic development data: `docs/specs/PD-AA-PRI-1122-DECISIONS-SYNTHETIC-DEV-v0.1.json`.
- Decision route: `respan/span-01-lite:free`, native Decisions API; no paid fallback.
- Selection route: ZAI `glm-5.3-flash`, existing PiAiRuntimeAdapter, free-form single completion path, zero retries/repair, max_tokens=512. A per-invocation transport closure rejects any additional send.
- Maximum 6 decision and 12 GLM requests, including failures; sequential, 30s/request, 10min/run. Explicit approval claim file is exclusive and never cleared automatically.
- Secrets resolve from environment references only. No keys in payloads/logs. Error diagnostics retain only bounded redacted fields. Synthetic fixture expectations are excluded from model input.

Build/test from this worktree's own dependencies:

```powershell
npm run build --workspace=@principles/core
node --test scripts/dev/adaptive-selector-lab/diagnostic.test.mjs
```

The already-consumed approval flag was `--execute-approved-20261106`. **Do not rerun it to obtain fresh quota.** The committed `APPROVAL-20261106-CLAIM.json` deliberately prevents another run. Never delete the claim or original evidence to rerun. New requests after a stop require the explicit bounded continuation approval, not unused numerical quota alone.

The initial approved CRLF data hash and Git's LF-normalized byte hash are both pinned in the loader. Their parsed data is identical; arbitrary edits are rejected. The old experiment retains the actual byte hash it used. No historical fixture/hash is overwritten to fix checkout portability.

## First run — stopped

On 2026-11-06 Asia/Shanghai (2026-11-05T16:09:17Z), the first decision request returned HTTP400 in 300ms. Exactly one decision attempt, zero GLM requests, no valid decision/selection outputs. Five samples were not attempted; C/D comparison is NOT RUN.

Original evidence: `docs/implementation-reports/aa-selector-experiments/2026-11-05T16-09-17-735Z/results.json`.

The original runner persisted HTTP status but discarded its error body. The exact server rejection reason is UNKNOWN and cannot be retroactively reconstructed from this record. After the stop, the runner was fixed to project bounded/redacted error code/message/type/param and retain local validation reason/stage. No new inference was used to validate that fix; fake-HTTP tests cover it. A second CLI launch refused at the existing approval claim; only public metadata was read, no second inference request was emitted.

Official API documentation accepts JSON/array state and noul questions and warns that provider-specific incompatibility can yield HTTP400 before upstream inference. That is a hypothesis class, not a proven cause here. Do not blame model intelligence, credentials, provider routing, latency or quota without the actual response evidence.

## Complexity and review

Added one isolated thin native Decisions client and local research evidence/one-run claim. Reused existing pi-ai completion and HTTP-fetch injection. No new production backend, public package export, database, worker, runtime flag or host behavior. Remove the research CLI to remove the capability; retain frozen evidence.

Two-axis independent review used Luna agents (read-only, no API calls). Spec axis found no acceptance blocker; Standards axis found missing error explanation and swallowed local reason. Both have fixes and regression coverage. Current diagnostic is an engineering delivery, not proof of selection quality, model-visible delivery or real behavioral improvement.
