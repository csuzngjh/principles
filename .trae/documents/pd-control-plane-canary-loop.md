# Plan: PD Control Plane Canary → Defect Exposure → Quick Fix Loop

## Summary

Implement 5 sequential Linear issues (PRI-95 through PRI-99) to establish a "observable canary → defect exposure → quick fix" closed loop on the OpenClaw production workspace. Each issue is independent branch + PR with strict TDD.

## Current State Analysis

### Architecture
- **Monorepo** at `D:\Code\principles` with packages: `@principles/core` (principles-core) and `@principles/pd-cli`
- **Runtime V2** SQLite state store at `<workspace>/.pd/state.db` with tables: `tasks`, `runs`, `artifacts`, `commits`, `principle_candidates`, `pi_artifacts`
- **Schema migration** in `SqliteConnection.initSchema()` + `migrateSchema()` — handles column additions for `principle_candidates` (recommendation_kind, trigger_pattern, action, abstracted_principle)
- **Existing read models**: `OperatorHealthReadModel`, `PainChainReadModel`, `PruningReadModel`, `InternalizationQueueReadModel`, `GfiWorkspaceSnapshot`
- **Existing CLI commands**: `pd runtime health snapshot`, `pd runtime pruning report`, `pd runtime internalization queue`, `pd candidate audit`, etc.
- **Test patterns**: Vitest with `vi.mock('better-sqlite3')` and `vi.mock('fs')` for core tests; `execFileSync` against built dist for CLI tree tests
- **Build**: `tsc` per package; `vitest run` for tests
- **Import convention**: `@principles/core/runtime-v2` subpath export; `.js` extension in relative imports

