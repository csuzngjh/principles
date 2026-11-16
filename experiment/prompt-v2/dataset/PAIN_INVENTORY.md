# PAIN_INVENTORY — PD-SPEC-001 Phase 0c

> Machine-readable full inventory: `pain-inventory.json` (same directory).
> Source: PRODUCTION workspace `D:\.openclaw\workspace`, accessed strictly read-only via consistent SQLite backup snapshots (SPEC §5.4).
> Snapshot integrity: source and snapshot both `integrity_check = ok`; all 11 audited tables count-match (106 pain_events, 1509 tasks, 2269 runs, 1266 pi_artifacts, 247 principle_candidates, 83 pain_diagnoses, 0 dead_letter_pains).
> Snapshot SHA-256: state.db `f25c8fabb40e8406d614dcb90e9de73bf489ea5320f9e9e39bab3ee803d1c4e8`, trajectory.db `4dcb401e79b14bc4caf40e694941c71f88f8b79db4a66ecabffbe2037a97b6b5` (at `.tmp/prompt-v2-inventory/snapshot/`, worktree-local).

## 1. Persistence reality (verified, no assumed table names)

There is NO `pains` table. Real storage:
- `trajectory.db → pain_events` (authoritative pain events; writers: production-pain-evidence.ts, governance-signal-admission.ts, openclaw-plugin trajectory.ts)
- `state.db → tasks` (diagnosis tasks `diagnosis_<painId>` + stage tasks `diag_rootcause-/diag_distiller-/diag_router-diagnosis_<painId>` + formation tasks `<agent>-<candidateId>-<channel>`)
- `state.db → pain_diagnoses` (83 rows; pain_id ↔ diagnosis linkage, category, root_cause, confidence)
- `state.db → pi_artifacts` (all stage outputs; `principle_candidates.task_id` references the ROUTER task id — discovered empirically, initial join on the bare diagnostician id returned zero)
- `state.db → principle_candidates` (247; per-recommendation candidates), `runs` (per-attempt records), `dead_letter_pains` (0)

## 2. Inventory totals (106 real pain events)

| Dimension | Count |
|---|---|
| Total pain_events | **106** |
| — source=user_correction | 52 |
| — source=manual | 33 |
| — source=llm_paralysis | 19 |
| — source=tool_failure | 1 |
| — source=user_empathy | 1 |

### Pipeline outcome classes (categories may overlap; classifier in `build-inventory.mjs`)

| Class | Count | Meaning |
|---|---|---|
| Successful (full chain incl. scribe) | **66** | diagnosis → router → candidates → dreamer/philosopher/scribe all reached success |
| Successful-NoFormation | 5 | diag chain succeeded (router OK) but no formation completed |
| Failed | 10 | diagnostician or a stage task ended `failed` |
| Needs Evidence (heuristic regex) | 1 | reason/root_cause mentions insufficient evidence — to be re-verified manually at selection |
| Undiagnosed | 25 | pain event exists, no `diagnosis_*` task ever created (pre-split era / not admitted / deduped) |
| Has Candidates | 71 | ≥1 principle_candidates row (avg ≈3.5 candidates per diagnosed pain: principle+rule+implementation pattern) |

### Failure forensics (the 10 Failed)

`pain_host_*` cluster confirmed (SPEC §2.3 hint verified): failure reasons are the `timeout` class (root-cause run aborted after 3 attempts — verbatim provider messages are held only in the local full-fidelity copy, published here as failure CLASS per the public-repo redaction policy) and `lease_conflict` — i.e. **environment/timeout class, not prompt-content class**. Their V1 outputs do not exist; per SPEC §4.2 they enter the A/B via the frozen-V1-prompt rebuild path (not by faking historical outputs).

### SPEC-named historical records

- `manual_1787215181354_339nethw`: **NOT PRESENT** in the production trajectory.db (LIKE query, 0 rows). Recorded as not-found here; not fabricated (SPEC §2.3 forbids assuming existence).
- `pain_host_*` diagnostic failures: present and re-verified as above.

## 3. Experiment usability (SPEC §2.3 report fields)

| Usability | Count | Basis |
|---|---|---|
| Usable for full-chain A/B | 71 + (subset of 10 failed via V1-rebuild) | 66 with complete V1 formation evidence + 5 diag-complete/no-formation; failed ones re-run in both arms |
| Usable for per-agent A/B (Stage A) | 81 diagnosed (context recoverable, see §4) + candidate picks from 25 undiagnosed as fresh-input cases | |
| Usable for per-agent A/B (Stages B–F) | 81 (Stage A artifacts persisted) → distiller; 71 router-complete → router/formation inputs | inputs reconstruct from pi_artifacts |
| Not recoverable full context | to be confirmed at dataset freeze (per-sample check of trajectory session data) | |
| Excluded | 0 hard exclusions so far; dead_letter=0 | final exclusions recorded per-sample in DATASET_SELECTION.md |

Multi-cause / Duplicate-risk classification is semantic, not mechanical — regex pre-scan found no multi-cause markers; both dimensions are judged at evaluation time from artifacts (ambiguityNotes, ledger overlap), per SPEC §6.4.

## 4. Input recoverability for paired A/B (critical enabler, verified)

| Stage | V1 exact input persisted? | Recovery path |
|---|---|---|
| Router (Stage C) | **YES** — `runs.input_payload` 17KB per succeeded run (P2-01 persistence at base commit) | direct read |
| Distiller (Stage B) | no | `pi_artifacts` Stage A output + artifact id — deterministic |
| RootCause (Stage A) | no | rebuild `DiagnosticianContextPayload` with production `SqliteContextAssembler` on the trajectory snapshot + `tasks.diagnostic_json` (persisted diagnosisTarget WITH evidence array, sessionIdHint, provenance, hostKind) |
| Dreamer / Philosopher / Scribe | no | reconstruct from `pi_artifacts` chain (router output → dreamer → philosopher; scribe formationContext = dreamer artifacts + source diagnosis) |

Consequence: per-agent A/B pairing is exact for B/C stages (identical frozen upstream inputs); Stage A inputs are deterministically rebuilt with production assembly code and identical across arms (V1-rebuild vs V2 share the same rebuilt payload — SPEC §4.2/§4.4 satisfied; no synthetic pain constructed anywhere).

## 5. Production environment facts bearing on the experiment

- Production flags: `pain_diagnosis_persistence=true` (Owner override; Evidence First Attribution ACTIVE), `diagnostician_llm_degradation=false`, `intent_engineering=false`, `diagnostician_core_grounding=true`.
- Production model: `GLM-5.3-Flash` via AMD OpenAI-compatible endpoint for all six agents (see `baseline/model-config.json`).
- trajectory.db was captured with a hot 4.1MB WAL; the backup API read through it consistently (integrity ok, counts match) — raw file copies were NOT used.

## 6. Scripts

- `.tmp/prompt-v2-inventory/snapshot-and-discover.mjs` — snapshot + integrity + counts + schema discovery
- `.tmp/prompt-v2-inventory/build-inventory.mjs` — per-pain aggregation + classification → `pain-inventory.json`
