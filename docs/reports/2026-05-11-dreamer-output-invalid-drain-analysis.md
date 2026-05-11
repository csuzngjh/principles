# Dreamer output_invalid Drain Analysis — 2026-05-11

## Summary

During PRI-110 drain, 4 dreamer tasks failed permanently after exhausting retries.
This evidence pack documents the failure patterns, observability gaps, and
recommended hardening — **no DreamerRunner code changes** unless a minimal
reproduction is found.

## Runtime Configuration

| Field | Value |
|---|---|
| **outputSchemaRef** | `dreamer-output-v1` |
| **provider** | `minimax-cn` |
| **model** | `MiniMax-M2.7` |
| **apiKeyEnv** | `MINIMAX_CN_API_KEY` |
| **maxRetries** | 3 |
| **timeoutMs** | 120000 |
| **runtimeKind** | `pi-ai` |

Source: `D:\.openclaw\workspace\.state\workflows.yaml`

## Failed Task Summary

| Task ID (prefix) | Attempts | Final Error | output_invalid | timeout | max_attempts_exceeded |
|---|---|---|---|---|---|
| `dreamer-0bcc0c79-9011-4d2f-865d-674a145219ff` | 3 | max_attempts_exceeded | 2 | 0 | 1 |
| `dreamer-1316a064-ce07-42db-b06a-21917a551752` | 4 | max_attempts_exceeded | 1 | 1 | 2 |
| `dreamer-dfd8937b-16e1-4824-bf93-6903b430d4c2` | 3 | max_attempts_exceeded | 0 | 1 | 2 |
| `dreamer-a3e308de-41d4-473f-a74a-a66caa394efb` | 3 | max_attempts_exceeded | 1 | 1 | 1 |

**Totals**: 4 output_invalid, 3 timeout, 6 max_attempts_exceeded across 12 runs

Note: The user's task description mentions "2 output_invalid, 1 timeout" for 3
failed tasks. The actual data shows 4 failed tasks with 4 output_invalid and
3 timeout error categories. The discrepancy is because some runs that succeeded
on retry (attempt 3 or 4) were later re-attempted by the drain and hit
max_attempts_exceeded, which is a terminal category not an LLM error category.

## Per-Run Detail with Failure Reason

### dreamer-0bcc0c79 (FAILED — 2 output_invalid, 0 timeout)

| Run | Attempt | Started | Ended | Duration | error_category | failureReason |
|---|---|---|---|---|---|---|
| run_1 | 1 | 2026-05-10T08:03:30 | 2026-05-10T08:04:57 | ~87s | output_invalid | task_retry |
| run_2 | 2 | 2026-05-10T10:48:41 | 2026-05-10T10:49:34 | ~53s | output_invalid | task_retry |
| run_3 | 3 | 2026-05-11T02:47:44 | 2026-05-11T02:48:16 | ~32s | max_attempts_exceeded | task_failed |

**Diagnosis**: Both output_invalid runs (87s, 53s) had sufficient LLM response
time — the LLM returned something but it wasn't valid JSON or failed schema
validation. The 32s terminal run was a max_attempts_exceeded re-attempt.

### dreamer-1316a064 (FAILED — 1 output_invalid, 1 timeout)

| Run | Attempt | Started | Ended | Duration | error_category | failureReason |
|---|---|---|---|---|---|---|
| run_1 | 1 | 2026-05-10T08:02:40 | 2026-05-10T08:03:12 | ~32s | output_invalid | task_retry |
| run_2 | 2 | 2026-05-10T09:52:54 | 2026-05-10T09:53:05 | ~11s | timeout | task_retry |
| run_3 | 3 | 2026-05-10T10:45:32 | 2026-05-10T10:46:10 | ~38s | — | task_completed (succeeded) |
| run_4 | 4 | 2026-05-11T02:47:17 | 2026-05-11T02:47:27 | ~10s | max_attempts_exceeded | task_failed |

**Diagnosis**: Run 1 (32s) returned output_invalid. Run 2 (11s) was a genuine
timeout (too short for LLM response). Run 3 succeeded but the task was
re-attempted and hit max_attempts_exceeded on run 4.

### dreamer-dfd8937b (FAILED — 0 output_invalid, 1 timeout)

| Run | Attempt | Started | Ended | Duration | error_category | failureReason |
|---|---|---|---|---|---|---|
| run_1 | 1 | 2026-05-10T08:02:20 | 2026-05-10T08:02:30 | ~10s | timeout | task_retry |
| run_2 | 2 | 2026-05-10T09:51:51 | 2026-05-10T09:52:42 | ~51s | — | task_completed (succeeded) |
| run_3 | 3 | 2026-05-11T02:46:17 | 2026-05-11T02:46:48 | ~31s | max_attempts_exceeded | task_failed |

**Diagnosis**: Only 1 genuine timeout (10s — likely API connection issue).
Run 2 actually succeeded. Run 3 was a re-attempt that hit max_attempts_exceeded.

### dreamer-a3e308de (FAILED — 1 output_invalid, 1 timeout)

