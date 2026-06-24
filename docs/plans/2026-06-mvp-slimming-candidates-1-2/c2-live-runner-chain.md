# C2-P0: Live MVP Runner Chain Trace

**Issue**: PRI-457
**Date**: 2026-06-24
**Type**: Read-only spike — no production code changed

## Purpose

Pin the exact set of peer runners that actually execute for each MVP activation
channel under default shipped production config. This is the prerequisite for
C2-P2 (de-surface Quiet runners) — any runner removal or hiding must be backed
by evidence of what actually fires today.

## ERR Gate

- **ERR-004 / ERR-008 / EP-07**: successor task kinds are read from the real
  store after `commitNextTaskProposal`, not inferred from `ALLOWED_EDGES` on
  paper. The pinning test (`c2-live-runner-chain.test.ts`) seeds real tasks
  through the real seeding path and asserts real successor records.
- **EP-09**: the pinning test exercises the real `InternalizationOrchestrator`
  + `RuntimeStateManager` (SQLite), not a hand-written expected-edge list.

## Sources Read

| File | Role |
|------|------|
| `internalization-job-graph.ts` | `ALLOWED_EDGES`, `getAllowedSuccessors`, `validateEdge` |
| `internalization-state-machine.ts` | `createNextTaskProposal` (successor proposal logic) |
| `internalization-orchestrator.ts` | `proposeNextTask`, `commitNextTaskProposal` (real seeding path) |
| `intake-to-internalization-bridge.ts` | `computeBridgeDecision`, `ROUTE_CHANNEL_MAP`, `MVP_ENABLED_CHANNELS` |
| `internalization-route.ts` | `decideInternalizationRoute` (recommendation kind → route) |
| `peer-runner-contracts.ts` | `PEER_RUNNER_KINDS`, `InternalizationChannel` type |
| `queue-actionability.ts` | `MVP_CORE_TASK_KINDS` |
| `internalization-consumer-decision.ts` | `DEFAULT_CONSUMER_RUNNER_KINDS` |
| `pd-config-defaults.ts` | `DEFAULT_AGENT_ENABLED` |
| `feature-flag-contract.ts` | `DEFAULT_FEATURE_FLAGS` |
| `internalization-auto-consumer-service.ts` (plugin) | Auto-consumer: only calls `wakeOnce('dreamer')` |
| `runtime-internalization-run-once.ts` (pd-cli) | CLI: accepts `--runner`, does NOT check config enabled |

## Config Defaults Relied On

### `DEFAULT_AGENT_ENABLED` (pd-config-defaults.ts)

| Agent | enabled | Classification |
|-------|---------|----------------|
| diagnostician | true | Core (pre-pipeline) |
| dreamer | true | **Core** |
| philosopher | false | **Quiet** |
| scribe | true | **Core** |
| artificer | true | **Core** |
| evaluator | false | **Quiet** |
| rolloutReviewer | false | **Quiet** |
| correctionObserver | false | Quiet (observer, not peer runner) |
| empathyObserver | false | Quiet (observer, not peer runner) |

### Feature flags (feature-flag-contract.ts)

| Flag | category | enabled | Effect |
|------|----------|---------|--------|
| `internalization_auto_consumer` | quiet | true | Auto-consumer runs dreamer tasks every 120s |
| `code_rule_capability` | core | true | RuleHost pipeline (artificer↔evaluator) for code_tool_hook |
| `l2_dreamer` | quiet | false | L2 agent loop for dreamer (off by default) |
| `internalization_core_grounding` | quiet | true | Core principle grounding in dreamer/philosopher/scribe prompts |

### `MVP_ENABLED_CHANNELS` (intake-to-internalization-bridge.ts)

```
Set { 'prompt', 'code_tool_hook', 'defer_archive' }
```

### `MVP_CORE_TASK_KINDS` (queue-actionability.ts)

```
['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator']
```

`rollout_reviewer` is **excluded** — not operator-actionable in MVP.

### `DEFAULT_CONSUMER_RUNNER_KINDS` (internalization-consumer-decision.ts)

```
['dreamer']
```

The auto-consumer only picks up dreamer tasks.

## Route → Channel Mapping

| Recommendation kind | Route | Channel | MVP-enabled? |
|---------------------|-------|---------|--------------|
| `principle` | `principle-ledger` | `prompt` | Yes |
| `rule` | `rule-candidate` | `code_tool_hook` | Yes |
| `implementation` | `implementation-candidate` | `skill` | **No** (rejected at bridge) |
| `prompt` | `prompt-injection-candidate` | `prompt` | Yes |
| `defer` | `deferred` | — | **No** (returns `not_internalizable`) |

**Critical finding**: `defer_archive` is in `MVP_ENABLED_CHANNELS` but **no route
maps to it**. The `ROUTE_CHANNEL_MAP` has no `defer_archive` entry. `defer`
recommendations return `not_internalizable` at the intake bridge. The
`defer_archive` channel is an **activation** channel (how an approved principle
is applied), not an **internalization** channel (how a principle is generated
through the peer runner chain).

## ALLOWED_EDGES (Job Graph Topology)

```
dreamer → philosopher → scribe → artificer → evaluator → rollout_reviewer
```

`validateEdge(from, to, _channel)` — the `_channel` parameter is **unused**.
All edges are valid for all channels. The job graph does NOT filter by channel.

## Live Runner Chain Per Channel

### Channel: `prompt` (principle-ledger route)

