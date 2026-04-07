# PD Functional Design Analysis

**Date**: 2026-04-07

---

## Core Signal Chain (What PD really needs)

The essential path for PD to achieve its mission ("transform failures/frustrations into growth/principles") consists of **5 critical files**:

| Priority | File | Purpose |
|----------|------|---------|
| 1 | `hooks/pain.ts` | Captures pain signals (tool failures, manual interventions) |
| 2 | `core/evolution-reducer.ts` | Event processor: pain→candidate→probation→active principle lifecycle |
| 3 | `core/evolution-engine.ts` | EP (Evolution Points) system: tier-based permissions, growth tracking |
| 4 | `hooks/gate.ts` | Security gate: blocks/allows operations based on tier + risk |
| 5 | `hooks/prompt.ts` | Context injection: principles get into LLM prompts |

**Bare minimum chain**: `hooks/pain.ts` → `core/evolution-reducer.ts` → `core/evolution-engine.ts` → `hooks/prompt.ts`

---

## Module Necessity Classification

| Module | Classification | Rationale |
|--------|---------------|-----------|
| `core/evolution-engine.ts` | **CORE** | EP system IS the growth mechanism. Without it, PD is just a pain tracker. |
| `core/evolution-reducer.ts` | **CORE** | Principle lifecycle management. The state machine for pain→principle. |
| `hooks/pain.ts` | **CORE** | Primary pain signal capture. The entry point. |
| `hooks/gate.ts` | **CORE** | Without gates, principles have no enforcement teeth. |
| `hooks/prompt.ts` | **CORE** | Principles must reach the LLM to affect behavior. |
| `core/pain.ts` | **CORE** | Pain flag contract and scoring. Well-designed single source of truth. |
| `core/session-tracker.ts` | **CORE** | GFI is the fatigue metric that drives attitude overrides. |
| `core/profile.ts` | **CORE** | Risk path configuration is essential for gate decisions. |
| `service/evolution-worker.ts` | **SUPPORTING** | Background heartbeat processing. Heavy, complex, but processes the queue. |
| `core/trajectory.ts` | **SUPPORTING** | Analytics database. Massive scope creep. Core doesn't need it. |
| `service/subagent-workflow/*` | **SUPPORTING** | Empathy/deep-reflect workflows. Enhancement, not core. |
| `core/shadow-observation-registry.ts` | **OPTIONAL** | Shadow routing evidence. Future promotion gate feature. |
| `core/nocturnal-trinity.ts` | **OPTIONAL** | Multi-stage reflection for training data generation. |
| `commands/nocturnal-*.ts` | **OPTIONAL** | CLI for nocturnal operations. |

---

## Disconnected/Orphaned Features

### 1. PAIN_CANDIDATES - Legacy Pain Processing
**Two parallel pain-to-principle systems:**

Path A (modern):
```
hooks/pain.ts → emitSync(pain_detected) → evolution-reducer.ts
```

Path B (legacy - PAIN_CANDIDATES):
```
hooks/pain.ts → trackPainCandidate() → PAIN_CANDIDATES file → processPromotion() → dictionary.addRule()
```

**Problem**: PAIN_CANDIDATES path does NOT update evolution-reducer. These are TWO DIFFERENT principle storage systems. The legacy path runs but doesn't affect core.

### 2. Trajectory Writes - Core Doesn't Read
- `core/trajectory.ts` writes extensively: `recordToolCall`, `recordPainEvent`, `recordGateBlock`, etc.
- **Core pain→evolution pipeline does NOT read from trajectory**
- Only nocturnal reads it
- **Assessment**: 1673 lines of analytics that core doesn't consume - significant scope creep

### 3. Shadow-Observation Registry - Designed But Not Wired
- `recordShadowRouting()`, `completeShadowObservation()` write data
- `computeShadowStats()` exists in `promotion-gate.ts`
- **But** promotion gate doesn't actively query it, no observations are being recorded
- This is a "future-proofing feature" that isn't connected yet

### 4. Nocturnal Output - Training Data Only, Not Internal Principles
- Nocturnal produces `TrinityDraftArtifact` with `badDecision`, `betterDecision`, `rationale`
- These are training samples for external ORPO training
- They do NOT become active principles in `evolution-reducer`
- **Two parallel systems**: internal principle system vs external training data system

### 5. Evolution Logger - One-Write, No Reader
- `core/evolution-logger.ts` writes to `evolution.log`
- No service reads from this log for control decisions
- Purely diagnostic

---

## Design Pattern Issues