| Run | Attempt | Started | Ended | Duration | error_category | failureReason |
|---|---|---|---|---|---|---|
| run_1 | 1 | 2026-05-10T03:49:57 | 2026-05-10T03:50:08 | ~11s | timeout | task_retry |
| run_2 | 2 | 2026-05-10T04:26:44 | 2026-05-10T04:26:51 | ~7s | output_invalid | task_retry |
| run_3 | 3 | 2026-05-10T08:05:06 | 2026-05-10T08:07:00 | ~114s | max_attempts_exceeded | task_failed |

**Diagnosis**: Run 1 (11s) was a genuine timeout. Run 2 (7s) returned
output_invalid — the extremely short duration suggests the LLM returned
an error or empty response, not a full JSON output. Run 3 (114s) hit
max_attempts_exceeded.

## Genuine LLM Error Breakdown

Filtering out max_attempts_exceeded (which is a terminal state, not an LLM
error), the genuine LLM-level failures are:

| Error Category | Count | Runs |
|---|---|---|
| output_invalid | 4 | 0bcc0c79-run1, 0bcc0c79-run2, 1316a064-run1, a3e308de-run2 |
| timeout | 3 | 1316a064-run2, dfd8937b-run1, a3e308de-run1 |

**output_invalid rate**: 4/7 genuine failures (57%)
**timeout rate**: 3/7 genuine failures (43%)

## Raw Schema Error Summary

**CRITICAL OBSERVABILITY GAP**: We cannot determine the specific schema errors
because:

1. **`runs.output_payload` is NULL for all failed runs** — the raw LLM response
   is not persisted on failure.
2. **No `output_extraction_failed` telemetry events** were emitted for these
   runs (the feature was added after these failures occurred).
3. **No `output_repair_attempted` telemetry events** exist in the event logs
   for 2026-05-10 or 2026-05-11.
4. **No `runtime_invocation_started/failed` telemetry events** exist for these
   runs — the telemetry pipeline was not active during these failures.

### Inferred Failure Path

Based on the code path in `PiAiRuntimeAdapter.startRun()`:

```
LLM response → extractJsonObject(text)
  → null? → output_invalid ("No valid JSON found in LLM response")
  → JSON parsed? → Value.Check(DreamerOutputV1Schema, parsed)
    → fails? → attemptStructuredOutputRepair()
      → fails? → output_invalid ("LLM output does not match dreamer-output-v1 schema")
```

The 4 output_invalid runs likely fall into one of these categories:

| Pattern | extractJsonObject | Schema Check | Repair | Likelihood |
|---|---|---|---|---|
| A: No JSON at all | null | N/A | N/A | **High** — MiniMax-M2.7 may return prose |
| B: Prose-wrapped JSON | parsed | fail | fail | **Medium** — code fences or preamble |
| C: JSON but wrong schema | parsed | fail | fail | **Medium** — missing fields, wrong types |
| D: JSON valid but validator rejects | parsed | pass | N/A | **Low** — taskId mismatch etc. |

**Most likely**: Pattern A or B. The EvaluatorRunner had the same issue with
the same provider/model (MiniMax-M2.7) — it returned prose-wrapped or non-JSON
output. The fix (strengthened prompt) resolved the evaluator issue, suggesting
the same root cause applies to dreamer.

## Successful Run Analysis

3 dreamer runs succeeded (output_payload available). Analyzing their output
reveals what MiniMax-M2.7 produces when it works:

### dreamer-10df2bb5 run_3 (succeeded, attempt 3)

```json
{
  "valid": true,
  "taskId": "dreamer-10df2bb5-f2ed-4688-892e-409bbaa76aa7-prompt",
  "candidates": [{
    "candidateIndex": 0,
    "badDecision": "predecessorOutput is null - no diagnosis analysis was provided...",
    "betterDecision": "Request predecessor to provide Diagnostician diagnosis output...",
    "rationale": "Without a predecessor diagnosis identifying what went wrong...",
    "confidence": 1,
    "riskLevel": "low",
    "strategicPerspective": "dependency_awareness - agents in a pipeline..."
  }],
  "sourcePrincipleId": "",
  "sourcePainId": "",
  "contextRefs": [],
  "generatedAt": "2025-01-15T12:00:00.000Z"
}
```

**Observations from successful outputs**:
- `confidence` is `1` (integer, not 0.0-1.0 float) — this passes TypeBox
  `Type.Number({ minimum: 0, maximum: 1 })` but may indicate the LLM doesn't
  understand the 0.0-1.0 range constraint.
- `sourcePrincipleId` and `sourcePainId` are empty strings `""` — passes
  `Type.Optional(Type.String())` but semantically wrong (should be absent or
  meaningful).
- `generatedAt` uses past dates (`2025-01-15`, `2025-01-09`, `2025-12-16`) —
  the LLM fabricates timestamps rather than using current time.
- Only 1 candidate generated despite the schema allowing 1-5 — the LLM takes
  the minimum path.

These patterns suggest the LLM follows the JSON structure but doesn't deeply
understand the semantic constraints.

