# PROMPT_V1_BASELINE — PD-SPEC-001 Phase 0

> V1 = the real production prompt state at base commit `0485046e71d2aeba4769725adb4f2aac35a5dd9b` (origin/main; primary checkout HEAD `2927acefa` was 12+ commits behind — the worktree base is authoritative for V1/V2).
> Runtime prompt snapshots + SHA-256: `experiment/prompt-v2/baseline/prompt-hashes.json` and `runtime-prompts/*.txt` (18 variants, dumped from the worktree DIST build with a clean-tree assertion).

## 1. Prompt builders (V1 source of truth)

| Agent | Builder | Instruction entry point |
|---|---|---|
| RootCause (Stage A) | `packages/principles-core/src/runtime/diagnostician/rootcause-prompt-builder.ts` | `buildRootCauseProtocolInstruction()` |
| Distiller (Stage B) | `.../diagnostician/distiller-prompt-builder.ts` | `buildDistillerProtocolInstruction()` |
| Router (Stage C) | `.../diagnostician/router-prompt-builder.ts` | `RouterPromptBuilder.buildRouterInstruction()` |
| Dreamer | `.../internalization/dreamer-prompt-builder.ts` | `buildDreamerProtocolInstruction()` |
| Philosopher | `.../internalization/philosopher-prompt-builder.ts` | `buildPhilosopherProtocolInstruction()` |
| Scribe | `.../internalization/scribe-prompt-builder.ts` | `buildScribeProtocolInstruction()` |

Shared prompt machinery: `adapter/schema-prompt-adapter.ts` (schema-derived `COMPLETE EXAMPLE OUTPUT` + `CONSTRAINTS`), `core-principles/core-axiom-block.ts` (T-01..T-10), `language-directive.ts` (optional output-language directive appended when configured).

## 2. Effective runtime system prompt

```
mergeSystemPromptLayers(builderBaseSystemPrompt, profileConfigSystemPrompt)
```
(`adapter/pi-ai-runtime-adapter.ts:854`) — the builder's instruction is the base layer; the runtime profile's configured `systemPrompt` is the append layer. The adapter reports `runHandle.systemPromptDigest` (SHA-256 of the merged effective prompt); the Router receipt binds this digest (`diag-router-runner.ts:460-467`). **V1/V2 A/B must run with identical profile config so the only delta is the builder base layer.**

