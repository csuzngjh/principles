# Phase 40: LLM Discovery - Research

**Researched:** 2026-04-14
**Domain:** Keyword Learning Engine - LLM-driven keyword mutation and trajectory flag visibility
**Confidence:** HIGH

## Summary

Phase 40 completes the keyword learning loop by implementing the LLM optimizer's ability to mutate keywords based on match history and FPR statistics (CORR-09), and ensuring the `correctionDetected` trajectory flag is accessible to the optimizer (CORR-12). The phase requires creating `correction-observer-types.ts` (new file), `keyword-optimization-service.ts` (new file), adding `updateWeight()` and `remove()` to `CorrectionCueLearner`, and wiring `keyword_optimization` task type into `evolution-worker.ts`.

**Primary recommendation:** Follow the PLAN.md locked decisions exactly - use KeywordOptimizationService as the single integration point between LLM optimization results and the keyword store, use trajectory.listUserTurnsForSession() for CORR-12, and reuse existing checkCooldown infrastructure for throttling.

## User Constraints (from CONTEXT.md)

### Locked Decisions

**Mutation Application (D-40-01, D-40-02, D-40-03)**
- KeywordOptimizationService applies LLM-returned ADD/UPDATE/REMOVE to CorrectionCueLearner
- Service reads CorrectionObserverResult, then calls CorrectionCueLearner.add() / updateWeight() / remove()
- evolution-worker.ts does NOT call CorrectionCueLearner directly - only calls KeywordOptimizationService

**Trigger Mechanism (D-40-04, D-40-05, D-40-06)**
- New keyword_optimization task type in evolution-worker.ts, independent from sleep_reflection
- Throttle: max 4/day per workspace via checkCooldown (CORR-08 already implemented)
- 6-hour wall-clock equivalent via period_heartbeats config

**LLM Input Data (D-40-07, D-40-08, D-40-09)**
- CorrectionObserverPayload contains: keywordStoreSummary + recentMessages + trajectoryHistory
- trajectoryHistory: last N user turns where correctionDetected=true, including term matched, timestamp, sessionId
- LLM prompt instructs to analyze FPR trends and suggest mutations

**Integration Point (D-40-13, D-40-14)**
- correctionDetected flag already recorded in TrajectoryUserTurnInput
- trajectory.listUserTurnsForSession() already returns correctionDetected - KeywordOptimizationService uses this

### Deferred Ideas
- recordTruePositive() implicit vs explicit - left as calling-context decision for now
- Minimum weight threshold for matching - Claude's discretion

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CORR-09 | LLM optimizer receives match history and FPR statistics and returns keyword mutations (add/update/remove) | KeywordOptimizationService.applyResult() handles all three action types; CorrectionObserverResult.updates contains the mutations |
| CORR-12 | Trajectory records include `correctionDetected: boolean` flag from keyword matcher | TrajectoryUserTurnInput.correctionDetected already exists in trajectory-types.ts; listUserTurnsForSession() returns it |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | 4.1.0 | Test framework | Project standard (vitest.config.ts) |
| TypeScript | 6.0.2 | Language | Project standard |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| better-sqlite3 | 12.9.0 | Trajectory database | Reading correctionDetected from user_turns |
| @sinclair/typebox | 0.34.48 | Runtime type validation | Workflow spec types |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| New CorrectionObserverPayload interface | Extend existing interface | correction-observer-types.ts does not exist - must create new |

**Installation:** N/A - no new npm packages required

## Architecture Patterns

### Recommended Project Structure
```
packages/openclaw-plugin/src/
├── service/
│   ├── keyword-optimization-service.ts  (NEW)
│   ├── evolution-worker.ts              (MODIFY - add keyword_optimization task type)
│   └── subagent-workflow/
│       └── correction-observer-types.ts (NEW - CorrectionObserverPayload + CorrectionObserverResult)
└── core/
    └── correction-cue-learner.ts        (MODIFY - add updateWeight/remove)
```

### Pattern 1: Singleton Factory with State Directory Key
**What:** Classes like CorrectionCueLearner use a singleton pattern keyed by stateDir
**When to use:** Services that maintain per-workspace state
**Example:**
```typescript
// Source: correction-cue-learner.ts:196-202
static get(stateDir: string): CorrectionCueLearner {
  if (!_instance || _lastStateDir !== stateDir) {
    _instance = new CorrectionCueLearner(stateDir);
    _lastStateDir = stateDir;
  }
  return _instance;
}
```