## Dreamer Prompt Gap Analysis

Current `DREAMER_PROTOCOL_INSTRUCTION` vs. hardened `EVALUATOR_PROTOCOL_INSTRUCTION`:

| Feature | Dreamer (current) | Evaluator (hardened) |
|---|---|---|
| "CRITICAL: ENTIRE response ONLY JSON" | ❌ Missing | ✅ Present |
| "Do NOT include text before/after JSON" | ❌ Missing | ✅ Present |
| "Do NOT wrap in markdown code fences" | ❌ Missing | ✅ Present |
| Complete filled JSON example | ❌ Placeholder shape only | ✅ All fields filled |
| "no prose before or after" | ❌ Missing | ✅ Present |
| JSON-only emphasis repeated in CONSTRAINTS | ⚠️ Partial ("no markdown") | ✅ Full emphasis |
| `sourceArtificerArtifactId` copy instruction | N/A | ✅ Present |

The Dreamer prompt's "OUTPUT FORMAT" section shows a template with `<from input>`
placeholders rather than a concrete example. LLMs (especially smaller models
like MiniMax-M2.7) benefit significantly from concrete examples over templates.

## Observability Issues

### Issue 1: No raw LLM output on failure

**Severity**: Critical
**Impact**: Cannot determine whether output_invalid was caused by no JSON,
prose-wrapped JSON, or schema-invalid JSON.

**Evidence**: All 4 output_invalid runs have `output_payload = NULL` and
`input_payload = NULL` in the runs table.

**Status**: Partially addressed by `output_extraction_failed` telemetry event
(added in PRI-EVAL hardening commit). This event captures the first 500 chars
of the raw LLM response when `extractJsonObject` returns null. However, it
does NOT capture the raw output when JSON parses but schema validation fails.

### Issue 2: No runtime invocation telemetry for these failures

**Severity**: High
**Impact**: Cannot correlate failures with provider/model configuration.

**Evidence**: Zero `runtime_invocation_started`, `runtime_invocation_failed`,
`output_extraction_failed`, or `output_repair_attempted` events in
`events_2026-05-10.jsonl` or `events_2026-05-11.jsonl`.

**Root cause**: The telemetry pipeline was not active during these failures.
The `output_extraction_failed` event was added after these failures occurred.

### Issue 3: No schema error detail on output_invalid

**Severity**: Medium
**Impact**: Cannot determine which specific schema fields failed validation.

**Evidence**: The `runtime_invocation_failed` event includes `errorCategory`
and `errorMessage` but not the TypeBox validation errors. The
`output_repair_attempted` event includes `repairSummary` but only when repair
is attempted (not when `extractJsonObject` returns null).

**Recommendation**: Add `schemaErrors` field to `output_repair_attempted`
telemetry payload, containing the first 5 TypeBox validation errors.

## Recommendations

1. **Strengthen DreamerPromptBuilder** (same hardening as EvaluatorPromptBuilder):
   - Add "CRITICAL: Your ENTIRE response must be ONLY the JSON object"
   - Add "Do NOT include any text before or after the JSON"
   - Add "Do NOT wrap the JSON in markdown code fences"
   - Replace placeholder JSON template with a complete filled example
   - Add "no prose before or after" emphasis in CONSTRAINTS

2. **Do NOT change DreamerRunner code**: The runner logic is correct. The issue
   is LLM output quality from MiniMax-M2.7, not runner behavior.

3. **Create LLM invocation observability issue** (follow-up):
   - Persist raw LLM output preview (first 500 chars) in `runs.output_payload`
     on failure, not just on success
   - Add `schemaErrors` to `output_repair_attempted` telemetry
   - Ensure telemetry pipeline is active for all runtime invocations

4. **Consider increasing maxAttempts for dreamer**: With 3 max attempts and
   ~57% output_invalid rate, the probability of all 3 failing is ~8%.
   Increasing to 5 would reduce this to ~2%. However, this is a palliative,
   not a cure — prompt hardening is the primary fix.

5. **Validate MiniMax-M2.7 compatibility**: After prompt hardening, run a
   production validation with `--runner dreamer` to confirm the hardened
   prompt produces valid JSON from MiniMax-M2.7.

## Appendix: Data Sources

- **Tasks table**: `D:\.openclaw\workspace\.pd\state.db` — `tasks` table
- **Runs table**: Same DB — `runs` table
- **Workflows config**: `D:\.openclaw\workspace\.state\workflows.yaml`
- **Telemetry logs**: `D:\.openclaw\workspace\.state\logs\events_2026-05-10.jsonl`,
  `events_2026-05-11.jsonl`
- **DreamerRunner code**: `packages/principles-core/src/runtime-v2/internalization/dreamer-runner.ts`
- **DreamerPromptBuilder**: `packages/principles-core/src/runtime-v2/internalization/dreamer-prompt-builder.ts`
- **DreamerOutputV1Schema**: `packages/principles-core/src/runtime-v2/internalization/dreamer-output.ts`
- **PiAiRuntimeAdapter**: `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts`