| Step | Runner | Fires by default? | Skip mechanism |
|------|--------|-------------------|----------------|
| 1 | dreamer | **Yes** | Auto-consumer calls `wakeOnce('dreamer')` every 120s |
| 2 | philosopher | **No** | Auto-consumer only runs dreamer; config `philosopher.enabled=false` (not enforced in execution path, but reflects intent) |
| 3 | scribe | **No** (auto) | Auto-consumer only runs dreamer; config `scribe.enabled=true` but no auto-dispatch |
| 4 | artificer | **No** (auto) | Auto-consumer only runs dreamer; config `artificer.enabled=true` but no auto-dispatch |
| 5 | evaluator | **No** | Auto-consumer only runs dreamer; config `evaluator.enabled=false` |
| 6 | rollout_reviewer | **No** | Auto-consumer only runs dreamer; config `rolloutReviewer.enabled=false`; excluded from `MVP_CORE_TASK_KINDS` |

**Actual live chain (default config)**: dreamer only (auto-consumer).
After dreamer succeeds, `commitNextTaskProposal` creates a philosopher successor
task in `pending` state, but no worker picks it up automatically.

**Manual path**: operator can run `pd runtime internalization run-once --runner <kind>`
to execute any runner. The CLI does NOT check `internalAgents.{name}.enabled`.

### Channel: `code_tool_hook` (rule-candidate route)

| Step | Runner | Fires by default? | Skip mechanism |
|------|--------|-------------------|----------------|
| 1 | dreamer | **Yes** | Auto-consumer calls `wakeOnce('dreamer')` every 120s |
| 2 | philosopher | **No** | Same as prompt channel |
| 3 | scribe | **No** (auto) | Same as prompt channel |
| 4 | artificer | **No** (auto) | Same as prompt channel; additionally, `run-rulehost` CLI checks `artificer.enabled` |
| 5 | evaluator | **No** | Same as prompt channel; additionally, `run-rulehost` CLI checks `evaluator.enabled` |
| 6 | rollout_reviewer | **No** | Same as prompt channel |

**Actual live chain (default config)**: dreamer only (auto-consumer).
Same as prompt channel — the auto-consumer does not differentiate by channel.

**RuleHost path**: `pd runtime internalization run-rulehost` runs the
artificer↔evaluator adversarial loop for code-rule candidates. This CLI DOES
check `artificer.enabled` and `evaluator.enabled` — if either is false,
`CodeRuleCapability.enabled=false` with a disabled reason.

### Channel: `defer_archive`

**No runners run.** No route maps to the `defer_archive` internalization channel.
`defer` recommendations return `not_internalizable` at the intake bridge
(`computeBridgeDecision`). No dreamer task is seeded.

The `defer_archive` activation channel is a separate concept: it is how an
already-approved principle is applied (archived/deferred), not how a principle
is generated through the peer runner chain.

## Core/Quiet Classification Summary

| Runner | Config default | Auto-consumer picks up? | In MVP_CORE_TASK_KINDS? | Classification |
|--------|---------------|------------------------|------------------------|----------------|
| dreamer | enabled=true | Yes | Yes | **Core** |
| philosopher | enabled=false | No | Yes | **Quiet** |
| scribe | enabled=true | No | Yes | **Core** (config on, but no auto-dispatch) |
| artificer | enabled=true | No | Yes | **Core** (config on, but no auto-dispatch) |
| evaluator | enabled=false | No | Yes | **Quiet** |
| rollout_reviewer | enabled=false | No | No | **Quiet** (also excluded from actionable queue) |

### Key finding: config `enabled` is NOT enforced in the main execution path

The `internalAgents.{name}.enabled` config flag is **not checked** by:
- `InternalizationOrchestrator.wakeOnce()` — leases any pending task regardless of config
- `InternalizationOrchestrator.commitNextTaskProposal()` — creates successors regardless of config
- `pd runtime internalization run-once` CLI — runs any runner specified via `--runner`

The only places `enabled` is checked:
- `run-rulehost` CLI: checks `artificer.enabled` and `evaluator.enabled` for the code-rule capability
- `pd-config-loader.ts`: checks `correctionObserver.enabled` and `empathyObserver.enabled` for observer services

The **actual skip mechanism** for non-dreamer runners is that the auto-consumer
only calls `wakeOnce('dreamer')`. This is a runtime behavior, not a config gate.

## Successor Chain (from real store — verified by pinning test)

When a dreamer task succeeds and `commitNextTaskProposal` is called, the
successor chain created in the store is:

```
dreamer (succeeded) → philosopher (pending) → scribe (pending) → artificer (pending) → evaluator (pending) → rollout_reviewer (pending)
```

Each successor is created with:
- `taskKind`: the next runner from `getAllowedSuccessors`
- `channel`: inherited from the parent task
- `dependencyTaskIds`: `[parentTaskId]`
- `status`: `pending`

The pinning test (`c2-live-runner-chain.test.ts`) verifies this by:
1. Seeding a dreamer task through the real intake bridge
2. Marking it succeeded
3. Calling `commitNextTaskProposal` iteratively
4. Reading the actual successor task from the store
5. Asserting the `taskKind` matches the expected chain

## Implications for C2-P2 (De-surface Quiet runners)

1. **philosopher**: default-off config + not auto-dispatched → safe to de-surface
2. **evaluator**: default-off config + not auto-dispatched → safe to de-surface
3. **rollout_reviewer**: default-off + excluded from MVP_CORE_TASK_KINDS → safe to de-surface
4. **scribe, artificer**: config on but not auto-dispatched → de-surface with care
   (they are Core by config intent, just not auto-run by the consumer)
5. **dreamer**: Core, auto-dispatched → do NOT de-surface

The config `enabled` flag is a hint, not a gate. C2-P2 must not rely on it alone
for de-surfacing — the pinning test is the safety net.
