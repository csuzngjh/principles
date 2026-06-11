# Spike-2 Design — Does Splitting the Distiller Actually Improve Abstraction?

> **Status**: Design (throwaway spike, NO production code)
> **Date**: 2026-06-11
> **Authorizes**: a second P-spike requested by the owner after Spike-1 (PRI-366) showed grounding alone did not raise abstraction.
> **Owns scoring/recommendation**: agent (not owner). Owner only runs the script with their models.

---

## 1. The precise question

Spike-1 compared **monolith-prompt with vs without axiom grounding** and found abstraction was ~equal (grounding's real wins were traceability, robustness, noise-rejection — all cheap, prompt-only). Spike-1 **did not test the split at all**.

The split's actual hypothesis is:

> In the monolith, one LLM call must do root-cause + distillation + taxonomy (produce `rule`/`implementation` with `triggerPattern`/`action`) at once. That **taxonomy pressure drags the "principle" toward rule-like specificity**. If we isolate distillation — give a dedicated stage ONLY the root cause + the 10 axioms, ask for ONE abstract principle, forbid any taxonomy/rule output — the principle should be **more abstract**, and the benefit should be **larger for weak models** (which can't juggle three jobs in one call).

Spike-2 tests exactly this, and **only this**.

---

## 2. Arms (reuse existing data + one new arm)

| Arm | Source | Status |
|-----|--------|--------|
| **Arm 1 — Monolith** | Spike-1 `baseline-*.jsonl` `kind:principle` text | already have |
| **Arm 2 — Grounded monolith** | Spike-1 `grounded-*.jsonl` | already have |
| **Arm 3 — Split distiller** | NEW: Stage A (root-cause only) → Stage B (isolated distiller) | this spike |

For real pains, **Arm 1 already exists in production** as `runs.output_payload` in `D:/.openclaw/workspace/.pd/state.db` — we reuse the actually-shipped monolith principle, no re-run needed for the baseline.

## 2.5 Corpus — REAL pain signals first (owner directive 2026-06-11)

Spike-1 used synthetic fixtures. Spike-2 uses **real pain signals** from the production DB for credibility, supplemented by a few synthetic only to cover axioms the real corpus doesn't exercise.

**Primary (REAL — headline conclusion is computed on these only):** pulled from `D:/.openclaw/workspace/.pd/state.db`, table `tasks` (`task_kind='diagnostician'`), reason in `diagnostic_json`, shipped output in `runs.output_payload`:

| Code | painId | source | summary | axiom |
|------|--------|--------|---------|-------|
| R1 | manual_1780787633659_8im5rx7t | code_review | PR#838 tests green but missed production-path side effects / unreachable high-confidence upgrade | T-03/T-05 |
| R2 | manual_1780799247483_e198d6c5 | openclaw | OpenClaw missed a valid review comment (recurring ERR-002) | T-08/process |
| R3 | pain_1780901574214_ee9bf61c | automatic_hook | tool edit failed on pain-evidence.test.ts | T-03/tooling |
| R5 | manual_1780931134915_tiuyvu0g | code_review | PR#852 CLI routing: pain retry dropped options, canary wrong handler, evidence wrong log path | T-02/design |
| R6 | manual_1781081305247_1ljln5z9 | manual | PRI-363 refactor behavior regression (stage enum change broke tests) | T-01/T-03 |
| R7 | manual_1781081347155_07o22nkt | manual | PRI-363 acceptance report inaccuracy (8 failures reported as passing) | T-03/honesty |
| R8 (optional, thin) | empathy_gfi_1780909080715 | user_empathy | GFI crossed threshold, matched "wrong" | tests defer behavior |

**EXCLUDE** (test/config noise, not real friction): `manual_1781061418032` (GLM config test), `manual_1781061594600` (PEAT-5 model test), `manual_1781075988258` (smoke test). **DEDUP**: R6 appears 6× and R7 2× in the DB (repeated dogfood creations) — use one each.

**Coverage caveat**: the real corpus skews to engineering-process/review-quality (T-01/02/03/05/08) and does NOT exercise T-04 (reversible), T-06 (simplicity), T-07 (minimal-change), T-09 (divide), T-10 (memory). To keep axiom coverage, **supplement** with the existing synthetic fixtures for those 5 axioms ONLY (`irreversible-change`, `over-engineering`, `blast-radius-too-large`, `no-task-division`, `no-memory-externalization`), clearly labeled `synthetic`. The GO/NO-GO headline is computed on the REAL subset; synthetic is secondary corroboration.

---

## 3. The two new prompts (Stage A + Stage B)

### Stage A — Root-Cause ONLY (no recommendations, no taxonomy)

System/instruction (throwaway, English; model may answer in zh per project bilingual norm):

```
You are a root-cause analyst. Given a pain signal (owner reason + evidence + conversation),
produce ONLY a root-cause analysis. Do NOT propose fixes, rules, prompts, or code.

Output strict JSON:
{
  "summary": "<one sentence: what happened>",
  "causalChain": ["Why-1 ...", "Why-2 ...", "... up to Why-5"],
  "rootCause": "People|Design|Assumption|Tooling: <the systemic root cause>",
  "rootCauseCategory": "People" | "Design" | "Assumption" | "Tooling",
  "confidence": 0.0-1.0
}
Output ONLY the JSON object. No prose, no markdown fences.
```

### Stage B — Isolated Distiller (the variable under test)

Input to Stage B = Stage A's JSON output + the 10 CORE_PRINCIPLES (from the registry). Crucially, Stage B **cannot emit rules/implementations/triggerPatterns** — that option does not exist in its schema, removing the taxonomy pressure.

```
You are a principle distiller. You are given a confirmed root-cause analysis and the 10
core axioms below. Produce exactly ONE principle that:
- generalizes BEYOND this specific incident (cross-scenario, reusable),
- is anchored to the single most relevant core axiom,
- is NOT a rule: do NOT mention specific files, tools, commands, regexes, or step-by-step actions.

CORE AXIOMS:
{T-01..T-10 id: name — statement}

Output strict JSON:
{
  "abstractedPrinciple": "<= 200 chars, abstract, reusable, no concrete artifacts>",
  "groundedOnCorePrincipleId": "T-0X",
  "rationale": "<why this principle addresses the root cause, 1-2 sentences>",
  "confidence": 0.0-1.0
}
Output ONLY the JSON object.
```

> Note: Stage B is deliberately forbidden from taxonomy. We are testing whether *removing* that pressure raises abstraction. We are NOT instructing it to "be more abstract than the monolith" or forcing `kind=principle` (that was Spike-1's circular flaw).

---

## 4. Metrics (one subjective by agent, three objective by script)

1. **Blind abstraction score 1-5** (agent-assigned, after results land). Same rubric as Spike-1 §"Abstraction Rating Scale". Agent scores Arm 1 vs Arm 3 principle text per fixture WITHOUT seeing which arm produced it (script anonymizes — see instruction).
2. **Rule-like leakage (objective, scripted)**: count concrete artifacts in the principle text — file names (`*.ts`, `auth`, `payment`), tool names (`edit_file`, `git push`, `read_file`), regex/`triggerPattern` fragments, SQL keywords, step verbs ("block", "intercept", "halt"). Lower = more abstract. This is the objective anti-circular counterpart to the 1-5 score.
3. **Axiom accuracy (scripted)**: does `groundedOnCorePrincipleId` match the fixture's intended axiom (or a defensible neighbor)? Reuse Spike-1's fixture→axiom map.
4. **Robustness/latency (scripted)**: parse failures, request errors, total latency for the 2-call chain (Stage A + B) vs the monolith's 1 call — to quantify the cost of splitting.

---

## 5. GO / NO-GO for the SPLIT (non-circular, set BEFORE running)

**Split GO** (build T-F + T-G) requires ALL of:
- Arm 3 average blind abstraction ≥ **Arm 1 + 0.7** (a real, not marginal, lift), AND
- Arm 3 rule-like-leakage materially lower than Arm 1 (objective corroboration), AND
- the lift is **larger for the weak model (qwen3.6-27b) than the strong model (deepseek-v4-flash)** — i.e. the split helps exactly where the monolith is weakest, AND
- Stage A root-cause quality does not regress vs the monolith's rootCause field.

**Split CONDITIONAL GO** allows T-E/T-F/T-G implementation work to continue, but does **not** authorize production cutover, when:
- the real-pain subset shows a large Arm 3 abstraction lift, but only one model was available, OR
- the comparison may be confounded by language/style differences between Arm 1 and Arm 3, OR
- CodeRabbit/reviewer findings on the spike harness are still being addressed.

Conditional GO must be carried into T-H as explicit unresolved validation risk. T-H must remove the confound by controlling `principles.outputLanguage` and, where possible, running at least one weak and one stronger model.

**Split NO-GO** (ship only async + grounding + Q2 unify; defer T-F/T-G) if:
- abstraction is roughly equal (Arm 3 within ±0.5 of Arm 1), OR
- any lift appears only on the strong model (then the split doesn't solve the weak-model problem it was justified by), OR
- the 2-call latency/robustness cost is severe with no abstraction payoff.

**Confound to note when scoring**: Arm 3 uses two calls / more tokens than Arm 1. If Arm 3 wins, sanity-check the win comes from *isolation* (cleaner single-job prompt) and not merely "more compute" — e.g. by checking whether the monolith's own `principle` recommendation was already as abstract when its other recommendations were ignored.

**Language confound to note when scoring**: If Arm 1 output is Chinese and Arm 3 output is English, abstraction ratings may be biased by phrasing style rather than real generality. Final production validation must compare outputs under the same owner language preference. The implementation path must preserve `principles.outputLanguage`; a split runner that produces better abstraction in the wrong language is not acceptable.

---

## 6. Instruction for the executing AI (build + run only; no production code)

> **Scope**: throwaway spike, mirror the existing `spike-*.ts` pattern in this folder. Do NOT touch `packages/`. Do NOT mark any Linear ticket Done on the basis of this — it produces data for the agent to score.
>
> **Build** `docs/plans/2026-06-diagnostician-split/spike2-load-real-pains.cjs`:
> - Open `D:/.openclaw/workspace/.pd/state.db` READ-ONLY (better-sqlite3).
> - Select the 6 real diagnostician tasks R1,R2,R3,R5,R6,R7 by the exact `task_id`s in §2.5 (and optional R8). For each, read `diagnostic_json` (pain reason/evidence/source) → build a fixture object matching the existing `SpikeFixture` shape; ALSO read the latest `runs.output_payload` for that `task_id` and store its `kind:principle` `abstractedPrinciple` as the **Arm 1 (production monolith)** baseline for that pain.
> - Write these to `spike-fixtures-real/*.json`. Do NOT modify the production DB.
> - Also copy the 5 coverage synthetic fixtures (T-04/T-06/T-07/T-09/T-10 only) labeled `synthetic`.
>
> **Build** `docs/plans/2026-06-diagnostician-split/spike2-split-prompt.ts`:
> - `buildRootCausePrompt(fixture)` → Stage A prompt (§3).
> - `buildDistillerPrompt(rootCauseJson)` → Stage B prompt (§3), importing `CORE_PRINCIPLES` from the registry (no hardcoding).
>
> **Build** `docs/plans/2026-06-diagnostician-split/spike2-run.ts`:
> - For each fixture × model: call Stage A, parse JSON, feed into Stage B, parse JSON. Record both raw outputs, latencies, parse/request errors.
> - For REAL fixtures, Arm 1 = the stored production `abstractedPrinciple` (no re-run). For synthetic fixtures, Arm 1 = re-run the monolith baseline prompt (as Spike-1 did).
> - Compute the scripted metrics (§4.2 rule-like leakage, §4.3 axiom accuracy, §4.4 robustness).
> - Emit an **anonymized scoring sheet** `spike-results/spike2-blind-scoring.md` that lists, per pain, the Arm 1 principle and the Arm 3 principle in randomized A/B order (label only "Option A"/"Option B", keep the mapping in `spike-results/spike2-key.json`) so the agent can score abstraction blind. Mark each row `real` or `synthetic`.
> - Emit `spike-results/spike2-summary.json` with all scripted metrics per model/arm, separating REAL vs synthetic aggregates.
>
> **Models**:
> - Weak: LM Studio `qwen3.6-27b-mtp` (local, the one already used).
> - Strong: `deepseek-v4-flash` via its **OpenAI-compatible** endpoint (prefer OpenAI API over the Claude-compatible one). Read base URL / token from env; do NOT hardcode secrets.
>
> **Run**: `npx tsx docs/plans/2026-06-diagnostician-split/spike2-run.ts`. On completion, post a Linear comment on PRI-366 listing files written, and notify the agent.
>
> **Hand back to agent**: `spike2-summary.json` + `spike2-blind-scoring.md` (+ keep `spike2-key.json`). The agent does the blind abstraction scoring and writes the final GO/NO-GO into `04-distiller-spike-report.md`.

---

## 7. What the agent does after results land

1. Score abstraction 1-5 blind from `spike2-blind-scoring.md`, then de-anonymize via `spike2-key.json`.
2. Combine with scripted metrics; evaluate against §5 criteria.
3. Write the final split GO/NO-GO + rationale into `04-distiller-spike-report.md` and report the single business decision to the owner.