### Key Files
- Schema DDL: [sqlite-connection.ts](file:///d:/Code/principles/packages/principles-core/src/runtime-v2/store/sqlite-connection.ts#L80-L253)
- Health read model: [operator-health-read-model.ts](file:///d:/Code/principles/packages/principles-core/src/runtime-v2/operator-health-read-model.ts)
- CLI index: [pd-cli/src/index.ts](file:///d:/Code/principles/packages/pd-cli/src/index.ts)
- Runtime state manager: [runtime-state-manager.ts](file:///d:/Code/principles/packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts)
- Candidate audit: [candidate-audit.ts](file:///d:/Code/principles/packages/principles-core/src/runtime-v2/candidate-audit.ts)
- Pruning read model: [pruning-read-model.ts](file:///d:/Code/principles/packages/principles-core/src/runtime-v2/pruning-read-model.ts)
- Internalization queue: [internalization-queue-read-model.ts](file:///d:/Code/principles/packages/principles-core/src/runtime-v2/internalization-queue-read-model.ts)
- Exports: [runtime-v2/index.ts](file:///d:/Code/principles/packages/principles-core/src/runtime-v2/index.ts)

### Conventions
- Read models are pure classes with `getSnapshot()` / `getHealthSummary()` methods
- CLI handlers are async functions taking an options interface, using `resolveWorkspaceDir()`
- JSON output via `--json` flag; text output with `formatTextOutput()` helper
- Error handling: try/catch with graceful degradation (return error status, never throw)
- DB access: `new Database(pdDbPath, { readonly: true })` with `try/finally { db.close() }`
- Test mocks: `vi.mock('better-sqlite3')`, `vi.mock('fs')`, `vi.hoisted()` for cross-mock dependencies

---

## PRI-95: Runtime Schema Conformance Read Model

### Goal
Pure read model that checks workspace Runtime V2 SQLite schema conformance without modifying the database.

### Files to Create
1. `packages/principles-core/src/runtime-v2/schema-conformance-read-model.ts`
2. `packages/principles-core/src/runtime-v2/__tests__/schema-conformance-read-model.test.ts`

### Files to Modify
3. `packages/principles-core/src/runtime-v2/index.ts` — add exports

### Implementation Details

**SchemaConformanceReadModel** class:
- Constructor takes `{ workspaceDir: string }`
- Single method `check(): SchemaConformanceResult`
- Opens DB in readonly mode; if DB doesn't exist → `degraded` status, no throw
- Uses `PRAGMA table_info(<table>)` to check column existence
- Uses `PRAGMA index_list(<table>)` + `PRAGMA index_info(<index>)` to check indexes
- Compares against expected schema derived from `SqliteConnection.initSchema()` + `migrateSchema()`

**Expected schema definition** (hardcoded from SqliteConnection):
```
tables = {
  tasks: {
    columns: [task_id, task_kind, status, created_at, updated_at, lease_owner, lease_expires_at, attempt_count, max_attempts, last_error, input_ref, result_ref, diagnostic_json],
    indexes: [idx_tasks_status, idx_tasks_created_at, idx_tasks_task_kind, idx_tasks_lease_expires_at, idx_tasks_session_id_hint]
  },
  runs: {
    columns: [run_id, task_id, runtime_kind, execution_status, started_at, ended_at, reason, output_ref, input_payload, output_payload, error_category, attempt_number, created_at, updated_at],
    indexes: [idx_runs_task_id, idx_runs_status, idx_runs_started_at]
  },
  artifacts: {
    columns: [artifact_id, run_id, task_id, artifact_kind, content_json, created_at],
    indexes: [idx_artifacts_task_id, idx_artifacts_run_id, idx_artifacts_artifact_kind]
  },
  commits: {
    columns: [commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at],
    indexes: [idx_commits_task_id, idx_commits_artifact_id]
  },
  principle_candidates: {
    columns: [candidate_id, artifact_id, task_id, source_run_id, title, description, confidence, source_recommendation_json, idempotency_key, status, created_at, consumed_at, recommendation_kind, trigger_pattern, action, abstracted_principle],
    indexes: [idx_candidates_status, idx_candidates_source_run_id, idx_candidates_task_id, idx_candidates_recommendation_kind]
  },
  pi_artifacts: {
    columns: [artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at],
    indexes: [idx_pi_artifacts_source_task_id, idx_pi_artifacts_artifact_kind, idx_pi_artifacts_idempotency]
  }
}
```

**Output type**:
```typescript
interface SchemaConformanceResult {
  overallStatus: 'ok' | 'degraded' | 'error';
  checkedDatabasePath: string;
  tables: Record<string, {
    exists: boolean;
    missingColumns: string[];
    extraInfo?: string;
  }>;
  indexes: {
    missingIndexes: string[];
  };
  migrationsNeeded: string[];
  generatedAt: string;
}
```

**Key behaviors**:
- DB doesn't exist → `overallStatus: 'error'`, all tables `exists: false`, `migrationsNeeded: ['initialize_database']`
- Empty DB (no tables) → `overallStatus: 'error'`, report all tables missing
- Old schema (e.g., principle_candidates missing recommendation_kind/trigger_pattern/action/abstracted_principle) → `overallStatus: 'degraded'`, `migrationsNeeded: ['add_recommendation_kind', 'add_trigger_pattern', 'add_action', 'add_abstracted_principle']`
- Fully migrated → `overallStatus: 'ok'`, empty `migrationsNeeded`
- Readonly query must NOT trigger migration (open DB with `{ readonly: true }`)

### Test Cases
1. DB doesn't exist → degraded/error, no throw
2. Empty DB → report missing tables
3. Old schema → report missing columns
4. Fully migrated schema → ok
5. Readonly query doesn't trigger migration
6. Output includes migrationsNeeded

### Verification
```bash
npm run build --workspace=@principles/core
npx vitest run packages/principles-core/src/runtime-v2/__tests__/schema-conformance-read-model.test.ts
```

---

## PRI-96: PD Control Plane Production Canary CLI

### Goal
Operator command `pd runtime canary --workspace <path> --json` that aggregates all control plane health checks in one non-destructive, read-only call.

### Files to Create
1. `packages/pd-cli/src/commands/runtime-canary.ts`
2. `packages/pd-cli/tests/commands/runtime-canary.test.ts`

### Files to Modify
3. `packages/pd-cli/src/index.ts` — register `canary` subcommand under `runtime`

### Implementation Details

**CanaryCheck** interface:
```typescript
interface CanaryCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'error';
  summary: string;
  details?: unknown;
  error?: string;
}
```

**CanaryOutput** interface:
```typescript
interface CanaryOutput {
  overallStatus: 'healthy' | 'degraded' | 'error';
  checks: CanaryCheck[];
  recommendedNextActions: string[];
  generatedAt: string;
}
```

**Check implementations** (each wrapped in try/catch so single failure doesn't crash the command):
1. **runtime_health** — uses `OperatorHealthReadModel.getSnapshot()`
2. **candidate_audit** — uses `auditCandidateLedgerConsistency()`
3. **gfi_snapshot** — uses `buildGfiWorkspaceSnapshot()`
4. **schema_conformance** — uses `SchemaConformanceReadModel.check()` (PRI-95)
5. **pruning_orphans** — uses `PruningReadModel.getOrphanDerivedCandidates()`
6. **internalization_queue** — uses `InternalizationQueueReadModel.getSnapshot()`
7. **pd_shim_info** — basic detection of pd CLI entrypoint / shim presence (check `package.json` version, CLI path)

**Overall status logic**:
- All healthy → `healthy`
- Any degraded → `degraded`
- Any error → `error` (but continue other checks)
- If a check throws → catch, mark as `error` with error message, continue

**recommendedNextActions** derived from check results:
- schema mismatch → "Run workspace initialization to migrate schema"
- candidate audit error → "Run `pd candidate audit --workspace <path> --json`"
- GFI stale → "Investigate stale sessions"
- pruning orphans → "Run `pd runtime pruning orphans --workspace <path> --dry-run`"
- queue blocked → "Check internalization queue for blocked tasks"
- broken shim → "Verify pd CLI installation"

### CLI Registration
Under `runtimeCmd`:
```typescript
runtimeCmd
  .command('canary')
  .description('One-shot control plane health canary')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeCanary({ workspace: opts.workspace, json: opts.json });
  });
```

### Test Cases
1. All checks healthy → overall healthy
2. Single check degraded → overall degraded
3. Single check throws → overall error/degraded, other checks continue
4. JSON output is stable and parseable
5. recommendedNextActions includes schema migration / pruning orphan / broken shim suggestions

### Verification
```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npx vitest run packages/pd-cli/tests/commands/runtime-canary.test.ts
```

Manual:
```bash
node packages/pd-cli/dist/index.js runtime canary --workspace "D:\.openclaw\workspace" --json
```

---

## PRI-97: Internalization Chain Integrity Report

### Goal
Read model + CLI command to check internalization chain completeness: candidate → PI task → run → artifact → successor task.

### Files to Create
1. `packages/principles-core/src/runtime-v2/internalization-chain-integrity-read-model.ts`
2. `packages/principles-core/src/runtime-v2/__tests__/internalization-chain-integrity-read-model.test.ts`
3. `packages/pd-cli/src/commands/runtime-internalization-integrity.ts`
4. `packages/pd-cli/tests/commands/runtime-internalization-integrity.test.ts`

### Files to Modify
5. `packages/principles-core/src/runtime-v2/index.ts` — add exports
6. `packages/pd-cli/src/index.ts` — register command

### Implementation Details

**InternalizationChainIntegrityReadModel** class:
- Constructor takes `{ workspaceDir: string }` or accepts `RuntimeStateManager` injection
- Method `check(): ChainIntegrityResult`

**Chain checks** (all read-only, no repair):
1. For each `principle_candidates` row with status `consumed`:
   - Does a corresponding root dreamer task exist? (task_kind = 'dreamer', check diagnostic_json or input_ref for candidate_id)
2. For each dreamer task that succeeded:
   - Does a dreamer PI artifact exist in `pi_artifacts`? (source_task_id = task_id, artifact_kind = 'dreamer_pi')
3. For each dreamer task that succeeded:
   - Does a philosopher successor task exist? (check task dependency chain)
4. For each philosopher task:
   - Can it find the dreamer artifact dependency? (check dependency resolution)
5. For each succeeded task:
   - Does `result_ref` point to a readable artifact?
6. PIArtifact idempotency: check for duplicate `source_task_id + artifact_kind` combos or missing entries
7. Run/task state consistency: task succeeded but no succeeded run; leased with expired lease; retry_wait exceeding max_attempts

**Output type**:
```typescript
interface BrokenLink {
  type: string;
  severity: 'warning' | 'error';
  taskId?: string;
  candidateId?: string;
  artifactId?: string;
  reason: string;
  recommendedAction: string;
}

interface ChainIntegrityResult {
  overallStatus: 'ok' | 'degraded' | 'error';
  brokenLinks: BrokenLink[];
  chainSummaries: {
    totalCandidates: number;
    totalDreamerTasks: number;
    totalPhilosopherTasks: number;
    totalPIArtifacts: number;
    chainsWithBrokenLinks: number;
  };
  generatedAt: string;
}
```

**Constraints**:
- Read-only, no repair
- No runner execution
- No successor creation

### CLI Registration
Under `internalizationCmd`:
```typescript
internalizationCmd
  .command('integrity')
  .description('Check internalization chain integrity')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeInternalizationIntegrity({ workspace: opts.workspace, json: opts.json });
  });
```

### Test Cases
1. No broken links → overall ok
2. Missing dreamer task for candidate → broken link reported
3. Missing PI artifact for succeeded dreamer → broken link
4. Missing philosopher successor → broken link
5. Task succeeded but no succeeded run → broken link
6. Leased task with expired lease → broken link
7. Multiple issues reported correctly

### Verification
```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npx vitest run packages/principles-core/src/runtime-v2/__tests__/internalization-chain-integrity-read-model.test.ts
npx vitest run packages/pd-cli/tests/commands/runtime-internalization-integrity.test.ts
```

---

## PRI-98: Control Plane Diagnostic Bundle Export

### Goal
Read-only diagnostic bundle export command for packaging production state for AI assistant analysis.

### Files to Create
1. `packages/pd-cli/src/commands/runtime-diagnostics-export.ts`
2. `packages/pd-cli/tests/commands/runtime-diagnostics-export.test.ts`

### Files to Modify
3. `packages/pd-cli/src/index.ts` — register command

### Implementation Details

**Command**: `pd runtime diagnostics export --workspace <path> --out <dir> --json`

**Bundle contents** (each as separate JSON file):
- `manifest.json` — list of all artifacts with path/status
- `runtime-health.json` — from OperatorHealthReadModel
- `canary.json` — from canary checks (PRI-96)
- `schema-conformance.json` — from SchemaConformanceReadModel (PRI-95)
- `candidate-audit.json` — from auditCandidateLedgerConsistency
- `gfi-snapshot.json` — from buildGfiWorkspaceSnapshot
- `pruning-orphans.json` — from PruningReadModel.getOrphanDerivedCandidates
- `internalization-queue.json` — from InternalizationQueueReadModel
- `internalization-integrity.json` — from InternalizationChainIntegrityReadModel (PRI-97)
- `recent-session-summary.json` — from persisted sessions (sanitized)
- `errors.json` — any errors encountered during bundle generation

**Safety requirements**:
- Default sanitization: no API keys, no full prompts, no complete memory content
- Read-only, no repair
- Output path must be within workspace directory (prevent arbitrary directory writes)
- If a sub-check fails, bundle still generates with manifest marking the failure

**Path validation**:
```typescript
function validateOutputPath(outDir: string, workspaceDir: string): string {
  const resolvedOut = path.resolve(outDir);
  const resolvedWs = path.resolve(workspaceDir);
  if (!resolvedOut.startsWith(resolvedWs)) {
    throw new Error('Output path must be within workspace directory');
  }
  return resolvedOut;
}
```

**Manifest format**:
```typescript
interface BundleManifest {
  generatedAt: string;
  workspace: string;
  outputDir: string;
  artifacts: Array<{
    name: string;
    path: string;
    status: 'ok' | 'failed';
    error?: string;
  }>;
}
```

### CLI Registration
Under `runtimeCmd`:
```typescript
const diagnosticsCmd = runtimeCmd
  .command('diagnostics')
  .description('Control plane diagnostic bundle operations');

diagnosticsCmd
  .command('export')
  .description('Export diagnostic bundle for AI assistant analysis')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--out <dir>', 'Output directory (must be within workspace)', '.state/control-plane-observation/snapshots')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeDiagnosticsExport({ workspace: opts.workspace, out: opts.out, json: opts.json });
  });
```

### Test Cases
1. Successful bundle generation with all artifacts
2. Sub-check failure still generates manifest with failed status
3. Output path outside workspace is rejected
4. JSON manifest contains path/status for each artifact
5. No sensitive env/API key content in output

### Verification
```bash
npm run build --workspace=@principles/pd-cli
npx vitest run packages/pd-cli/tests/commands/runtime-diagnostics-export.test.ts
```

Manual:
```bash
node packages/pd-cli/dist/index.js runtime diagnostics export --workspace "D:\.openclaw\workspace" --json
```

---

## PRI-99: Canary-to-Issue Triage Runbook

### Goal
Convert canary/diagnostics output into structured triage classifications and repair recommendations.

### Files to Create
1. `packages/principles-core/src/runtime-v2/control-plane-triage.ts`
2. `packages/principles-core/src/runtime-v2/__tests__/control-plane-triage.test.ts`
3. `docs/runbooks/pd-control-plane-triage.md`

### Files to Modify
4. `packages/principles-core/src/runtime-v2/index.ts` — add exports

### Implementation Details

**classifyCanaryFindings()** pure function:
```typescript
interface TriageCategory {
  category: TriageCategoryName;
  severity: 'critical' | 'high' | 'medium' | 'low';
  symptom: string;
  likelyRootCause: string;
  commandsToVerify: string[];
  safeFirstRepair: string;
  escalationRule: string;
  linearIssueTemplate: string;
}

type TriageCategoryName =
  | 'schema_mismatch'
  | 'sqlite_io_error'
  | 'broken_pd_shim'
  | 'candidate_audit_failed'
  | 'gfi_unavailable_or_stale'
  | 'pruning_orphans_present'
  | 'internalization_queue_blocked'
  | 'internalization_chain_broken'
  | 'artifact_missing'
  | 'runner_unsupported'
  | 'lease_stuck'
  | 'unknown';

interface TriagePlan {
  findings: TriageCategory[];
  sortedBySeverity: TriageCategory[];
  summary: string;
}

function classifyCanaryFindings(canaryOutput: CanaryOutput): TriagePlan;
```

**Classification rules** (input → category mapping):
- Schema conformance check degraded/error → `schema_mismatch`
- DB access error → `sqlite_io_error`
- PD shim check error → `broken_pd_shim`
- Candidate audit error → `candidate_audit_failed`
- GFI stale/unavailable → `gfi_unavailable_or_stale`
- Pruning orphan count > 0 → `pruning_orphans_present`
- Internalization queue blocked → `internalization_queue_blocked`
- Internalization chain broken links → `internalization_chain_broken`
- Missing artifact references → `artifact_missing`
- Runner not supported → `runner_unsupported`
- Leased task with expired lease → `lease_stuck`
- Unmatched → `unknown`

**Each category includes**:
- severity (critical/high/medium/low)
- operator-visible symptom description
- likely root cause
- commands to verify
- safe first repair (e.g., dry-run first for pruning orphans)
- escalation rule
- Linear issue template snippet

**Output sorting**: by severity (critical > high > medium > low)

### Test Cases
1. Schema mismatch → PRI-style repair recommendation
2. Broken shim → sync-plugin verify/install recommendation
3. Pruning orphan count > 0 → dry-run first, not direct confirm
4. Internalization broken links → integrity details
5. Multiple issues sorted by severity

### Verification
```bash
npm run build --workspace=@principles/core
npx vitest run packages/principles-core/src/runtime-v2/__tests__/control-plane-triage.test.ts
```

---

## Assumptions & Decisions

1. **Schema definition source**: Expected schema is hardcoded in the read model, derived from `SqliteConnection.initSchema()` + `migrateSchema()`. This avoids importing SqliteConnection (which would trigger migrations).
2. **Read model DB access**: All read models open DB with `{ readonly: true }` to guarantee no side effects.
3. **Canary check isolation**: Each check runs in its own try/catch. A failing check produces an error entry but doesn't prevent other checks from running.
4. **Diagnostic bundle path safety**: Output must resolve to within workspace directory. Relative paths are resolved against workspace.
5. **Sanitization**: Bundle export strips env vars containing "KEY", "SECRET", "TOKEN", "PASSWORD" patterns. Session summaries omit full prompt content.
6. **Triage is pure function**: `classifyCanaryFindings` takes the canary output object and returns a triage plan — no I/O, no side effects, fully testable.
7. **No production DB modification**: All 5 issues are read-only. The only exception is the pruning orphans `--confirm` path which is explicitly gated and not in scope for these issues.
8. **Branch strategy**: Each PRI gets its own branch from main, independent PR, no scope mixing.
9. **Test approach**: Core read models use `vi.mock('better-sqlite3')` + `vi.mock('fs')` pattern. CLI tests use both unit tests (mocked) and command-tree tests (execFileSync against built dist).

## Execution Order

1. PRI-95 (Schema Conformance Read Model) — foundation for PRI-96
2. PRI-96 (Canary CLI) — depends on PRI-95's read model
3. PRI-97 (Internalization Chain Integrity) — independent of PRI-95/96 but can be integrated into canary
4. PRI-98 (Diagnostic Bundle Export) — aggregates outputs from PRI-95/96/97
5. PRI-99 (Triage Runbook) — consumes canary output from PRI-96

## Final Verification (after all PRs merged)

```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npm run typecheck:openclaw-plugin
npx vitest run packages/principles-core/src/runtime-v2/__tests__/schema-conformance-read-model.test.ts
npx vitest run packages/pd-cli/tests/commands/runtime-canary.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/internalization-chain-integrity-read-model.test.ts
npx vitest run packages/pd-cli/tests/commands/runtime-internalization-integrity.test.ts
npx vitest run packages/pd-cli/tests/commands/runtime-diagnostics-export.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/control-plane-triage.test.ts
```

Real workspace verification:
```bash
node packages/pd-cli/dist/index.js runtime canary --workspace "D:\.openclaw\workspace" --json
node packages/pd-cli/dist/index.js runtime internalization integrity --workspace "D:\.openclaw\workspace" --json
node packages/pd-cli/dist/index.js runtime diagnostics export --workspace "D:\.openclaw\workspace" --json
```