Message payload = `JSON.stringify(promptInput)` per stage (structures in §4); Stage B/C inputs additionally pass through the budget-conditional projection (`diagnostician/prompt-projection.ts` — deterministic P1/P2 text trimming, fires only when the estimated input exceeds the model's budget; identical code in both arms).

## 3. Dynamic injection matrix (V1)

| Injection | Gated by | Default | Effect on prompt |
|---|---|---|---|
| Core Axioms (T-01..T-10) | flag `diagnostician_core_grounding` (`feature-flag-contract.ts:256`) | **ON** | PHASE 3.5 (RootCause), CORE AXIOMS section (Distiller/Dreamer/Philosopher/Scribe) |
| PHASE 3.6 Intent Tension + `intentDoc` payload | flag `intent_engineering` (`:288`) | OFF | block + INTENT.md text |
| Evidence First Attribution rules | flag `pain_diagnosis_persistence` (`:394`) | OFF | attribution rules after PHASE 3 list |
| PHASE 1.5 Owner Correction | presence of `diagnosisTarget.correctionEvidence` on the pain | per-pain | verbatim quote block, `sourceRef "owner_correction"` |
| ANCHOR block | presence of `diagnosisTarget.anchor` | per-pain | anchor requirement block |
| Scribe FORMATION_EVIDENCE_ADDENDUM | presence of `formationContext` (PRI-838) | per-run | frozen PRI-815 candidate-priority addendum |
| Router `validationFeedback` | fresh validator errors from previous attempt (P1-3) | retry-only | repair feedback in payload (never system prompt) |
| `trustedContext` | system-owned allowlist / typed unavailable | always (payload) | Router payload field, never in system prompt |

Flag wiring: `diag-rootcause-runner.ts:180-182` reads all three flags via `computeFeatureFlagsFromConfig`.

## 4. Message payload structures (per stage, `JSON.stringify(promptInput)`)

- **Stage A**: `{taskId, contextHash, diagnosisTarget, conversationWindow, sourceRefs, context, [truncationWarnings], [intentDoc]}` — conversation window truncated per `DEFAULT_PROMPT_BUILDER_LIMITS` with overflow shrink (rootcause-prompt-builder.ts:476-497).
- **Stage B**: `{rootCauseArtifactId, rootCauseOutput}`.
- **Stage C**: `{taskId, rootCauseArtifactId, rootCauseOutput, distillerArtifactId, distillerOutput, trustedContext, [validationFeedback]}`.
- **Dreamer**: `{taskId, contextHash, contextRefs, predecessorOutput}`.
- **Philosopher**: `{taskId, contextHash, dreamerArtifact, sourceDreamerArtifactId}`.
- **Scribe**: `{taskId, contextHash, sourcePhilosopherArtifactId, [sourceDreamerArtifactId], philosopherArtifact, [formationContext], promptContractVersion}` — version at V1: `scribe-output-v1.prompt.v10`.

## 5. Output validation chain (both arms identical, frozen)

```
model raw text → adapter parse → Value.Check(REGISTRY[outputSchemaRef])   [pi-ai-runtime-adapter.ts:1073]
              → (fail) structured-output repair loop (≤ maxRepairAttempts, budget-gated)
              → runner postFetchTransform (Router: rootCause/evidence/confidence/abstractedPrinciple/intentTension authority)
              → runner validateOutput (semantic validators)
```

## 6. Confirmed V1 defect hypotheses (SPEC Part III premises, now evidenced)

1. **Router** — prompt says the system auto-fills `rootCause`/`evidence`/`confidence` (router-prompt-builder.ts:272-275) and never asks for `diagnosisId`; the adapter gate requires both before any transform (`pi-ai-runtime-adapter.ts:1073` + `diagnostician-output.ts:161-190`). Observed failure class: repeated schema rejections (referenced at `diag-router-runner.ts:323-326`, 2026-11-12 experiment).
2. **Distiller** — schema-prompt adapter hardcodes example `groundedOnCorePrincipleIds: ["T-01"]` (`schema-prompt-adapter.ts:74-81`) even when the axiom list is not supplied; registry validation passes T-01, so unsupported grounding is structurally invisible.
3. **Dreamer** — "for each identified root cause, generate 1-5 candidates" (`dreamer-prompt-builder.ts:84`) vs schema global `maxItems: 5` (`dreamer-output.ts:71`).
4. **Scribe** — OUTPUT FORMAT example always shows one fully-populated `requiredFacts` entry (scribe-prompt-builder.ts:143-149); SPEC V2 default example is `{"version":1,"requiredFacts":[]}`.
5. **RootCause** — PHASE 2 asks for Why-1..Why-5 with "Stop early if you find a directly fixable problem", but also "If no evidence is available for a Why level, reference the closest available evidence" — nudges citation-stretching to fill levels; V2 tightens to evidence-bounded stopping.
6. **Philosopher** — current protocol only synthesizes ("distill a principle candidate from the Dreamer's analysis", lines 80-88); no instruction to challenge/reject weak candidates or handle conflicts.

## 7. Model / runtime configuration

Recorded in `model-config.json`. Production workspace: `D:\.openclaw\workspace`. All six agents run profile `pi-ai.amd-ds-vision` (provider `openai`-compatible / model `GLM-5.3-Flash` / `AMD_RADEON_API_KEY` / maxTokens 16384 / timeout 600000ms). **Production flag overrides verified:** `pain_diagnosis_persistence=true` (Evidence First Attribution block IS active in production prompts; matches 83 persisted pain_diagnoses rows), `diagnostician_llm_degradation=false`; `intent_engineering` stays off. A/B pins both arms to these production values. No temperature/top-p/seed fields exist in PD runtime config — recorded as a randomness limitation, mitigated by §4.6 repeat runs.

## 8. Reproducibility

- V1 prompt snapshot command: `node .tmp/prompt-v2-baseline/dump-v1-prompts.mjs` (worktree, clean tree at base commit).
- V1 rebuild for missing historical outputs (SPEC §4.2): run the SAME pipeline code at base commit `0485046e7` against frozen inputs — the worktree branch prior to the V2 commits is exactly this state (V2 lands as later commits on `ai/adhoc-20261115-prompt-v2-k4wz9t`).
