# PRI-81 — Prompt Injection SDK Migration: Remaining Helper Backlog

## Summary

Migrate remaining pure domain logic from `openclaw-plugin` to `@principles/core/prompt-builder`, covering empathy keyword matching, focus/content compression, prompt.ts thinning, and test comment cleanup. Plugin retains I/O adapters only.

## Current State Analysis

### Empathy Keyword Matcher (`openclaw-plugin/src/core/empathy-keyword-matcher.ts`)

**Pure functions (migrate to core):**
- `matchEmpathyKeywords(text, store, config)` — pure matching/scoring, no I/O
- `applyKeywordUpdates(store, updates)` — pure store mutation
- `shouldTriggerOptimization(store, turnsSinceLastOptimization, config)` — pure decision
- `getKeywordStoreSummary(store)` — pure inspection
- `createDefaultKeywordStore(language)` — pure (uses `new Date()`, no fs/path)

**I/O functions (stay in plugin):**
- `loadKeywordStore(stateDir, language)` — uses `fs`, `path`
- `saveKeywordStore(stateDir, store)` — uses `fs`, `path`, `atomicWriteFileSync`

### Empathy Types (`openclaw-plugin/src/core/empathy-types.ts`)

All types and constants are pure data — migrate entirely to core:
- Interfaces: `EmpathyKeywordStore`, `EmpathyKeywordEntry`, `EmpathyKeywordStats`, `EmpathyMatchResult`, `EmpathyKeywordUpdate`, `EmpathyOptimizationResult`, `SeedKeywordEntry`, `EmpathyKeywordConfig`
- Constants: `EMPATHY_SEED_KEYWORDS`, `DEFAULT_EMPATHY_KEYWORD_CONFIG`
- Pure functions: `scoreToSeverity()`, `severityToPenalty()`, `normalizeSeverity()`

### Focus History (`openclaw-plugin/src/core/focus-history.ts`, 1516 lines)

**Pure functions (migrate to core):**
- `extractVersion(content)` — pure string parsing
- `extractDate(content)` — pure string parsing
- `extractSummary(content, maxLines)` — pure text processing
- `parseWorkingMemorySection(content)` — pure text parsing
- `workingMemoryToInjection(snapshot)` — pure text generation
- `extractMilestones(content)` — pure text parsing
- `validateCurrentFocus(content)` — pure validation
- `mergeWorkingMemory(content, snapshot)` — pure text manipulation
- `extractDescription(text, filePath)` — pure
- `extractProblems(text, problems)` — pure
- `extractNextActions(text, actions)` — pure
- `deduplicateArtifacts(artifacts)` — pure
- `generateWorkingMemorySection(snapshot)` — pure (currently private)
- Types: `FileArtifact`, `WorkingMemorySnapshot`, `CompressionConfig`

**I/O functions (stay in plugin):**
- `getHistoryDir(focusPath)` — uses `path`
- `backupToHistory(focusPath, content)` — uses `fs`, `path`
- `cleanupHistory(focusPath, maxFiles)` — uses `fs`, `path`
- `getHistoryVersions(focusPath, count)` — uses `fs`, `path` (async)
- `compressFocus(focusPath, newContent)` — uses `fs`, `path`, `atomicWriteFileSync`
- `autoCompressFocus(focusPath, workspaceDir, stateDir)` — heavily I/O, needs splitting
- `needsAutoCompression(focusPath, stateDir)` — uses `fs`
- `recoverFromTemplate(focusPath, extensionRoot)` — uses `fs`, `path`
- `safeReadCurrentFocus(focusPath, extensionRoot, logger)` — uses `fs`
- `loadCompressionConfig(stateDir)` — uses `fs`, `path`
- `canAutoCompress(stateDir)` — uses `fs`, `path`
- `recordCompressTime(stateDir)` — uses `fs`, `path`, `atomicWriteFileSync`
- `archiveMilestonesToDaily(workspaceDir, milestones, version)` — uses `fs`, `path`
- `extractWorkingMemory(messages, workspaceDir)` — uses `path.relative`
- `extractFileArtifacts(text, artifacts, workspaceDir)` — uses `path.relative`
- `cleanupStaleInfo(content, workspaceDir?, config?)` — has `fs.existsSync` when `workspaceDir` provided

### prompt.ts Current Imports

