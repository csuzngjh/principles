# Nocturnal Control Plane — Operator Guide

> **Audience**: Operators, DevOps, and developers who maintain Principles Disciple
> **Goal**: Explain how the Nocturnal Evolution control loop works, where state lives, and how to diagnose issues
> **Constraint**: No algorithm internals — focus on plumbing, state, and control flow

---

## 1. Design Principles

### 1.1 We Do Not Modify OpenClaw Internals

Nocturnal Evolution is built entirely on **public plugin capabilities**:

- `api.runtime.subagent.*` — Trinity orchestration (Dreamer / Philosopher / Scribe)
- `api.on('before_prompt_build')` — Routing guidance injection
- `api.on('subagent_spawning')` / `api.on('subagent_ended')` — Shadow observation collection
- `api.on('after_tool_call')` — Pain signal detection

We read OpenClaw state through public APIs. We write through plugin-managed registries. We do **not** hook into OpenClaw's internal agent selection logic, scheduler, or session routing engine.

### 1.2 Routing is a Governance Layer, Not an Authoritative Router

The system does **not** take over task routing from OpenClaw. Instead:

- The main agent receives **non-binding delegation suggestions** in its system prompt
- Real runtime evidence comes from **actual subagent lifecycle hooks** — not from command intercepts
- Promotion decisions combine **offline benchmark evidence** (eval delta) with **runtime shadow evidence**
- The operator (or automated orchestrator) makes the final approval at each promotion gate

This means the routing control loop is a **governance overlay** — explainable, auditable, and rollback-safe — built on top of OpenClaw's existing capabilities.

### 1.3 Fail-Closed

Any ambiguity in the promotion pipeline defaults to **stay_main / no routing**:
- Unknown checkpoint state → do not route
- Shadow evidence insufficient → do not promote
- Any regression beyond threshold → block promotion
- Rollback target not available → block promotion

---

## 2. State Architecture

### 2.1 State Directory Layout

All Nocturnal Evolution state lives under `.state/` within each workspace:

```
.principles/
├── PROFILE.json              # Workspace profile (not Nocturnal-specific)
└── PROMPT_CACHE/

.state/
├── evolution_queue.json      # Pending evolution tasks (pain + idle)
├── trajectory.db             # SQLite: all session trajectories
├── principle_internalization.json  # Per-principle compliance stats
│
├── training/
│   ├── experiments/         # TrainingExperimentSpec records
│   │   └── experiment-{id}.json
│   └── results/             # TrainingExperimentResult records
│       └── result-{id}.json
│
├── eval/
│   └── summaries/           # EvalSummary records per checkpoint
│       └── eval-{checkpoint-id}.json
│
├── deployment/               # ModelDeploymentRegistry
│   └── {profile}/
│       └── active_checkpoint.json   # Currently active checkpoint
│
├── shadow/                  # ShadowObservationRegistry
│   └── observations/
│       └── {profile}/
│           └── {checkpoint-id}.jsonl
│
└── rollback/
    └── {profile}/
        └── previous_checkpoint.json
```

### 2.2 Key Registries

| Registry | File(s) | Purpose |
|----------|---------|---------|
| **Training Registry** | `.state/training/experiments/`, `.state/training/results/` | Records experiment specs and results, including lineage |
| **Eval Registry** | `.state/eval/summaries/` | Records benchmark eval summaries per checkpoint |
| **Deployment Registry** | `.state/deployment/{profile}/` | Records which checkpoint is active per profile |
| **Shadow Registry** | `.state/shadow/observations/` | Records runtime shadow observations (task outcomes, errors) |
| **Promotion State** | In-memory in `promotion-gate.ts` backed by deployment registry | Tracks promotion state machine per checkpoint |

### 2.3 Promotion State Machine

```
                    ┌──────────────────────────────────────────┐
                    │            PROMOTION STATE MACHINE        │
                    │                                          │
                    │  rejected                               │
                    │      │                                  │
                    │      ▼                                  │
                    │  candidate_only ──── eval not ready      │
                    │      │                                  │
                    │      │ eval attached + lineage OK        │
                    │      ▼                                  │
                    │  shadow_ready ◄─── benchmark passes     │
                    │      │            + no regressions       │
                    │      │                                  │
                    │      │ shadow window complete             │
                    │      │ + orchestrator review OK           │
                    │      │ + rollback target preserved        │
                    │      ▼                                  │
                    │  promotable ◄─── explicit approval       │
                    │      │                                  │
                    │      │ operator enables                  │
                    │      ▼                                  │
                    │    deployed                             │
                    └──────────────────────────────────────────┘

Transitions are one-way (except rejected → shadow_ready if re-evaluated).
```