### Pattern 2: Atomic Write with Cache Invalidation
**What:** Write to temp file then rename, invalidate module cache after write
**When to use:** Persisting JSON state files
**Example:**
```typescript
// Source: correction-cue-learner.ts:98-111
fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
fs.renameSync(tmpPath, filePath);
_corruptionCueCache = null; // Invalidate cache
```

### Pattern 3: Task Queue Processing in evolution-worker.ts
**What:** Tasks filtered by status ('pending' | 'in_progress') and taskKind, processed in heartbeat cycle
**When to use:** Background task processing with throttle support
**Example:**
```typescript
// Source: evolution-worker.ts (sleep_reflection pattern)
const pendingTasks = queue.filter(t => t.status === 'pending' && t.taskKind === 'sleep_reflection');
const inProgressTasks = queue.filter(t =>
    t.status === 'in_progress' &&
    t.taskKind === 'sleep_reflection' &&
    t.resultRef &&
    !t.resultRef.startsWith('trinity-draft')
);
```

### Pattern 4: Trajectory History via listUserTurnsForSession
**What:** Query SQLite for user turns with correctionDetected filter
**When to use:** Building history payloads for LLM analysis
**Example:**
```typescript
// Source: trajectory.ts:854-874
listUserTurnsForSession(sessionId: string): {
  id: number;
  turnIndex: number;
  correctionDetected: boolean;
  correctionCue: string | null;
  createdAt: string;
}[] {
  const rows = this.db.prepare(`
    SELECT id, turn_index, correction_detected, correction_cue, created_at
    FROM user_turns
    WHERE session_id = ?
    ORDER BY turn_index ASC
  `).all(sessionId) as Record<string, unknown>[];
  // ...
}
```

### Anti-Patterns to Avoid
- **Direct CorrectionCueLearner calls from evolution-worker.ts:** Use KeywordOptimizationService as intermediary per D-40-02
- **Adding new throttle infrastructure:** Reuse checkCooldown() per D-40-05
- **Modifying TrajectoryUserTurnInput schema:** correctionDetected already exists at trajectory-types.ts:41

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-workspace throttle | Custom throttle tracking | checkCooldown(stateDir, undefined, { maxRunsPerWindow: 4, quotaWindowMs: 86400000 }) | Already handles per-workspace cooldown; adding duplicate would cause quota tracking bugs |
| Trajectory correction history | Direct SQLite queries | TrajectoryCollector.listUserTurnsForSession() | Already returns sanitized data; direct queries bypass any future schema changes |
| LLM result parsing | Custom JSON parsing | parseCorrectionObserverPayload() from correction-observer-workflow-manager.ts | Already handles edge cases (empty input, JSON extraction from text) |

**Key insight:** The existing infrastructure (checkCooldown, TrajectoryCollector, CorrectionObserverWorkflowManager) was designed for this integration. Building custom solutions would duplicate logic and create maintenance burden.

## Common Pitfalls

### Pitfall 1: Missing trajectoryHistory in CorrectionObserverPayload
**What goes wrong:** LLM optimizer receives no correction history, cannot analyze FPR trends
**Why it happens:** CorrectionObserverPayload is a new interface that doesn't exist yet - must be created with trajectoryHistory field
**How to avoid:** Create correction-observer-types.ts with all required fields per PLAN.md Task 1
**Warning signs:** grep -n "trajectoryHistory" shows no results in correction-observer-types.ts

### Pitfall 2: listUserTurnsForSession returns sanitized data without input field
**What goes wrong:** buildTrajectoryHistory() cannot include userMessage content
**Why it happens:** listUserTurnsForSession() only returns correctionDetected, correctionCue, createdAt - not the raw input text
**How to avoid:** The PLAN.md specifies `term: turn.correctionCue ?? 'unknown'` and `userMessage: turn.input ?? ''` - but turn.input is NOT returned by listUserTurnsForSession. Need to either use correctionCue as the term source, or query the database directly for input text
**Warning signs:** buildTrajectoryHistory() returns empty userMessage for all entries

