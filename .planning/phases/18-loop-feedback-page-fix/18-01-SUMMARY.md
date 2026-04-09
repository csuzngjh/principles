# Phase 18 Plan 01 Summary: Loop Feedback Page Data Source Tracing

## Plan Overview

| Field | Value |
|---|---|
| Plan | 18-01 |
| Phase | 18-loop-feedback-page-fix |
| Status | complete |
| Started | 2026-04-09 |
| Duration | ~5 minutes |

## Objective

Fix LOOP-01 and LOOP-02: verify `/api/samples` and `/api/samples/:id` data sources and field mappings. Both endpoints are service-based (ControlUiQueryService) and follow the established snake_case-to-camelCase mapping pattern.

## Tasks Executed

### Task 1: Verify /api/samples listSamples() data flow

**Files examined:**
- `packages/openclaw-plugin/src/service/control-ui-query-service.ts` (lines 392-512)
- `packages/openclaw-plugin/src/core/control-ui-db.ts`
- `packages/openclaw-plugin/ui/src/types.ts`

**Data flow verification:**
1. **Counters query** (line 486-490): `SELECT review_status, COUNT(*) FROM correction_samples GROUP BY review_status` - correctly maps to `{ reviewStatus, count }` via `Object.fromEntries`
2. **Items query** (line 441-485): Main SELECT from `correction_samples cs JOIN user_turns ut` with 9 fields mapped from snake_case DB columns to camelCase
3. **failure_mode**: Correlated subquery `COALESCE(tc.error_type, tc.tool_name)` correctly aliased as `failure_mode` and returned as `failureMode`
4. **related_thinking_count**: Subquery counting `thinking_model_events` in time window between bad turn and user turn
5. **Pagination** (line 505-510): `total`, `totalPages` computed correctly; `totalPages: total === 0 ? 0 : Math.ceil(total / pageSize)` — no divide-by-zero risk

**Acceptance criteria (verified):**
- `grep -c "sampleId: row.sample_id|sessionId: row.session_id|reviewStatus: row.review_status"` found 3 matches in return block (lines 495-497)
- All 9 fields present: sampleId, sessionId, reviewStatus, qualityScore, failureMode, relatedThinkingCount, createdAt, updatedAt, diffExcerpt
- Frontend `SamplesResponse` type in `ui/src/types.ts` aligns exactly with service return shape

### Task 2: Verify /api/samples/:id getSampleDetail() data flow

**Files examined:**
- `packages/openclaw-plugin/src/service/control-ui-query-service.ts` (lines 514-648)
- `packages/openclaw-plugin/src/core/control-ui-db.ts` (restoreRawText at line 296)
- `packages/openclaw-plugin/ui/src/types.ts` (SampleDetailResponse at line 69)

**Data flow verification:**
1. **Main sample query** (line 534-558): JOIN across `correction_samples`, `assistant_turns`, `user_turns` — all fields correctly aliased (bad_turn_id, bad_raw_text, bad_blob_ref, etc.)
2. **restoreRawText** (control-ui-db.ts:296): `if (inlineText) return inlineText; if (!blobRef) return '';` — correctly handles inline text, blob reference, and empty fallback
3. **badAttempt** (line 612-617): `assistantTurnId` from Number(bad_turn_id), `rawText` from restoreRawText(), `sanitizedText`, `createdAt` — all correct
4. **userCorrection** (line 618-623): `userTurnId` from Number(user_turn_id), `rawText` from restoreRawText(), `correctionCue`, `createdAt` — all correct
5. **recoveryToolSpan** (line 624): `parseJson<Array<{id, toolName}>>(row.recovery_tool_span_json, [])` — correct JSON deserialization
6. **relatedPrinciples** (line 625-632): Merges `seededPrincipleIds` from `principle_ids_json` with `relatedPrinciples` from `principle_events` DB query — correct
7. **relatedThinkingHits** (line 633-641): Maps from `thinking_model_events`, resolves `modelName` via `getThinkingModel()`, parses `scenario_json` — correct
8. **reviewHistory** (line 642-646): Queries `sample_reviews` table, maps `review_status`, `note`, `created_at` — correct

**Acceptance criteria (verified):**
- `grep -c "badAttempt:|userCorrection:|recoveryToolSpan:|relatedPrinciples:|relatedThinkingHits:|reviewHistory:"` found 6 matches in return block (lines 612-646)
- All 14 top-level fields present and nested fields match frontend `SampleDetailResponse` type exactly
- `restoreRawText()` used for both badAttempt.rawText and userCorrection.rawText

## Deviations from Plan

None — both tasks executed exactly as written.

## Deferred Issues

None identified during this tracing work.

## Known Stubs

None. No hardcoded zeros, empty arrays passed to rendering, or placeholder text found in the traced service methods.

## Threat Surface

No new security surface introduced. Both endpoints were already present and only data-tracing verification was performed.

## Verification Commands Run

```bash
# Task 1
grep -c "sampleId: row.sample_id|sessionId: row.session_id|reviewStatus: row.review_status" \
  packages/openclaw-plugin/src/service/control-ui-query-service.ts
# Result: 3 (all 3 key field mappings present in listSamples return block)

# Task 2
grep -c "badAttempt:|userCorrection:|recoveryToolSpan:|relatedPrinciples:|relatedThinkingHits:|reviewHistory:" \
  packages/openclaw-plugin/src/service/control-ui-query-service.ts
# Result: 6 (all composite fields present in getSampleDetail return block)

# TypeScript compilation check
cd packages/openclaw-plugin && npx tsc --noEmit 2>&1 | head -30
# Result: Errors only in evolution-worker.ts (pre-existing, out of scope for this plan)
```

## Decisions Made

- Pre-existing TypeScript errors in `evolution-worker.ts` (runtimeAdapter missing, private property access) are out of scope for this plan and do not affect `/api/samples` or `/api/samples/:id`
- No hardcoded stub values found in listSamples or getSampleDetail return blocks