---

## 3. Shadow Evidence System

### 3.1 What is Shadow Evidence?

Shadow evidence is **real runtime observation data** collected when the main agent routes a task to an experimental checkpoint in shadow mode. It answers: *"Did the experimental adapter actually perform better in practice?"*

### 3.2 How Shadow Evidence is Collected

```
Main Agent (before_prompt_build)
    │
    │ Receives routing guidance suggestion
    │ Decides whether to route (has full discretion)
    │
    ├────────────────────────────────────────────┐
    │ Hook: subagent_spawning                     │
    │  → If target profile is PD_LOCAL_PROFILES   │
    │    (local-reader or local-editor)           │
    │  → recordShadowRouting() called            │
    │  → Creates observation record with:         │
    │    - checkpointId                          │
    │    - task fingerprint                      │
    │    - routing timestamp                      │
    └────────────────────────────────────────────┘
                    │
                    ▼
         Experimental checkpoint handles task
                    │
    ┌───────────────┴────────────────────────────┐
    │ Hook: subagent_ended                        │
    │  → completeShadowObservation() called     │
    │  → Records: success/failure, error_type,   │
    │    principalViolations, outcome            │
    └────────────────────────────────────────────┘
                    │
                    ▼
         ShadowObservationRegistry
         → Accumulates in .state/shadow/observations/
         → computeShadowStats() aggregates stats
```

### 3.3 Shadow Observation Data

Each shadow observation records:

```typescript
interface ShadowObservation {
  observationId: string;
  checkpointId: string;
  taskFingerprint: string;     // Hash of task type + scope
  routingTimestamp: string;   // ISO
  completionTimestamp: string; // ISO
  outcome: 'success' | 'failure' | 'error';
  errorType?: string;
  principalViolations: string[];  // Which T-xx were violated
  wasOverridden: boolean;      // Main agent had to intervene
}
```

### 3.4 How to View Shadow Evidence

**File-based**: Each profile/checkpoint has a JSONL file:

```
.state/shadow/observations/{profile}/{checkpoint-id}.jsonl
```

Each line is a `ShadowObservation` object. Read with:

```bash
cat .state/shadow/observations/local-reader/ckpt-abc123.jsonl | jq
```

**In-code**: Use `computeShadowStats(stateDir, checkpointId)` from `shadow-observation-registry.ts` to get aggregated statistics:

```typescript
interface ShadowStats {
  totalObservations: number;
  successCount: number;
  failureCount: number;
  errorRate: number;
  principalViolationCounts: Record<string, number>;
  overrideRate: number;
  meanLatencyMs?: number;
}
```

### 3.5 Minimum Evidence Threshold

`MIN_OBSERVATIONS_FOR_TRUST = 5` — A checkpoint needs at least 5 shadow observations before its runtime evidence is considered meaningful for promotion decisions.

### 3.6 Shadow Evidence Weight in Promotion

`SHADOW_EVIDENCE_WEIGHT = 0.6` — In `evaluatePromotionGate()`, runtime shadow evidence accounts for **60%** of the promotion decision weight, while offline benchmark delta accounts for **40%**.

This ensures promotion is driven by **real-world performance**, not just synthetic benchmarks.

---

## 4. Promotion Gate — Deep Dive

### 4.1 Gate Evaluation Flow

```
evaluatePromotionGate(stateDir, checkpointId)
    │
    ├─► getDeployment(profile) → get active checkpointId
    │
    ├─► getPromotionState(stateDir, checkpointId)
    │       Returns: 'rejected' | 'candidate_only' | 'shadow_ready' | 'promotable' | 'deployed'
    │
    ├─► fetchEvalSummary(checkpointId)
    │       Returns: reduced_prompt_holdout_delta, arbiterRejectRate, ...
    │
    ├─► computeShadowStats(stateDir, checkpointId)
    │       Returns: { successRate, errorRate, overrideRate, ... }
    │
    ├─► applyDecisionMatrix(currentState, evalSummary, shadowStats)
    │       → nextState
    │       → blockers[] (if rejected)
    │
    └─► return { canPromote, nextState, blockers, shadowSufficient }
```

### 4.2 Shadow-Ready Gate Checks

Before a checkpoint can move from `candidate_only` → `shadow_ready`:

| Metric | Requirement |
|--------|------------|
| `reduced_prompt_holdout_delta` | > `minDelta` threshold |
| `arbiterRejectRate` | <= `baseline + allowedMargin` |
| `executabilityRejectRate` | <= `baseline + allowedMargin` |
| `reviewedSubsetQuality` | >= `baseline` |

