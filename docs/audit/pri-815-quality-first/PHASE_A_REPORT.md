# PRI_815_INFORMATION_FLOW_AB — Phase A Report

```text
BASE_SHA = d68f6406a1ec03a2c5bc9f454c730ba3af398dbc
SAFETY_NET_SHA = 071945d7 (PR #1742, merged 2026-09-13)
MODE = EXPLORATORY
INDEPENDENT_SOURCE_GROUPS = 21 (DEV 15 / CLEAN 6)
GENERATOR = glm-5.3 (ZAI coding endpoint; production channel)
GENERATOR_CONFIG = temp=0 maxTokens=8000 (identical for A/B/all stages)
ARM_SYSTEM_PROMPT_HASHES: A = a47db8f47552   B = bc47a6df83bd (delta = B_ADDENDUM pri815-b-addendum.v1 + 3 evidence payload blocks; per-call hashes in data/runs/*.json)
B_ADDENDUM = pri815-b-addendum.v1 (frozen after Phase 3 dev calibration)
REPEATS_PER_INPUT = 3 (paired: shared D/P outputs, scribe order interleaved)

W = 19   L = 1   T = 1   BOTH_BAD_GROUPS = 3
NET_ADVANTAGE = 85.7pp
SIGN_TEST = N/A_EXPLORATORY

STABILITY (deterministic classification from frozen scenarios):
  A: CONTRADICTION=6 MATERIAL_DRIFT=13 STABLE=0
  B: CONTRADICTION=8 MATERIAL_DRIFT=12 STABLE=0

DOWNSTREAM (scenario-gated proxy; production rulehost VM out of H1 scope):
  A: correct=20 blockMiss=0 overblock=0
  B: correct=20 blockMiss=0 overblock=0

TOKENS A = 901453   B = 1125622   DELTA = 24.9% (guard: <= +20%)  COST_EXCEPTION = YES

VALIDITY (deterministic validators, failures stay in denominator):
  A: 59 ok / 0 fail   B: 57 ok / 2 fail   aborted repeats (upstream, arm-symmetric): 4

PRIMARY_JUDGE = glm-5.3 (SAME FAMILY as generator — bias disclosed; mitigations: paired design, evidence-grounded rubric, deterministic validators + scenario classification)
GPT6_ADJUDICATION = NOT_RUN (no GPT6 access in this environment)
OWNER_CALIBRATION_PACKAGE = PREPARED (OWNER_BLIND_PAIRS.md, async)
OWNER_PROXY_CALIBRATION = NOT_RUN (no independent blind evaluator on this host)

SUBSETS: DEV {w=15 l=0 t=0}  CLEAN {w=4 l=1 t=1}

T1 PROVISIONAL-PASS CONDITIONS:
  1. PASS
  2. FAIL
  3. PASS
  4. PASS
  5. FAIL
  6. PASS

QUALITY_VERDICT = PROMISING
STABILITY_OBSERVED = REGRESSED (B-only contradiction groups = 5; validity A 59ok/0fail vs B 57ok/2fail; 6A/8B contradiction groups, both dominated by legitimate_exception wording variance)
FINAL = HOLD
```

## Per-group detail

