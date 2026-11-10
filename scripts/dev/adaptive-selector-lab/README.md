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

## Identical follow-up diagnosis (2026-11-06)

Owner approved one identical free request only. The same payload hash returned HTTP400 with a specific provider constraint: Respan accepts a string state (or its narrow input/output message object), not the generic array envelope we used. See `PD-AA-PRI-1141-DECISIONS-ROOT-CAUSE-20261106.md` and the independent `2026-11-05T23-27-54-181Z-one-diagnostic/results.json`.

The main builder now sends the identical context as a JSON string. A regression first failed with the old array, then 25 tests passed with the fix. Real calls remain cumulative decision2 / GLM0; no successful live acceptance is claimed. The separate one-diagnostic command deliberately reconstructs the original array payload and cannot be rerun under its consumed claim. A corrected continuation requires approval; proposed remaining scope is dev-01..04, max4 decision +8 GLM, not a reset of the original budget.

## Final bounded run completed

Owner approved the remaining 3 Decisions +6 GLM attempts for dev-02..04 and catalog-proven canonical aliases. The `--execute-approved-final-three` run completed: all nine requests HTTP200; C and D made identical choices, each matching 2/3 of the frozen allowed sets. Cumulative attempts remain decision6 / GLM6, including prior failures. No further real calls are authorized by these consumed flags/claims.

See `PD-AA-PRI-1141-FINAL-DIAGNOSTIC-20261106.md` and the immutable `2026-11-05T23-45-11-762Z/results.json` plus `analysis.json`. The canonical model comes from the selected free catalog row, not guessed suffixes. No generalized accuracy, behavioral improvement, gating savings or production activation claim follows from this small synthetic diagnostic.

## PRI-1122 single-model selection arm (offline)

`orchestrator.mjs` adds an isolated two-mode opportunity runner over the REAL Runtime V2 Reader and the REAL shared assembly: `native` (zero model sends) and `single-model` (one generic-model reference, then PD revalidation + additive assembly). The generic model only returns `{status, id, digest}`; it never owns authorization, revision, dedup, budget or final text.

```powershell
node --test scripts/dev/adaptive-selector-lab/orchestrator.test.mjs
node scripts/dev/adaptive-selector-lab/orchestrate.mjs --mode native --workspace <seeded-workspace>
```

`orchestrate.mjs` refuses a real call without `--execute-approved-20261110` and the credential env, and this delivery has not issued one. Offline evaluation drives the real `PiAiRuntimeAdapter` through `--fixture-response`. Frozen cases, budget card and the NOT RUN report live under `docs/specs/PD-AA-PRI-1122-SINGLE-MODEL-*` and `docs/implementation-reports/PD-AA-PRI-1122-SINGLE-MODEL-SELECTOR-20261110.md`. The historical CLI, fixtures, hashes and consumed approval claims above are unchanged.