### 4.3 Promotable Gate Checks

Before a checkpoint can move from `shadow_ready` → `promotable`:

| Metric | Requirement |
|--------|------------|
| Shadow window | Must be complete (time-based) |
| Orchestrator review | Must be explicitly approved |
| Rollback target | Must be available and valid |

### 4.4 Reading Promotion Blockers

When a checkpoint cannot advance, `evaluatePromotionGate()` returns `blockers[]` — a list of human-readable reasons. Example:

```json
{
  "canPromote": false,
  "nextState": "shadow_ready",
  "blockers": [
    "reduced_prompt_holdout_delta 0.03 < minDelta 0.05",
    "arbiterRejectRate regression 0.08 > allowedMargin 0.05"
  ],
  "shadowSufficient": true
}
```

---

## 5. Rollback

### 5.1 When to Rollback

Trigger rollback immediately when:

- Routing error rate spikes (e.g., >5% increase)
- Benchmark lineage becomes invalid (base model changed, eval harness bug discovered)
- Deployment state becomes inconsistent
- Orchestration review rejects too many worker outputs
- You deployed a checkpoint that later shows regressions

### 5.2 How Rollback Works

The deployment registry for each profile stores:

```
.state/deployment/{profile}/
├── active_checkpoint.json   # Currently active (might be bad)
└── previous_checkpoint.json # Last known good (rollback target)
```

On rollback:
1. `active_checkpoint.json` is updated to point to `previous_checkpoint.json`
2. Routing immediately switches to the previous checkpoint
3. The bad checkpoint's state is set to `rejected`
4. No new shadow routing occurs to the bad checkpoint

### 5.3 Preserving Rollback Targets

The promotion contract **requires** that every promotion from `shadow_ready` → `promotable` must verify a rollback target exists. The previous checkpoint is never deleted on promotion — it is only archived (marked `rejected`) when a newer checkpoint reaches `deployed`.

---

## 6. Routing Control Loop — How It Works

### 6.1 The Loop

```
┌──────────────────────────────────────────────────────────────┐
│                    ROUTING CONTROL LOOP                       │
│                                                               │
│  ① before_prompt_build hook fires                            │
│      → classifyTask() evaluates latest user message          │
│      → If task is bounded + deployable checkpoint exists      │
│         → Inject <routing_guidance> into system prompt        │
│                                                               │
│  ② Main agent reads guidance (or ignores it)                  │
│      → Has FULL discretion to follow or not                  │
│      → guidance is labeled "non-authoritative suggestion"    │
│                                                               │
│  ③ If main agent routes to local-worker:                    │
│      → subagent_spawning hook fires                          │
│      → ShadowObservation recorded                            │
│                                                               │
│  ④ Task executes on local-worker                             │
│      → subagent_ended hook fires                             │
│      → ShadowObservation completed with outcome               │
│                                                               │
│  ⑤ Shadow stats accumulate                                   │
│      → computeShadowStats() aggregates observation data       │
│                                                               │
│  ⑥ Promotion gate evaluates                                  │
│      → Offline eval (40%) + runtime shadow (60%)             │
│      → Decision: promote / stay / rollback                   │
│                                                               │
│  ⑦ Operator approves at each gate                           │
│      → Loop continues or terminates                          │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 Why Not an Authoritative Router?

An authoritative router would mean: *"The system decides where tasks go and the main agent cannot override."* This is:

1. **Unsafe** — OpenClaw's internal scheduling is not ours to control
2. **Fragile** — Changes to OpenClaw internals break the plugin
3. **Non-auditable** — You cannot see why a routing decision was made
4. **Not rollback-safe** — If the router is wrong, nothing reverts

Instead, we use **governance through guidance**: the main agent is always informed, always free to override, and the promotion pipeline ensures only well-evidenced checkpoints ever get routing access.

---

## 7. Local Worker Routing — Decision Taxonomy

The `classifyTask()` function in `local-worker-routing.ts` makes all routing decisions:

| Classification | Meaning | Routing Decision |
|---------------|---------|-----------------|
| `reader_eligible` | Task is read/inspect — suitable for `local-reader` | `route_local` |
| `editor_eligible` | Task is bounded edit/fix — suitable for `local-editor` | `route_local` |
| `high_entropy_disallowed` | Task is too complex, ambiguous, or open-ended | `stay_main` |
| `risk_disallowed` | Task involves risk signals (destructive, production) | `stay_main` |
| `ambiguous_scope` | Task description too vague to classify | `stay_main` |
| `deployment_unavailable` | No enabled deployment for the natural target profile | `stay_main` |
| `profile_mismatch` | Task doesn't match the requested profile | `stay_main` |

The function is **pure policy** — it has no side effects, no learning, and no dynamic adaptation. Every decision is deterministic and explainable.

---

## 8. Why We Don't Depend on OpenClaw Internal Interfaces

| What We Use | What We Avoid |
|-------------|--------------|
| `api.runtime.subagent.*` | OpenClaw's internal agent scheduler |
| `api.on('subagent_*')` hooks | OpenClaw's session routing engine |
| `api.resolvePath()` for file paths | Hardcoded path assumptions |
| Public `before_prompt_build` hook | OpenClaw's prompt construction internals |
| Plugin-managed registries | OpenClaw's internal state stores |

This means:
- Plugin upgrades do not break Nocturnal Evolution (as long as public APIs are stable)
- We can audit exactly what state we read and write
- Rollback is always possible because we control the registry
- The system works the same way regardless of which LLM backend OpenClaw uses

---

## 9. Diagnostic Commands

### Check promotion state of a checkpoint

```bash
# Read the active checkpoint for local-reader
cat .state/deployment/local-reader/active_checkpoint.json