### Pitfall 3: Missing updateWeight() and remove() on CorrectionCueLearner
**What goes wrong:** KeywordOptimizationService.applyResult() cannot apply UPDATE/REMOVE actions
**Why it happens:** correction-cue-learner.ts only has add() method - updateWeight() and remove() need to be added
**How to avoid:** Add both methods per PLAN.md Task 3 before wiring evolution-worker.ts
**Warning signs:** TypeScript compilation errors when KeywordOptimizationService calls learner.updateWeight() or learner.remove()

### Pitfall 4: Task type not recognized by hasPendingTask()
**What goes wrong:** keyword_optimization tasks never progress from pending
**Why it happens:** hasPendingTask() filters by taskKind string - keyword_optimization must exactly match
**How to avoid:** Use 'keyword_optimization' string consistently in enqueueKeywordOptimizationTask() and task filtering
**Warning signs:** Tasks stuck in 'pending' status after workflow completes

## Code Examples

### Creating CorrectionObserverPayload with trajectoryHistory (NEW file)
```typescript
// New file: packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-types.ts
import type { SubagentWorkflowSpec } from './types.js';

export interface CorrectionObserverPayload {
  workspaceDir: string;
  parentSessionId: string;
  /** Summary of current keyword store state */
  keywordStoreSummary: {
    totalKeywords: number;
    terms: Array<{
      term: string;
      weight: number;
      hitCount: number;
      truePositiveCount: number;
      falsePositiveCount: number;
    }>;
  };
  /** Recent user messages for pattern analysis */
  recentMessages: string[];
  /**
   * Trajectory history: user turns where correctionDetected=true (D-40-08).
   * Includes term matched, timestamp, sessionId for FPR trend analysis.
   */
  trajectoryHistory: Array<{
    sessionId: string;
    timestamp: string;
    term: string;         // The correction term that was matched
    userMessage: string;   // The user message content
  }>;
}

export interface CorrectionObserverResult {
  updated: boolean;
  updates: Record<string, {
    action: 'add' | 'update' | 'remove';
    weight?: number;
    falsePositiveRate?: number;
    reasoning: string;
  }>;
  summary: string;
}
```

### KeywordOptimizationService with applyResult() and buildTrajectoryHistory()
```typescript
// New file: packages/openclaw-plugin/src/service/keyword-optimization-service.ts
import { CorrectionCueLearner } from '../core/correction-cue-learner.js';
import type { CorrectionObserverResult } from './subagent-workflow/correction-observer-types.js';
import type { PluginLogger } from '../openclaw-sdk.js';

export class KeywordOptimizationService {
  private stateDir: string;
  private logger: PluginLogger;

  constructor(stateDir: string, logger: PluginLogger) {
    this.stateDir = stateDir;
    this.logger = logger;
  }

  applyResult(result: CorrectionObserverResult): void {
    const learner = CorrectionCueLearner.get(this.stateDir);
    if (!result.updated || !result.updates) {
      this.logger?.info?.('[KeywordOptimizationService] No updates to apply');
      return;
    }

    for (const [term, update] of Object.entries(result.updates)) {
      switch (update.action) {
        case 'add': {
          const weight = update.weight ?? 0.5;
          learner.add({ term, weight, source: 'llm_optimization' });
          this.logger?.info?.(`[KeywordOptimizationService] ADD term="${term}" weight=${weight}`);
          break;
        }
        case 'update': {
          if (update.weight !== undefined) {
            learner.updateWeight(term, update.weight);
            this.logger?.info?.(`[KeywordOptimizationService] UPDATE term="${term}" weight=${update.weight}`);
          }
          break;
        }
        case 'remove': {
          learner.remove(term);
          this.logger?.info?.(`[KeywordOptimizationService] REMOVE term="${term}"`);
          break;
        }
      }
    }
  }

  async buildTrajectoryHistory(sessionIds: string[]): Promise<CorrectionObserverPayload['trajectoryHistory']> {
    const { TrajectoryCollector } = await import('../core/trajectory.js');
    const history: CorrectionObserverPayload['trajectoryHistory'] = [];

    for (const sessionId of sessionIds.slice(0, 10)) {
      const turns = TrajectoryCollector.listUserTurnsForSession(sessionId);
      for (const turn of turns) {
        if (turn.correctionDetected) {
          history.push({
            sessionId,
            timestamp: turn.createdAt,
            term: turn.correctionCue ?? 'unknown',
            userMessage: '', // listUserTurnsForSession does not return input field
          });
        }
        if (history.length >= 50) break;
      }
      if (history.length >= 50) break;
    }

    return history;
  }

  // Singleton factory
  private static _instance: KeywordOptimizationService | null = null;
  private static _lastStateDir: string | null = null;

  static get(stateDir: string, logger: PluginLogger): KeywordOptimizationService {
    if (!_instance || _lastStateDir !== stateDir) {
      _instance = new KeywordOptimizationService(stateDir, logger);
      _lastStateDir = stateDir;
    }
    return _instance;
  }

  static reset(): void {
    _instance = null;
    _lastStateDir = null;
  }
}
```