```ts
// Empathy — from plugin
import { matchEmpathyKeywords, loadKeywordStore, saveKeywordStore, getKeywordStoreSummary } from '../core/empathy-keyword-matcher.js';
import { severityToPenalty, DEFAULT_EMPATHY_KEYWORD_CONFIG } from '../core/empathy-types.js';

// Focus — from plugin
import { extractSummary, getHistoryVersions, parseWorkingMemorySection, workingMemoryToInjection, autoCompressFocus, safeReadCurrentFocus } from '../core/focus-history.js';

// Already migrated to core
import { truncateInjectionToBudget } from '@principles/core/prompt-builder';
import { buildAttitudeDirective, detectCorrectionCue, extractMessageContent, isMinimalTrigger } from '@principles/core/prompt-builder';
```

### Architecture Regression Test

Located at `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`, lines 1229-1354. Currently guards:
- `prompt-builder/*.ts` files have zero `node:fs`/`node:path`/`node:process`/`openclaw-plugin` imports
- `prompt-builder/index.ts` exports all 13 functions
- Plugin `principle-injection.ts` is thin re-export
- Plugin `prompt.ts` imports from `@principles/core/prompt-builder`

### Test Comments to Clean (Phase D)

Found in `principle-selection.test.ts`:
- Line 141: `// P0 guarantee: priority dominates recency — the safety-net ensures P0 is prepended`
- Line 148: `// Recency-sorted order: P2, P1, P0`

These comments describe the internal iteration order but are misleading — the test actually validates P0 guarantee / budget behavior, not recency-sorted output.

No "Test expects impossible" or "Skip or adjust" found in `prompt-builder-core.test.ts`.

---

## Proposed Changes

### Phase A — Empathy Keyword Matching Migration

**New files:**
1. `packages/principles-core/src/prompt-builder/empathy-keyword-matching.ts`
   - Export: `matchEmpathyKeywords`, `applyKeywordUpdates`, `shouldTriggerOptimization`, `getKeywordStoreSummary`, `createDefaultKeywordStore`
   - Import types from `./empathy-types.js`

2. `packages/principles-core/src/prompt-builder/empathy-types.ts`
   - Move all types and constants from `openclaw-plugin/src/core/empathy-types.ts`
   - Export: all interfaces, `EMPATHY_SEED_KEYWORDS`, `DEFAULT_EMPATHY_KEYWORD_CONFIG`, `scoreToSeverity`, `severityToPenalty`, `normalizeSeverity`

3. `packages/principles-core/src/prompt-builder/__tests__/empathy-keyword-matching.test.ts`
   - Migrate pure matching/scoring test cases from plugin test
   - Test `matchEmpathyKeywords`, `applyKeywordUpdates`, `shouldTriggerOptimization`, `getKeywordStoreSummary`, `createDefaultKeywordStore`, `scoreToSeverity`, `severityToPenalty`

**Modified files:**
4. `packages/principles-core/src/prompt-builder/index.ts`
   - Add exports for new empathy module functions and types

5. `packages/principles-core/src/index.ts`
   - Add re-exports for empathy types and functions from `./prompt-builder/index.js`

6. `packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts`
   - Remove migrated function implementations
   - Re-export pure functions from `@principles/core/prompt-builder`
   - Keep `loadKeywordStore`, `saveKeywordStore` as I/O implementations
   - Import types from `@principles/core/prompt-builder` instead of local `./empathy-types.js`

7. `packages/openclaw-plugin/src/core/empathy-types.ts`
   - Re-export all types and constants from `@principles/core/prompt-builder`
   - Remove local definitions (backward compat: existing imports still work)

8. `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`
   - Add `prompt-builder/empathy-keyword-matching.ts` and `prompt-builder/empathy-types.ts` to the `files` array for zero-infrastructure-import guard
   - Add export count assertion for new functions in `prompt-builder/index.ts`

**Key constraint:** `matchEmpathyKeywords` mutates `store.terms[].hitCount` and `store.stats.totalHits` as a side effect. This mutation is part of the existing contract — preserve it exactly. The function is still "pure" in the sense that it only mutates its input store object (no I/O), but callers should be aware.

### Phase B — Focus / Content Compression Migration