# Read checkpoint lineage
cat .state/training/results/result-{checkpoint-id}.json | jq '.lineage'
```

### Check shadow evidence

```bash
# Count observations
wc -l .state/shadow/observations/local-reader/{checkpoint-id}.jsonl

# Get aggregated stats (in code)
node -e "
const { computeShadowStats } = require('./dist/core/shadow-observation-registry.js');
console.log(JSON.stringify(computeShadowStats('/path/to/workspace/.state', 'ckpt-xxx'), null, 2));
"
```

### Check promotion blockers

```bash
# Eval summary tells you the delta values
cat .state/eval/summaries/eval-{checkpoint-id}.json | jq

# Training result tells you lineage
cat .state/training/results/result-{checkpoint-id}.json | jq '.spec,.result'
```

### Manually trigger a promotion gate evaluation

Currently there is no CLI command for this — the evaluation runs automatically when you click "Approve Promotion" in the Principles Console. The evaluation logic is in `promotion-gate.ts`.

---

## 10. Key Files Reference

| File | Purpose |
|------|---------|
| `src/core/local-worker-routing.ts` | Routing policy classification |
| `src/core/shadow-observation-registry.ts` | Shadow evidence collection and aggregation |
| `src/core/promotion-gate.ts` | Promotion state machine and gate evaluation |
| `src/core/model-deployment-registry.ts` | Active checkpoint management per profile |
| `src/core/model-training-registry.ts` | Training experiment and result registry |
| `src/core/external-training-contract.ts` | Normalized training experiment spec/result |
| `src/core/training-program.ts` | Training program state machine |
| `src/hooks/prompt.ts` | Routing guidance injection (line ~849) |
| `src/index.ts` | `subagent_spawning` / `subagent_ended` hook wiring |
| `src/service/nocturnal-service.ts` | Trinity orchestration (Dreamer/Philosopher/Scribe) |
| `src/service/evolution-worker.ts` | Background worker polling |

---

## 11. Common Operator Scenarios

### Scenario: A checkpoint passed eval but shadow evidence shows high failure rate

1. Check shadow observations: `cat .state/shadow/observations/local-reader/ckpt-xxx.jsonl`
2. If failure rate > threshold, checkpoint should be `rejected`
3. Disable it: Principles Console → disable
4. Rollback to previous: Principles Console → rollback
5. Investigate: Was the eval benchmark not representative of real tasks?

### Scenario: Promotion is blocked but I don't know why

1. Read the eval summary: `cat .state/eval/summaries/eval-ckpt-xxx.json`
2. Compare each metric against the threshold values in `promotion-gate.ts`
3. Look at `blockers[]` from `evaluatePromotionGate()` output
4. Each blocker is a human-readable string explaining which metric failed

### Scenario: Shadow routing is not happening

1. Check `isRoutingEnabledForProfile(stateDir, 'local-reader')` — is routing enabled?
2. Check checkpoint state: `getPromotionState(stateDir, checkpointId)` must be `shadow_ready` or `promotable`
3. Check `isCheckpointDeployable(stateDir, checkpointId)` — checkpoint must not be revoked
4. Check that guidance is being injected: look at `before_prompt_build` result for `<routing_guidance>` tag

### Scenario: I want to manually override routing for a session

You cannot force routing from outside OpenClaw. The main agent always has full discretion. To route manually, instruct the agent directly: *"For this task, use the local-reader subagent with sessions_spawn."*