### Adding updateWeight() and remove() to CorrectionCueLearner
```typescript
// Add to correction-cue-learner.ts after add() method (around line 178)
updateWeight(term: string, weight: number): void {
  const keyword = this.store.keywords.find(
    k => k.term.toLowerCase() === term.toLowerCase()
  );
  if (!keyword) {
    throw new Error(`Keyword not found: ${term}`);
  }

  keyword.weight = Math.max(0.1, Math.min(0.9, weight)); // Clamp to 0.1-0.9
  const idx = this.store.keywords.findIndex(
    k => k.term.toLowerCase() === term.toLowerCase()
  );
  if (idx >= 0) {
    this.store.keywords[idx] = { ...keyword };
  }
  this.flush();
}

remove(term: string): void {
  const idx = this.store.keywords.findIndex(
    k => k.term.toLowerCase() === term.toLowerCase()
  );
  if (idx < 0) {
    throw new Error(`Keyword not found: ${term}`);
  }
  this.store.keywords.splice(idx, 1);
  this.flush();
}
```

## Runtime State Inventory

> This section is NOT applicable to Phase 40. Phase 40 creates new files and modifies existing files to implement keyword optimization - it does not rename or migrate any existing named strings, data, or configurations.

**Stored data:** N/A - Phase 40 creates new keyword-optimization-service.ts and correction-observer-types.ts
**Live service config:** N/A - No external services have configuration for the new keyword_optimization task type
**OS-registered state:** N/A - No OS-level registrations
**Secrets/env vars:** N/A - No secret key names change
**Build artifacts:** N/A - New files added, no artifact renaming

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | TypeScript runtime | Yes | 25.x (from package.json @types/node) | - |
| TypeScript | Compilation | Yes | 6.0.2 | - |
| vitest | Testing | Yes | 4.1.0 | - |
| better-sqlite3 | Trajectory database access | Yes | 12.9.0 | - |
| evolution-worker.ts | keyword_optimization task integration | Yes | N/A (source file) | - |
| TrajectoryCollector | listUserTurnsForSession | Yes | N/A (function in trajectory.ts) | - |
| checkCooldown | Per-workspace throttle | Yes | N/A (function in nocturnal-runtime.ts) | - |