**New files:**
1. `packages/principles-core/src/prompt-builder/focus-compression.ts`
   - Export pure functions:
     - `extractVersion(content: string): string`
     - `extractDate(content: string): string`
     - `extractSummary(content: string, maxLines?: number): string`
     - `parseWorkingMemorySection(content: string): WorkingMemorySnapshot | null`
     - `workingMemoryToInjection(snapshot: WorkingMemorySnapshot | null): string`
     - `extractMilestones(content: string): { completedTasks: string[]; fileArtifacts: string[] }`
     - `validateCurrentFocus(content: string): { valid: boolean; errors: string[]; warnings: string[] }`
     - `mergeWorkingMemory(content: string, snapshot: WorkingMemorySnapshot): string`
     - `compressFocusContent(content: string, options: FocusCompressionOptions): FocusCompressionResult`
   - Export types: `FileArtifact`, `WorkingMemorySnapshot`, `FocusCompressionOptions`, `FocusCompressionResult`
   - `compressFocusContent` is the pure core of `autoCompressFocus`:
     ```ts
     interface FocusCompressionOptions {
       lineThreshold: number;
       sizeThreshold: number;
       keepCompletedTasks: number;
       maxWorkingMemoryArtifacts: number;
     }
     interface FocusCompressionResult {
       needsCompression: boolean;
       compressed: boolean;
       oldLines: number;
       newContent: string;
       newVersion: string;
       milestones: { completedTasks: string[]; fileArtifacts: string[] };
     }
     ```
   - `cleanupStaleInfo` needs splitting: extract pure text filtering (without `fs.existsSync` check) into core. The `workspaceDir` file-existence check stays in plugin.

2. `packages/principles-core/src/prompt-builder/__tests__/focus-compression.test.ts`
   - Test pure functions: `extractVersion`, `extractDate`, `extractSummary`, `parseWorkingMemorySection`, `workingMemoryToInjection`, `extractMilestones`, `validateCurrentFocus`, `mergeWorkingMemory`, `compressFocusContent`
   - Migrate relevant test cases from plugin `focus-history.test.ts`

**Modified files:**
3. `packages/principles-core/src/prompt-builder/index.ts`
   - Add exports for focus-compression module

4. `packages/principles-core/src/index.ts`
   - Add re-exports for focus-compression types and functions

5. `packages/openclaw-plugin/src/core/focus-history.ts`
   - Remove migrated pure function implementations
   - Re-export pure functions from `@principles/core/prompt-builder`
   - Keep I/O functions: `getHistoryDir`, `backupToHistory`, `cleanupHistory`, `getHistoryVersions`, `compressFocus`, `autoCompressFocus`, `needsAutoCompression`, `recoverFromTemplate`, `safeReadCurrentFocus`, `loadCompressionConfig`, `canAutoCompress`, `recordCompressTime`, `archiveMilestonesToDaily`, `extractWorkingMemory`, `extractFileArtifacts`
   - `autoCompressFocus` refactored to: read files → call `compressFocusContent` from core → write back
   - `cleanupStaleInfo` stays in plugin (has `fs.existsSync` dependency)
   - Import types from `@principles/core/prompt-builder`

6. `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`
   - Add `prompt-builder/focus-compression.ts` to the zero-infrastructure-import guard

### Phase C — prompt.ts Thin Adapter Cleanup

**Modified files:**
1. `packages/openclaw-plugin/src/hooks/prompt.ts`
   - Change empathy imports to use core (via thin adapter):
     ```ts
     // Before:
     import { matchEmpathyKeywords, loadKeywordStore, saveKeywordStore, getKeywordStoreSummary } from '../core/empathy-keyword-matcher.js';
     import { severityToPenalty, DEFAULT_EMPATHY_KEYWORD_CONFIG } from '../core/empathy-types.js';
     // After: same imports still work (thin adapter re-exports from core)
     ```
   - Change focus imports to use core where possible:
     ```ts
     // Before:
     import { extractSummary, getHistoryVersions, parseWorkingMemorySection, workingMemoryToInjection, autoCompressFocus, safeReadCurrentFocus } from '../core/focus-history.js';
     // After: pure functions come from core via thin adapter, I/O functions stay from plugin
     ```
   - Verify no direct algorithm logic remains in prompt.ts that duplicates core

2. `packages/principles-core/src/prompt-builder/index.ts`
   - Verify all new modules are exported

3. `packages/principles-core/src/index.ts`
   - Verify prompt-builder re-exports are complete

4. `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`
   - Update export count assertion for new functions
   - Add guard: plugin `empathy-keyword-matcher.ts` does NOT contain inline `matchEmpathyKeywords` implementation
   - Add guard: plugin `empathy-types.ts` re-exports from core
   - Add guard: plugin `focus-history.ts` does NOT contain inline `extractSummary`/`parseWorkingMemorySection`/`workingMemoryToInjection` implementation

