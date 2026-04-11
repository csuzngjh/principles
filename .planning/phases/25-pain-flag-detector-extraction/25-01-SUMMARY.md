---
phase: 25-pain-flag-detector-extraction
plan: 01
status: complete
started: 2026-04-11T08:45:00.000Z
completed: 2026-04-11
---

# Plan 01: Pain Flag Detector Extraction — Summary

## Objective
Extract pain flag detection into a dedicated `PainFlagDetector` module with validated entry points, following the Phase 24 (EvolutionQueueStore) pattern.

## What Was Built

### `pain-flag-detector.ts` (NEW — 455 lines)

**Types:**
- `PainFlagDetectionResult`: { exists, score, source, enqueued, skipped_reason, error }
- `ParsedPainValues`: { score, source, reason, preview, traceId, sessionId, agentId }

**`PainFlagDetector` class:**
- `constructor(workspaceDir: string)` — stores workspaceDir
- `detect(logger?: PluginLogger): Promise<PainFlagDetectionResult>` — main entry point
- `extractRecentPainContext(): RecentPainContext` — synchronous, reads PAIN_FLAG

**Format detection (in priority order):**
1. `detectKV()` — uses `readPainFlagContract` for primary KV validation
2. `detectJSON(rawPain)` — parses JSON with pain_score > score > default 50
3. `detectKeyValueFallback(lines)` — Source=/Reason=/Score=/Time= format
4. `detectMarkdown(lines)` — **Source**: xxx format

**Re-exports:**
- `RecentPainContext` from `evolution-queue-store.js` for backward compatibility

### `evolution-worker.ts` Modifications

**Removed pain flag parsing:**
- `readRecentPainContext` (L251-276) → replaced with wrapper delegating to `PainFlagDetector.extractRecentPainContext()`
- `ParsedPainValues` interface (L325-328) → deleted
- `doEnqueuePainTask` (L331-392) → deleted (logic moved into `PainFlagDetector.enqueueFromParsedValues()`)
- `checkPainFlag` (L394-564) → replaced with 3-line wrapper delegating to `PainFlagDetector.detect()`

**Added:**
- `import { PainFlagDetector } from './pain-flag-detector.js';`
- `export { PainFlagDetector } from './pain-flag-detector.js';` (backward compat re-export)

**Removed:**
- `import { readPainFlagContract } from '../core/pain.js';` (no longer needed in worker)

## Key Decisions

1. **`detectKV` is async**: The KV valid path calls `enqueueFromParsedValues()` which is async (uses `store.update()`). Making `detectKV` async keeps the call chain simple.

2. **All enqueueing through `enqueueFromParsedValues`**: Instead of duplicating the enqueue logic across format paths, all paths (KV, JSON, Key=Value, Markdown) delegate to the shared `enqueueFromParsedValues()` method.

3. **Score resolution**: JSON format uses `pain_score > score > default 50` matching the original `checkPainFlag` behavior.

## Test Results
```
pain.test.ts:                        14 passed
pain-integration.test.ts:            22 passed
evolution-worker.test.ts:            19 passed
evolution-queue-store.test.ts:       32 passed
evolution-worker.nocturnal.test.ts:  7 passed
Total:                             94 passed
```

## Self-Check: PASSED
- No pain-parsing logic remains in evolution-worker.ts
- `checkPainFlag` wrapper delegates entirely to `PainFlagDetector.detect()`
- `readRecentPainContext` wrapper delegates to `PainFlagDetector.extractRecentPainContext()`
- TypeScript compiles without errors
- All 94 tests pass

## Requirements Addressed
- DECOMP-02: All pain flag parsing/detection extracted to PainFlagDetector