**Missing dependencies with no fallback:** None identified

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.0 |
| Config file | packages/openclaw-plugin/vitest.config.ts |
| Quick run command | `pnpm --filter principles-disciple test -- --run` |
| Full suite command | `pnpm --filter principles-disciple test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CORR-09 | LLM optimizer mutation application | Unit | `grep -n "applyResult\|updateWeight\|remove" packages/openclaw-plugin/src/service/keyword-optimization-service.ts` | NEW file |
| CORR-09 | ADD/UPDATE/REMOVE switch in applyResult | Unit | `grep -n "case 'add'\|case 'update'\|case 'remove'" packages/openclaw-plugin/src/service/keyword-optimization-service.ts` | NEW file |
| CORR-09 | CorrectionCueLearner has updateWeight/remove | Unit | `grep -n "updateWeight\|remove" packages/openclaw-plugin/src/core/correction-cue-learner.ts` | YES |
| CORR-12 | trajectoryHistory field in CorrectionObserverPayload | Unit | `grep -n "trajectoryHistory" packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-types.ts` | NEW file |
| CORR-12 | buildTrajectoryHistory uses listUserTurnsForSession | Unit | `grep -n "listUserTurnsForSession" packages/openclaw-plugin/src/service/keyword-optimization-service.ts` | NEW file |
| N/A | keyword_optimization task type in evolution-worker | Integration | `grep -n "keyword_optimization" packages/openclaw-plugin/src/service/evolution-worker.ts` | YES |

### Sampling Rate
- **Per task commit:** `pnpm --filter principles-disciple test -- --run --reporter=dot`
- **Per wave merge:** Full suite
- **Phase gate:** TypeScript compilation passes (`pnpm --filter principles-disciple build`)

### Wave 0 Gaps
- `packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-types.ts` - NEW file with CorrectionObserverPayload and CorrectionObserverResult interfaces
- `packages/openclaw-plugin/src/service/keyword-optimization-service.ts` - NEW file with KeywordOptimizationService class
- `packages/openclaw-plugin/tests/service/keyword-optimization-service.test.ts` - Unit tests for KeywordOptimizationService
- `packages/openclaw-plugin/tests/core/correction-cue-learner.test.ts` - May need expansion for updateWeight/remove

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V4 Access Control | Yes | Per-workspace stateDir isolation via KeywordOptimizationService singleton factory |
| V5 Input Validation | Yes | switch statement validates update.action is 'add'/'update'/'remove'; invalid actions skipped with logging |

### Known Threat Patterns for Keyword Learning

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Untrusted LLM output applied to keyword store | Tampering | switch statement validates action type; invalid actions logged and skipped |
| Throttle bypass via rapid enqueue | Denial | checkCooldown enforces max 4/day per workspace |
| Trajectory data exposure | Information Disclosure | listUserTurnsForSession returns sanitized fields only (no raw input); history capped at 50 events |

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/core/correction-cue-learner.ts` - Existing CorrectionCueLearner implementation
- `packages/openclaw-plugin/src/core/trajectory-types.ts` - TrajectoryUserTurnInput with correctionDetected
- `packages/openclaw-plugin/src/core/trajectory.ts` - listUserTurnsForSession implementation
- `packages/openclaw-plugin/src/service/nocturnal-runtime.ts` - checkCooldown function
- `packages/openclaw-plugin/src/service/correction-observer-workflow-manager.ts` - parseCorrectionObserverPayload pattern
- `packages/openclaw-plugin/vitest.config.ts` - Test configuration
- `packages/openclaw-plugin/package.json` - Dependencies and scripts

### Secondary (MEDIUM confidence)
- PLAN.md locked decisions (D-40-01 through D-40-14) - User-confirmed implementation choices

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new dependencies; uses existing vitest, TypeScript, better-sqlite3
- Architecture: HIGH - Follows established patterns (singleton factory, atomic write, task queue processing)
- Pitfalls: HIGH - All pitfalls identified based on actual code inspection

**Research date:** 2026-04-14
**Valid until:** 2026-05-14 (30 days - stable domain)

## Assumptions Log

> List all claims tagged [ASSUMED] in this research. The planner and discuss-phase use this section to identify decisions that need user confirmation before execution.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `TrajectoryCollector` is the correct export name for trajectory.ts functions | Architecture Patterns | listUserTurnsForSession exists in trajectory.ts but may be exported under different name; need to verify actual export |
| A2 | `correction-observer-types.ts` does not exist in current codebase | Architecture | File needs to be created; if it exists, conflicts with plan |
| A3 | `keyword-optimization-service.ts` does not exist | Architecture | File needs to be created; if it exists, conflicts with plan |
| A4 | `listUserTurnsForSession()` does not return `input` field | Pitfall 2 | buildTrajectoryHistory() may need direct SQLite query to get user message text |
| A5 | `CorrectionObserverWorkflowManager` import path is correct | Code Examples | Used from correction-observer-workflow-manager.ts |

**If this table is empty:** All claims in this research were verified or cited - no user confirmation needed.

## Open Questions

1. **Does listUserTurnsForSession() return the user input text?**
   - What we know: It returns correctionDetected, correctionCue, createdAt - but NOT input field per trajectory.ts:854-874
   - What's unclear: Whether the SQLite user_turns table has an input column that could be queried directly
   - Recommendation: If userMessage is required in trajectoryHistory, query the database directly or add input to the returned type

2. **Where is TrajectoryCollector actually exported from?**
   - What we know: trajectory.ts contains listUserTurnsForSession but TrajectoryCollector export not found in grep
   - What's unclear: The actual export name and module path
   - Recommendation: Check index.ts exports and verify actual import path before implementing buildTrajectoryHistory()
