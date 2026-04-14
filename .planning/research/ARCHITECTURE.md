# Architecture Research: KeywordLearningEngine

**Domain:** Dynamic keyword learning system for OpenClaw plugin
**Researched:** 2026-04-14
**Confidence:** HIGH

## Executive Summary

The KeywordLearningEngine replaces 15 hardcoded correction cue keywords with a learnable store. The existing codebase already contains a mature pattern in `empathy-keyword-matcher.ts` that can be generalized. The empathy engine tracks weight, hitCount, and falsePositiveRate with LLM-based optimization - the same pattern applies to correction cues with minor adaptations.

## System Overview

```
packages/openclaw-plugin/src/
├── core/
│   ├── empathy-keyword-matcher.ts  ← EXISTING: Learning keyword pattern
│   ├── empathy-types.ts            ← EXISTING: Empathy-specific types
│   ├── keyword-learner.ts          ← NEW: Generalized learning engine
│   ├── keyword-types.ts            ← NEW: Generic keyword types
│   └── correction-cue-matcher.ts   ← NEW: Correction-specific matcher
├── hooks/
│   └── prompt.ts                   ← MODIFY: Replace detectCorrectionCue()
└── service/
    └── subagent-workflow/          ← REUSE: For LLM optimization
```

## Integration Points

### 1. Location Decision: `packages/openclaw-plugin/src/core/`

**Recommendation:** Create new files alongside existing core modules.

**Rationale:**
- `empathy-keyword-matcher.ts` (335 lines) is in `core/` - follows established pattern
- Core modules are imported by hooks; `stateDir` access is already available
- Matches plugin architecture: services in `core/`, hooks in `hooks/`

**Proposed new files:**
| File | Purpose |
|------|---------|
| `core/keyword-types.ts` | Generic types extractable from empathy-types.ts |
| `core/keyword-learner.ts` | Generic keyword learning engine (port empathy pattern) |
| `core/correction-cue-matcher.ts` | Correction-specific matching (thin wrapper) |

### 2. Abstraction Level: Two-Layer Design

**Recommendation:** Generic base class + correction-specific subclass.

```
KeywordLearner (base)
├── tracks: weight, hitCount, falsePositiveRate, source
├── methods: match(), load(), save(), shouldOptimize(), applyUpdates()
└── subclasses:
    └── CorrectionCueLearner (correction-specific)
        ├── hardcoded seed keywords (migrated from detectCorrectionCue)
        ├── higher weight for "你理解错了" type phrases
        └── lower falsePositiveRate threshold for correction context
```

**Rationale:**
- Empathy and correction cues have different severity semantics
- Empathy tracks mild/moderate/severe; correction is binary (detected/not)
- Mixing concerns in a single generic engine leads to convoluted config objects
- Subclass can override matching logic without affecting empathy behavior

**Alternative rejected:** Single generic engine with category parameter
- Would require nullable fields for category-specific properties
- Empathy needs `severity` mapping; correction needs `confidence` threshold
- The two concerns diverge enough to warrant separate classes

### 3. Integration with hooks/prompt.ts

**Current state (lines 87-111):**
```typescript
function detectCorrectionCue(text: string): string | null {
  const normalized = text.trim().toLowerCase()...
  const cues = ['不是这个', '不对', '错了', ...];  // 15 hardcoded keywords
  return cues.find((cue) => normalized.includes(cue)) ?? null;
}
```

**Replacement approach:**

Step 1: Create `CorrectionCueLearner` class that:
- Uses the same `matchEmpathyKeywords` pattern but with correction-specific config
- Seed keywords migrate from the hardcoded list (with adjustments)
- No severity mapping (correction is binary detection)

Step 2: In `prompt.ts`, add module-level cache:
```typescript
let _correctionCueCache: { learner: CorrectionCueLearner; lang: string } | null = null;
```

Step 3: Replace `detectCorrectionCue()`:
```typescript
function detectCorrectionCue(text: string): string | null {
  if (!_correctionCueCache) {
    const lang = wctx.config.get('language') as 'zh' | 'en' || 'zh';
    _correctionCueCache = {
      learner: new CorrectionCueLearner(wctx.stateDir, lang),
      lang
    };
  }
  const result = _correctionCueCache.learner.match(text);
  return result.matched ? result.matchedTerms[0] : null;
}
```

