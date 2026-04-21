# Research: PD CLI Subcommand Behaviors

## Command Summary

| Command | Category | Complexity | Key Dependency |
|---------|----------|------------|----------------|
| `pd pain record` | Table Stakes | Low | PainSignalSchema, TrajectoryRegistry |
| `pd samples list/review` | Table Stakes | Low | TrajectoryDatabase |
| `pd evolution tasks` | Differentiator | Medium | EvolutionWorker, task store |
| `pd health` | Table Stakes | Low | HealthQueryService, CentralHealthService |
| `pd central sync` | Differentiator | Medium | CentralDatabase (background service) |

## 1. pd pain record — Table Stakes

**Purpose:** Record pain signal for evolution processing.

**CLI interface:**
```
pd pain record "reason text" --score 75
pd pain record "tool failure" --score 90 --source tool_failure
```

**Existing behavior:** write_pain_flag tool + handlePainCommand
**Complexity:** Low. Direct wrapper around PainSignalSchema + atomicWriteFileSync.

## 2. pd samples list/review — Table Stakes

**Purpose:** Manage correction samples.

**CLI interface:**
```
pd samples list
pd samples review approve sample-abc-123 "looks good"
pd samples review reject sample-xyz-789 "incorrect pattern"
```

**Existing behavior:** handleSamplesCommand
**Complexity:** Low. Delegates to TrajectoryDatabase.listCorrectionSamples().

## 3. pd evolution tasks — Differentiator

**Purpose:** View evolution task queue.

**CLI interface:**
```
pd evolution tasks list
pd evolution tasks show <task-id>
```

**Existing behavior:** handleEvolutionStatusCommand
**Complexity:** Medium. Needs direct task store access.

## 4. pd health — Table Stakes

**Purpose:** Health check.

**CLI interface:**
```
pd health
pd health --workspace <name>
pd health --central
```

**Existing behavior:** HealthQueryService, CentralHealthService
**Complexity:** Low.

## 5. pd central sync — Differentiator

**Purpose:** Trigger sync to central database.

**CLI interface:**
```
pd central sync
pd central sync --force
```

**Existing behavior:** CentralSyncService (background)
**Complexity:** Medium. One-shot vs background.