| group | class | verdicts (r1/r2/r3) | group verdict | stab A | stab B | tokens A/B |
|---|---|---|---|---|---|---|
| G-manual_1788265732489_9ne | DEV | A/B/B | B_WIN | MATERIAL_DRIFT | MATERIAL_DRIFT | 45079/57262 |
| G-manual_1788268409354_vau | DEV | B/B/B | B_WIN | CONTRADICTION | MATERIAL_DRIFT | 44075/57349 |
| G-manual_1788415743052_os4 | DEV | B/B/B | B_WIN | CONTRADICTION | MATERIAL_DRIFT | 45276/58414 |
| G-manual_1788417947835_e99 | DEV | B/B/B | B_WIN | CONTRADICTION | MATERIAL_DRIFT | 48469/59211 |
| G-manual_1788424714466_wmn | DEV | B/B/B | B_WIN | MATERIAL_DRIFT | MATERIAL_DRIFT | 43584/52455 |
| G-manual_1788526359876_r5x | DEV | B/TIE/B | B_WIN | MATERIAL_DRIFT | MATERIAL_DRIFT | 48670/60818 |
| G-manual_1788578262338_kmp | DEV | B/B/B | B_WIN | MATERIAL_DRIFT | MATERIAL_DRIFT | 45631/58022 |
| G-manual_1788609453041_dtm | DEV | B/B/B | B_WIN | MATERIAL_DRIFT | MATERIAL_DRIFT | 47457/60877 |
| G-manual_1788610740431_xo5 | DEV | TIE/B/B | B_WIN | MATERIAL_DRIFT | CONTRADICTION | 46148/58337 |
| G-manual_1788612956754_9aa | DEV | B/A/B | B_WIN | JUDGE_INVALID | CONTRADICTION | 44858/57729 |
| G-manual_1789299059630_zqx | DEV | B/B/B | B_WIN | MATERIAL_DRIFT | CONTRADICTION | 50620/57857 |
| G-manual_1789398236238_04i | DEV | B/A/B | B_WIN | CONTRADICTION | CONTRADICTION | 48752/60317 |
| G-pain_host_038c29c53be340 | CLEAN | B/B/B | B_WIN | MATERIAL_DRIFT | CONTRADICTION | 41058/47566 |
| G-pain_host_432596aee54456 | CLEAN | A/A/A | A_WIN | MATERIAL_DRIFT | MATERIAL_DRIFT | 48414/58095 |
| G-pain_host_620a1683e2eeb7 | CLEAN | B/B/B | B_WIN | CONTRADICTION | CONTRADICTION | 39617/49579 |
| G-pain_host_6406fbff5ee282 | CLEAN | B/B/B | B_WIN | CONTRADICTION | CONTRADICTION | 44666/53036 |
| G-pain_host_85731899e27e6d | CLEAN | B/B/B | B_WIN | MATERIAL_DRIFT | MATERIAL_DRIFT | 42370/55632 |
| G-pain_host_cffdcb9f5d0257 | DEV | B/B/A | B_WIN | MATERIAL_DRIFT | CONTRADICTION | 41382/53560 |
| G-manual_1788920022087_pjz | DEV | B/B/BOTH_BAD | B_WIN | MATERIAL_DRIFT | MATERIAL_DRIFT | 32068/41003 |
| G-manual_1789317326914_sj6 | DEV | B/BOTH_BAD/B | B_WIN | MATERIAL_DRIFT | MATERIAL_DRIFT | 37431/48886 |
| G-pain_host_198b8c4d901b5b | CLEAN | BOTH_BAD/A/BOTH_BAD | TIE | INSUFFICIENT_REPEATS | INSUFFICIENT_REPEATS | 15828/19617 |

## Review-round corrections (2026-09-18, PR #1753)

- P1 (validator hard gate): judge eligibility previously tested `parsed`, letting a parseable-but-schema-invalid output be judged (and win). Regraded deterministically from run data: exactly 1 pair affected (G-manual_1788612956754_9aa r2, B output missing generatedAt, judge had awarded B) -> reclassified A_WIN by the SPEC §30 rule. Group verdict unchanged (B_WIN, 2/3). W/L/T unchanged.
- P2 (BOTH_BAD accounting): skipped generation-failure BOTH_BAD verdicts (4 pairs across the 3 incident-quarantined groups) were displayed in the table but not counted; BOTH_BAD_GROUPS corrected 0 -> 3.
- P2 (fail-loud manifest): build-sample-manifest now refuses to classify when the spike ab-inputs record is unreadable instead of silently treating everything as CLEAN.
- The 3 quarantined groups are merged back into this aggregate from the pre-incident snapshot (tokens/validity/stability preserved; verdicts re-derived from cached judgments) — see restore-quarantined-groups.mjs.

## Deviations & disclosures

- DATA INCIDENT (2026-09-17T23:04Z, disclosed): a report-tooling defect (importing run-ab.mjs for the B addendum constant executed its experiment driver) re-ran and overwrote the raw generation files of 3 groups (G-manual_1788920022087_pjz, G-manual_1789317326914_sj6, G-pain_host_198b8c4d901b5b) before the process was stopped. Original JUDGMENTS were cached and are unaffected; ALL statistics in this report come from the pre-incident snapshots (aggregate-runs.json + judgments-*.json + the frozen quality verdicts). The overwritten raws are quarantined in data/runs-incident-rerun/ and excluded from evidence. Root cause fixed: B_ADDENDUM moved to scripts/pri-815/b-addendum.mjs (import-safe).
- Judge is same model family as generator (all independent channels dead on this host). Disclosed per SPEC §19 preference violation; mitigated by paired design, frozen scenarios, deterministic classification, and deterministic validators.
- Downstream is a scenario-gated behavioral proxy, not the production rulehost VM (rule generation is Artificer scope, outside H1).
- COST_EXCEPTION: formation-level B tokens exceed A by 24.9% (guard <= +20%). Per SPEC §31/§U this is recorded; continuation judged by the gate with explicit Owner-Card disclosure.
- 2 DEV groups were partially observed during Phase 3 calibration (runs-dev); their Phase 4 verdicts come from the independent frozen-harness run.