**Changes to trajectory recording (line 334):**
```typescript
// BEFORE
const correctionCue = detectCorrectionCue(userText);

// AFTER
const matchResult = correctionLearner.match(userText);
const correctionCue = matchResult.matched ? matchResult.matchedTerms[0] : null;
```

### 4. State Management: Single Store per Category

**Recommendation:** File `correction_keywords.json` (not a general multi-category store)

**Rationale:**
- Empathy uses `empathy_keywords.json` - follows this pattern
- Correction cues are semantically different from empathy keywords
- A single category-specific file is simpler than multi-category store
- File location: `stateDir/correction_keywords.json`

**Store structure:**
```typescript
interface CorrectionKeywordEntry {
  weight: number;           // 0-1, contribution to detection confidence
  source: 'seed' | 'llm_discovered' | 'user_reported';
  hitCount: number;
  lastHitAt?: string;
  falsePositiveRate: number;  // 0-1, how often this matches non-correction
  examples?: string[];
  discoveredAt?: string;
}

interface CorrectionKeywordStore {
  version: number;
  lastUpdated: string;
  lastOptimizedAt: string;
  terms: Record<string, CorrectionKeywordEntry>;
  stats: {
    totalHits: number;
    totalFalsePositives: number;
    optimizationCount: number;
  };
}
```

**Key difference from empathy:**
- No `severity` field (correction is binary)
- No `penaltyMild/Moderate/Severe` config (not GFI-based)
- Different seed keywords: correction-specific phrases

**Seed keywords migration (from prompt.ts lines 92-109):**
```typescript
const CORRECTION_SEED_KEYWORDS: SeedKeywordEntry[] = [
  // Chinese correction phrases
  { term: '不是这个', weight: 0.6, category: 'correction', initialFalsePositiveRate: 0.15 },
  { term: '不对', weight: 0.5, category: 'correction', initialFalsePositiveRate: 0.25 },
  { term: '错了', weight: 0.5, category: 'correction', initialFalsePositiveRate: 0.25 },
  { term: '搞错了', weight: 0.5, category: 'correction', initialFalsePositiveRate: 0.2 },
  { term: '你理解错了', weight: 0.7, category: 'correction', initialFalsePositiveRate: 0.1 },
  { term: '重新来', weight: 0.6, category: 'correction', initialFalsePositiveRate: 0.15 },
  { term: '再试一次', weight: 0.4, category: 'correction', initialFalsePositiveRate: 0.2 },
  // English correction phrases
  { term: 'you are wrong', weight: 0.7, category: 'correction', initialFalsePositiveRate: 0.15 },
  { term: 'wrong file', weight: 0.6, category: 'correction', initialFalsePositiveRate: 0.2 },
  { term: 'not this', weight: 0.4, category: 'correction', initialFalsePositiveRate: 0.3 },
  { term: 'redo', weight: 0.6, category: 'correction', initialFalsePositiveRate: 0.15 },
  { term: 'try again', weight: 0.4, category: 'correction', initialFalsePositiveRate: 0.2 },
  { term: 'again', weight: 0.3, category: 'correction', initialFalsePositiveRate: 0.35 },
  { term: 'please redo', weight: 0.6, category: 'correction', initialFalsePositiveRate: 0.15 },
  { term: 'please try again', weight: 0.5, category: 'correction', initialFalsePositiveRate: 0.2 },
];
```

### 5. LLM Optimization Integration

**Recommendation:** Reuse existing `EmpathyObserverWorkflowManager` and `empathyObserverWorkflowSpec`

**Evidence from prompt.ts (lines 554-586):**
```typescript
if (shouldTriggerOptimization(keywordStore, turnCount)) {
  const recentMessages = extractRecentMessages(event.messages, 10);
  const optimizationPrompt = buildOptimizationPrompt(keywordStore, recentMessages);

  const empathyManager = new EmpathyObserverWorkflowManager({
    workspaceDir,
    logger: api.logger ?? console,
    subagent: api.runtime.subagent as any,
  });

  empathyManager.startWorkflow(empathyObserverWorkflowSpec, {
    parentSessionId: sessionId,
    workspaceDir,
    taskInput: { prompt: optimizationPrompt },
  });
}
```

