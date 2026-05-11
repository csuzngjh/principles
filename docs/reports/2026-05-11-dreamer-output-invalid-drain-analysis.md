# Dreamer output_invalid Drain Analysis — 2026-05-11

## Summary

During PRI-110 drain, 4 dreamer tasks failed permanently after exhausting retries. This evidence pack documents the failure patterns for future hardening.

## Failed Task Summary

| Task ID (prefix) | Attempts | Final Error | output_invalid Runs | timeout Runs |
|---|---|---|---|---|
| `dreamer-0bcc0c79-9011-4d2f-865d-674a145219ff` | 3 | max_attempts_exceeded | 2 | 0 |
| `dreamer-1316a064-ce07-42db-b06a-21917a551752` | 4 | max_attempts_exceeded | 1 | 1 |
| `dreamer-dfd8937b-16e1-4824-bf93-6903b430d4c2` | 3 | max_attempts_exceeded | 0 | 1 |
| `dreamer-a3e308de-41d4-473f-a74a-a66caa394efb` | 3 | max_attempts_exceeded | 1 | 0 |

**Total**: 4 output_invalid, 2 timeout across 8 failed runs

## Per-Run Details

### dreamer-0bcc0c79 (2 output_invalid, 0 timeout)

| Run | Started | Ended | Duration | Error Category |
|---|---|---|---|---|
| run_1 | 2026-05-10T08:03:30 | 2026-05-10T08:04:57 | ~87s | output_invalid |
| run_2 | 2026-05-10T10:48:41 | 2026-05-10T10:49:34 | ~53s | output_invalid |
| run_3 | 2026-05-11T02:47:44 | 2026-05-11T02:48:16 | ~32s | max_attempts_exceeded |

### dreamer-1316a064 (1 output_invalid, 1 timeout)

| Run | Started | Ended | Duration | Error Category |
|---|---|---|---|---|
| run_1 | 2026-05-10T08:02:40 | 2026-05-10T08:03:12 | ~32s | output_invalid |
| run_2 | 2026-05-10T09:52:54 | 2026-05-10T09:53:05 | ~11s | timeout |
| run_3 | 2026-05-11T02:47:17 | 2026-05-11T02:47:27 | ~10s | max_attempts_exceeded |
| run_4 | N/A | N/A | N/A | max_attempts_exceeded (terminal) |

### dreamer-dfd8937b (0 output_invalid, 1 timeout)

| Run | Started | Ended | Duration | Error Category |
|---|---|---|---|---|
| run_1 | 2026-05-10T08:02:20 | 2026-05-10T08:02:30 | ~10s | timeout |
| run_2 | N/A | N/A | N/A | max_attempts_exceeded |
| run_3 | 2026-05-11T02:46:17 | 2026-05-11T02:46:48 | ~31s | max_attempts_exceeded |

### dreamer-a3e308de (1 output_invalid, 0 timeout)

| Run | Started | Ended | Duration | Error Category |
|---|---|---|---|---|
| run_1 | 2026-05-10T03:49:57 | 2026-05-10T03:50:08 | ~11s | timeout |
| run_2 | 2026-05-10T04:26:44 | 2026-05-10T04:26:51 | ~7s | output_invalid |
| run_3 | 2026-05-10T08:05:06 | 2026-05-10T08:07:00 | ~114s | max_attempts_exceeded |

## Dreamer Prompt Analysis

Current `DREAMER_PROTOCOL_INSTRUCTION` includes:
- "OUTPUT FORMAT (pure JSON, no markdown)" with example shape
- "Output ONLY valid JSON (no markdown, no explanatory text, no code fences)"
- Constraints for each field

**Missing**:
- No "CRITICAL: Your ENTIRE response must be ONLY the JSON object" emphasis
- No "Do NOT include any text before or after the JSON" emphasis
- No complete minimal JSON example with all fields filled
- No "Do NOT wrap in markdown code fences" emphasis

## Schema Error Patterns

`output_invalid` in the Dreamer context means one of:
1. `extractJsonObject(text)` returned `null` — LLM returned no parseable JSON
2. JSON parsed but failed `DreamerOutputV1` schema validation — and repair also failed
3. JSON parsed, schema valid, but `DefaultDreamerValidator.validate()` found cross-field errors (e.g., taskId mismatch)

**Most likely cause**: Pattern 1 (no parseable JSON). The 10-11s timeout runs suggest LLM API issues (connection timeout), while the 32-87s output_invalid runs suggest the LLM returned a response but it wasn't valid JSON.

## Observability Gap

**Critical finding**: The `runs` table `input_payload` and `output_payload` columns are **empty** for all failed dreamer runs. This means:
- We cannot see what the LLM actually returned
- We cannot determine if `extractJsonObject` failed or schema validation failed
- We cannot reproduce the failure with the exact LLM output

The `PiAiRuntimeAdapter.startRun()` method does not persist the raw LLM response before throwing `output_invalid`. The telemetry events (`runtime_invocation_failed`) are emitted but do not include the raw output preview.

## Recommendations

1. **Add `output_extraction_failed` telemetry event**: When `extractJsonObject` returns null, emit a telemetry event with the first 500 chars of the LLM response. This provides diagnosis without DB bloat.

2. **Strengthen DreamerPromptBuilder**: Add the same hardening as EvaluatorPromptBuilder — complete JSON example, "ENTIRE response only JSON" emphasis, "no prose before/after" emphasis.

3. **Create LLM invocation observability issue**: Track as a follow-up — persist raw LLM output (or preview) in the `runs` table on failure for post-mortem analysis.

4. **Do NOT change DreamerRunner code**: The runner logic is correct. The issue is LLM output quality, not runner behavior.

5. **Consider increasing maxAttempts for dreamer**: With 3 max attempts and ~50% output_invalid rate, the probability of all 3 failing is ~12.5%. Increasing to 5 would reduce this to ~3%.