### 1. evolution-worker.ts - 1785 lines, 5 responsibilities
Single file handles:
- Queue management (EVOLUTION_QUEUE)
- Pain candidate processing (PAIN_CANDIDATES)
- Sleep reflection task scheduling
- Workflow lifecycle (empathy, deep-reflect, nocturnal)
- Lock management
- Pain detection processing
- Multiple hook handlers

**Should be split into**: `pain-detection-service.ts`, `queue-manager.ts`, `workflow-coordinator.ts`

### 2. trajectory.ts - 1673 lines, God Class
Manages 12+ record types (sessions, turns, tool calls, pain events, gate blocks, trust changes), JSONL files, blob storage, export functionality, multiple query methods.

**Core doesn't read from it** - it's analytics bloat.

### 3. Two Parallel Pain-Processing Systems
The PAIN_CANDIDATES legacy path predates the current event-sourcing approach. They do the same thing differently and don't share state.

### 4. Workflow Manager Duplication (~70% identical)
Three managers with identical patterns, only `buildPrompt()` differs:
- `EmpathyObserverWorkflowManager` (~24KB)
- `DeepReflectWorkflowManager` (~20KB)
- `NocturnalWorkflowManager` (~43KB)

### 5. Nocturnal Trinity Interface Over-Abstraction
Stub implementations are standalone functions, but real implementation is a class adapter with 300+ lines of session management boilerplate.

---

## Nocturnal Trinity Assessment

**Purpose**: External training data generation pipeline
```
Session trajectory → Trinity (Dreamer→Philosopher→Scribe) → Artifact → Export → ORPO Training
```

**Connection to Core**: DISCONNECTED
- Nocturnal reads from trajectory database
- Nocturnal outputs for external training
- But these artifacts do NOT become active principles in evolution-reducer
- Internal PD system and external system are parallel pipes, not integrated

**Assessment**: OPTIONAL - Valuable standalone research system, but NOT part of core pain→evolution→principle chain

---

## Pain→Evolution Pipeline - Critical Gap

**Current issue in `evolution-reducer.ts:onPainDetected()` (line 615-665)**:
- Only records pain for tracking
- Has circuit breaker logic for subagent errors
- **Does NOT create principles** - comments say "Principle creation is now deferred to diagnostician analysis"

**The principle creation path is INCOMPLETE** - there's a TODO where principle creation should happen.

The intended flow:
```
pain_detected event → evolution-reducer.onPainDetected() →
   diagnostician analyzes → createPrincipleFromDiagnosis()
```

But `createPrincipleFromDiagnosis()` is not wired from anywhere in the current heartbeat flow.

---

## Constants Assessment

**`constants/` only 2 files** - minimal and appropriately used:
- `diagnostician.ts` - DIAGNOSTICIAN_PROTOCOL_SUMMARY (used in heartbeat injection)
- `tools.ts` - Tool classification (READ_ONLY_TOOLS, WRITE_TOOLS, BASH_TOOLS_SET)

**Assessment**: Appropriate use - constants that ARE used, not decoration.

---

## Recommendations

### Keep (Core - 7 files)
1. `hooks/pain.ts`
2. `core/evolution-reducer.ts`
3. `core/evolution-engine.ts`
4. `hooks/gate.ts`
5. `hooks/prompt.ts`
6. `core/pain.ts`
7. `core/session-tracker.ts`

### Simplify
1. **`evolution-worker.ts` (1785 lines)** → Split into 3 services
2. **`trajectory.ts` (1673 lines)** → Strip to essential only, or make optional
3. **PAIN_CANDIDATES system** → Either integrate into evolution-reducer OR remove completely

### Remove/Defer
1. **Shadow-observation-registry** → Not wired, maintain only when promotion gate actually uses it
2. **Parallel workflow managers** → Extract `BaseWorkflowManager` class
3. **Nocturnal Trinity** → OK as optional if purpose understood (training data gen, not internal improvement)

### Investigate
1. **Principle creation gap** - Is `createPrincipleFromDiagnosis()` wired? From where?
2. **Trajectory usage** - If only nocturnal reads it and nocturnal is optional, trajectory could be optional too

---

## Architecture Health Score: 6/10

- ✅ Core signal chain is sound
- ❌ Two parallel pain-processing paths (PAIN_CANDIDATES vs evolution-reducer)
- ❌ Nocturnal is sophisticated but disconnected from core
- ❌ Workflow managers have significant duplication (~70%)
- ❌ trajectory.ts is scope creep that core doesn't consume
- ⚠️ Principle creation path has a gap (TODO in onPainDetected)