**For correction optimization:**
- Same workflow spec works
- Need correction-specific `buildCorrectionOptimizationPrompt()`
- Same trigger logic: turn count + time-based interval

**Optimization prompt adaptation:**
```
## TASK
Analyze recent user messages and the current correction keyword store.
Return STRICT JSON (no markdown):
{"updates": {"TERM": {"action": "add|update|remove", "weight": number, "falsePositiveRate": number, "reasoning": "string"}}}

## Rules:
- ADD: If a message explicitly rejects/corrects agent output (not general frustration)
- UPDATE: High hits → increase weight; low hits → decrease
- REMOVE: 0 hits after many turns AND high false positive rate (>0.3)
- Weight range: 0.1-0.9, falsePositiveRate range: 0.05-0.5
```

### 6. Reusability: Empathy Engine Could Use Abstraction (Post-Milestone)

**Current empathy-keyword-matcher.ts:**
- 335 lines, self-contained
- Has its own seed keywords, matching logic, optimization

**Refactoring opportunity (post-milestone):**
```typescript
// keyword-learner.ts (generic base)
class KeywordLearner<T extends KeywordEntry> {
  match(text: string): MatchResult { ... }
  shouldOptimize(): boolean { ... }
  applyUpdates(updates: Record<string, KeywordUpdate>): void { ... }
}

// empathy-keyword-matcher.ts (post-refactor)
class EmpathyLearner extends KeywordLearner<EmpathyKeywordEntry> {
  // Empathy-specific: severity mapping, penalty calculation
}
```

**Not in scope for this milestone:** Refactoring empathy-keyword-matcher.ts is separate work.

## Architectural Patterns

### Pattern 1: Keyword Learning Loop

**What:** User message -> keyword match -> weighted score -> action -> periodic LLM optimization -> store update

**When to use:** When keyword-based detection needs to learn from false positives

**Trade-offs:**
- Pro: Fast matching (<1ms for typical stores)
- Pro: Transparent learned weights
- Con: Requires periodic LLM calls for optimization
- Con: Initial seed keywords may need tuning

**Code structure:**
```typescript
class KeywordLearner {
  private store: KeywordStore;
  private config: KeywordConfig;

  match(text: string): MatchResult {
    // 1. Normalize text
    // 2. Check each term (O(n) where n = keyword count)
    // 3. Calculate weighted score
    // 4. Update hitCount for matches
    // 5. Return result with matched terms
  }

  shouldOptimize(): boolean {
    // Check turn count threshold
    // Check time interval threshold
  }
}
```

### Pattern 2: Module-Level Cache (Per-Request Optimization)

**What:** Cache keyword store in module-level variable to avoid per-turn I/O

**Evidence from prompt.ts (lines 24-25):**
```typescript
let _empathyTurnCounter = 0;
let _empathyKeywordCache: { store: ReturnType<typeof loadKeywordStore>; lang: string } | null = null;
```

**When to use:** When store is loaded on every request but rarely changes

**Trade-offs:**
- Pro: Avoids fs.readFileSync on every prompt hook call
- Pro: Single save after match (not on every turn)
- Con: Module reload resets cache (but store persists on disk)
- Con: Multi-instance environments share cache (not an issue for single OpenClaw instance)

### Pattern 3: Workflow-Based Optimization

**What:** Use subagent workflow for async keyword optimization

**Evidence from prompt.ts (lines 525-544):**
```typescript
if (shouldCallSubagent && runtimeSubagent) {
  const empathyManager = new EmpathyObserverWorkflowManager({
    workspaceDir,
    logger: api.logger ?? console,
    subagent: runtimeSubagent as any,
  });
  empathyManager.startWorkflow(empathyObserverWorkflowSpec, {
    parentSessionId: sessionId,
    workspaceDir,
    taskInput: latestUserMessage,
  });
}
```

**When to use:** When optimization runs asynchronously and shouldn't block prompt hook