### Phase D — Residual Test Comment Cleanup

**Modified files:**
1. `packages/principles-core/src/prompt-builder/__tests__/principle-selection.test.ts`
   - Line 141: Change `// P0 guarantee: priority dominates recency — the safety-net ensures P0 is prepended` to `// P0 guarantee: safety-net ensures at least one P0 is always included`
   - Line 148: Change `// Recency-sorted order: P2, P1, P0` to `// Iteration processes by recency; P0 may be missed → safety net prepends it`

2. Verify `prompt-builder-core.test.ts` has no "Test expects impossible" / "Skip or adjust" comments (already confirmed clean)

---

## Assumptions & Decisions

1. **`createDefaultKeywordStore` migrates to core** — it's pure (only uses `new Date()`, no fs/path). Plugin's `loadKeywordStore` calls it, but that's fine — plugin imports it from core.

2. **`matchEmpathyKeywords` mutates `store`** — this is existing behavior (updates `hitCount`, `lastHitAt`, `stats.totalHits`). We preserve this exactly. It's still "pure enough" for core (no I/O, deterministic for same inputs).

3. **`extractWorkingMemory` stays in plugin** — it uses `path.relative()` which is I/O-adjacent. The pure text extraction parts (`extractDescription`, `extractProblems`, `extractNextActions`, `deduplicateArtifacts`) migrate to core as private helpers within `focus-compression.ts`.

4. **`cleanupStaleInfo` stays in plugin** — has `fs.existsSync` check when `workspaceDir` is provided. The pure text filtering logic is not separately extracted to avoid over-engineering.

5. **`autoCompressFocus` split strategy** — core gets `compressFocusContent(content, options)` which does the pure compression decision/transform. Plugin's `autoCompressFocus` reads files, calls core, handles I/O (backup, write, archive, rate-limit).

6. **Backward compatibility** — plugin's `empathy-keyword-matcher.ts` and `empathy-types.ts` become thin re-export adapters. Existing imports from these modules continue to work.

7. **Three separate PRs** as specified: empathy (Phase A), focus (Phase B), thin-adapter + comments (Phase C/D).

---

## Verification Steps

### Phase A
```bash
npx vitest run packages/principles-core/src/prompt-builder/__tests__/empathy-keyword-matching.test.ts --exclude "**/.claude/**"
npx vitest run packages/openclaw-plugin/tests/core/empathy-keyword-matcher.test.ts --exclude "**/.claude/**"
```

### Phase B
```bash
npx vitest run packages/principles-core/src/prompt-builder/__tests__/focus-compression.test.ts --exclude "**/.claude/**"
npx vitest run packages/openclaw-plugin/tests/core/focus-history.test.ts --exclude "**/.claude/**"
npx vitest run packages/openclaw-plugin/tests/hooks/prompt-characterization.test.ts --exclude "**/.claude/**"
npx vitest run packages/openclaw-plugin/tests/hooks/prompt-size-guard.test.ts --exclude "**/.claude/**"
```

### Phase C/D
```bash
npx vitest run packages/openclaw-plugin/tests/hooks/prompt-characterization.test.ts --exclude "**/.claude/**"
npx vitest run packages/openclaw-plugin/tests/hooks/prompt-size-guard.test.ts --exclude "**/.claude/**"
npx vitest run packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts --exclude "**/.claude/**"
rg -n "Test expects impossible|Skip or adjust|Recency-sorted order: P2, P1, P0|P0.*recency" packages/principles-core/src/prompt-builder/__tests__
```

### Full Final Verification
```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npm run typecheck:openclaw-plugin
npx vitest run packages/principles-core/src/prompt-builder --exclude "**/.claude/**"
npx vitest run packages/openclaw-plugin/tests/core/empathy-keyword-matcher.test.ts --exclude "**/.claude/**"
npx vitest run packages/openclaw-plugin/tests/core/focus-history.test.ts --exclude "**/.claude/**"
npx vitest run packages/openclaw-plugin/tests/hooks/prompt-characterization.test.ts --exclude "**/.claude/**"
npx vitest run packages/openclaw-plugin/tests/hooks/prompt-size-guard.test.ts --exclude "**/.claude/**"
npx vitest run packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts --exclude "**/.claude/**"
```