**Trade-offs:**
- Pro: Non-blocking, runs in background
- Pro: Shares subagent infrastructure with other workflows
- Con: Adds complexity (workflow manager, spec, error handling)
- Con: Results come on next turn (not immediate)

## Data Flow

### Correction Detection Flow

```
User Message
    ↓
detectCorrectionCue() [prompt.ts:334]
    ↓
CorrectionCueLearner.match() [correction-cue-matcher.ts]
    ↓
Returns: { matched: boolean, matchedTerms: string[], score: number }
    ↓
wctx.trajectory.recordUserTurn() [prompt.ts:346-353]
    ↓
Recorded in trajectory (sessionId, turnIndex, correctionDetected, correctionCue)
```

### Keyword Optimization Flow

```
Turn Counter (per session)
    ↓
shouldTriggerOptimization() [keyword-learner.ts or correction-cue-matcher.ts]
    ↓
buildCorrectionOptimizationPrompt() [same file]
    ↓
EmpathyObserverWorkflowManager.startWorkflow()
    ↓
Subagent runs optimization analysis
    ↓
applyKeywordUpdates() [keyword-learner.ts]
    ↓
saveKeywordStore() → correction_keywords.json
```

## New vs Modified Components

| Component | Action | Reason |
|-----------|--------|--------|
| `core/keyword-types.ts` | CREATE | Generic types extractable from empathy-types.ts |
| `core/keyword-learner.ts` | CREATE | Base class for keyword learning (port from empathy) |
| `core/correction-cue-matcher.ts` | CREATE | Correction-specific learner with seed keywords |
| `hooks/prompt.ts` | MODIFY | Replace `detectCorrectionCue()` with learner-based detection |
| `empathy-keyword-matcher.ts` | MODIFY | May extract generic types (no behavior change needed) |
| `empathy-types.ts` | MODIFY | May need type extraction to keyword-types.ts |

## Build Order

1. **Phase 1:** Create `keyword-types.ts` with generic interfaces
2. **Phase 2:** Create `keyword-learner.ts` base class (port matching logic from empathy)
3. **Phase 3:** Create `correction-cue-matcher.ts` with seed keywords
4. **Phase 4:** Modify `prompt.ts` to use `CorrectionCueLearner`
5. **Phase 5:** Add optimization prompt builder and trigger logic
6. **Phase 6:** Integration test with trajectory recording

## Anti-Patterns

### Anti-Pattern 1: Over-Generalizing Too Early

**What people do:** Create a single `KeywordLearner` that tries to handle all keyword learning use cases

**Why it's wrong:** Empathy and correction have different semantics (severity vs binary). Forcing them into one class leads to nullable fields and convoluted config objects.

**Do this instead:** Start with a base class that shares matching logic, but keep category-specific behavior in subclasses.

### Anti-Pattern 2: Per-Turn I/O

**What people do:** Load/save keyword store on every turn

**Why it's wrong:** fs.readFileSync on every prompt hook adds latency; fs.writeFileSync on every match is wasteful.

**Do this instead:** Module-level cache with lazy loading, save only on match.

### Anti-Pattern 3: Mixing Detection and Trajectory Recording

**What people do:** Embed trajectory recording inside keyword matching function

**Why it's wrong:** Violates single responsibility; makes testing harder.

**Do this instead:** Return match result from learner, let caller decide what to record.

### Anti-Pattern 4: Creating Separate Optimization Workflow

**What people do:** Create a new workflow type for correction optimization

**Why it's wrong:** The EmpathyObserverWorkflowManager already handles keyword optimization. Reusing it reduces code duplication and maintenance burden.

**Do this instead:** Reuse `empathyObserverWorkflowSpec` with correction-specific prompt builder.

## Sources

- `packages/openclaw-plugin/src/hooks/prompt.ts` (detectCorrectionCue at line 87, empathy integration at 461-604)
- `packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts` (existing learning pattern - 335 lines)
- `packages/openclaw-plugin/src/core/empathy-types.ts` (type definitions)
- `packages/openclaw-plugin/src/service/subagent-workflow/` (optimization workflow)

---

*Architecture research for: KeywordLearningEngine*
*Researched: 2026-04-14*
