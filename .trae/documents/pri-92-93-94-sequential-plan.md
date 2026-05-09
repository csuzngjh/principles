# Plan: PRI-92 / PRI-93 / PRI-94 — Sequential Implementation

Execution order: PRI-92 → PRI-93 → PRI-94 (each on its own branch, own PR, own verification).

---

## PRI-92: Runtime V2 SQLite Schema Migration Guard

### Summary
Add idempotent schema migration to `SqliteConnection` that detects and adds missing columns (`recommendation_kind`, `trigger_pattern`, `action`, `abstracted_principle`) in the `principle_candidates` table for existing production databases.

### Current State Analysis
- [sqlite-connection.ts](file:///d:/Code/principles/packages/principles-core/src/runtime-v2/store/sqlite-connection.ts) already has `CREATE TABLE IF NOT EXISTS principle_candidates` with all 4 columns in the DDL (lines 203-229)
- `CREATE TABLE IF NOT EXISTS` only creates the table if it doesn't exist — it does NOT add missing columns to an existing table
- There's an existing migration pattern for `tasks.diagnostic_json` (lines 100-105) using `PRAGMA table_info` + conditional `ALTER TABLE`
- The `runs` table also has a migration pattern (lines 139-166) for FK CASCADE
- Readonly connections are already gated: `getDb()` only calls `initSchema()` when `!this.readonlyMode` (line 68)
- Production DB at `D:\.openclaw\workspace\.pd\state.db` has old schema missing the 4 new columns

### Proposed Changes

#### File 1: `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts`

Add a `migrateSchema()` method called after `initSchema()` in `getDb()`, only for writable connections.

**What to add:**
1. New private method `migrateSchema()`:
   - Check `principle_candidates` table exists via `sqlite_master` before proceeding
   - Use `PRAGMA table_info(principle_candidates)` to get existing column names
   - For each of the 4 columns, check if present; if missing, execute `ALTER TABLE`
   - Each column is checked individually for idempotency
   - Wrapped in try/catch for resilience in restricted environments

2. Call `migrateSchema()` after `initSchema()` in `getDb()` (line 68 area), inside the `!this.readonlyMode` block

**Columns to migrate:**
```sql
ALTER TABLE principle_candidates ADD COLUMN recommendation_kind TEXT NOT NULL DEFAULT 'principle'
ALTER TABLE principle_candidates ADD COLUMN trigger_pattern TEXT
ALTER TABLE principle_candidates ADD COLUMN action TEXT
ALTER TABLE principle_candidates ADD COLUMN abstracted_principle TEXT
```

**Also add the `idx_candidates_recommendation_kind` index migration** — existing DBs won't have this index since it's part of the CREATE TABLE block. Check via `sqlite_master` and create if missing.

#### File 2: `packages/principles-core/src/runtime-v2/store/schema-conformance.test.ts`

Add a new `describe('SchemaMigration')` block with these tests:

1. **Old schema principle_candidates gets 4 new columns after migration** — Create DB with old schema (12 columns, no recommendation_kind/trigger_pattern/action/abstracted_principle), then open with SqliteConnection, verify all 16 columns present
2. **Old table with existing candidate row preserves data after migration** — Insert a candidate row with old schema, migrate, verify row data still intact
3. **Consecutive initialization does not error** — Open connection twice, no throw
4. **New DB initialization still has all columns** — Fresh DB has all 16 columns
5. **Readonly connection does not run migration** — Open readonly connection on old-schema DB, verify columns are NOT added

#### File 3: `packages/pd-cli/tests/commands/candidate-internalize.test.ts`

Add test: **Old schema DB migrated, candidate route/internalize no longer errors on recommendation_kind** — This is an integration-level test using real SqliteConnection with old schema, verifying `resolveCandidateRecommendation` works after migration.

### TDD Order (Red → Green)
1. Write all 5 schema migration tests first (they will fail — no `migrateSchema()` method exists)
2. Implement `migrateSchema()` in `sqlite-connection.ts`
3. Run tests — all should pass
4. Add the candidate-internalize integration test
5. Verify it passes

### Verification Commands
```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npx vitest run packages/principles-core/src/runtime-v2/store/schema-conformance.test.ts
npx vitest run packages/pd-cli/tests/commands/candidate-internalize.test.ts
npm run typecheck:openclaw-plugin
```

### Branch & PR
- Branch: `codex/pri-92-sqlite-schema-migration`
- PR title: `fix(runtime-v2): add idempotent candidate schema migration (PRI-92)`

---

## PRI-93: Repair pd CLI Shim and Extension Install Path

### Summary
Fix the `sync-plugin.mjs` script to ensure global `pd` shim always points to a valid target, and add post-sync verification that catches broken shims early.

### Current State Analysis
- [sync-plugin.mjs](file:///d:/Code/principles/packages/openclaw-plugin/scripts/sync-plugin.mjs) creates shims in two locations:
  1. **Plugin-local**: `~/.openclaw/extensions/principles-disciple/bin/pd.cmd` + `pd.ps1` (lines 716-729)
  2. **Global**: `npm prefix -g`/`pd.cmd` + `pd.ps1` (lines 754-782)
- The global shim chains: `global pd.ps1` → `plugin-local pd.ps1` → `node <installed_entry>`
- The plugin-local shim points to `~/.openclaw/extensions/principles-disciple/pd-cli/dist/index.js`
- The `syncPdCli()` function (line 698) deletes and recreates `INSTALLED_PD_CLI_DIR` (line 707) before creating shims
- **Bug**: `installGlobalPdShim()` (line 754) is called AFTER `syncPdCli()`, but if `syncPdCli()` fails partway (e.g., dist copy fails), the plugin-local shim may not exist, leaving the global shim pointing to nothing
- **Bug**: The global `pd.ps1` content (line 769) references `$pluginPs` which is the plugin-local pd.ps1 path — if the plugin directory was cleaned but not fully recreated, this becomes a dangling reference
- There's a `verifyPdCliShim()` function (line 785) but it only checks the local shim, not the global one

### Proposed Changes

#### File 1: `packages/openclaw-plugin/scripts/sync-plugin.mjs`

1. **Add global shim verification** in `installGlobalPdShim()`:
   - After writing global shim files, verify the target (plugin-local shim) actually exists
   - If target doesn't exist, log error and attempt to recreate it
   - Verify the global shim works by running `pd --version` equivalent

2. **Make `syncPdCli()` more robust**:
   - Verify `dist/index.js` exists in the installed directory AFTER copy (not just source)
   - If copy fails, don't proceed to `installGlobalPdShim()`
   - Add try/catch around the entire sync flow with clear error messages

3. **Add `--verify-only` flag** to sync-plugin.mjs:
   - Runs only the verification steps without modifying anything
   - Checks: plugin-local shim exists and works, global shim exists and works, pd --help succeeds
   - Useful for canary scripts to check health without full re-sync

4. **Add self-healing in `installGlobalPdShim()`**:
   - Before writing global shim, verify plugin-local shim target exists
   - If missing, attempt to recreate it (call relevant part of `syncPdCli()`)
   - Only write global shim if target is verified

#### File 2: `packages/openclaw-plugin/scripts/validate-live-path.ts`

No changes needed — this is an existing validation script. Just verify it still works after changes.

### Verification (Manual)
```powershell
# After fix, re-run sync-plugin
cd packages/openclaw-plugin && node scripts/sync-plugin.mjs

# Verify global pd works
Get-Command pd | Format-List Path,Definition
pd --help
pd runtime health snapshot --workspace "D:\.openclaw\workspace" --json
pd runtime gfi snapshot --workspace "D:\.openclaw\workspace" --json
pd candidate audit --workspace "D:\.openclaw\workspace" --json
```

### Branch & PR
- Branch: `codex/pri-93-repair-pd-shim`
- PR title: `fix(cli): repair pd shim install path (PRI-93)`

---

## PRI-94: Pruning Orphan Derived Candidate Cleanup Runbook / Dry-Run CLI

**Depends on: PRI-92 merged first** (needs schema migration for candidate queries to work on old DBs)

### Summary
Add `pd runtime pruning orphans` CLI command that lists orphan derived candidates with detail, supports `--dry-run` (default) and `--confirm` for actual cleanup.

### Current State Analysis
- [pruning-read-model.ts](file:///d:/Code/principles/packages/principles-core/src/runtime-v2/pruning-read-model.ts) computes `orphanCandidateCount` per principle (line 188-196) by checking if `derivedFromPainIds` entries exist in the `candidateCreatedAtMap`
- The `candidateCreatedAtMap` only maps `candidate_id → created_at` for consumed candidates (line 166-167)
- **Gap**: Orphan detection only counts, doesn't return the list of orphan IDs
- **Gap**: The map only includes `consumed` candidates — orphans are IDs in `derivedFromPainIds` that DON'T match any consumed candidate, but they might match pending/active candidates
- [runtime-pruning.ts](file:///d:/Code/principles/packages/pd-cli/src/commands/runtime-pruning.ts) has existing CLI patterns for `report`, `explain`, `review`, `rollback`
- [index.ts](file:///d:/Code/principles/packages/pd-cli/src/index.ts) has the `pruningCmd` subcommand group (lines 419-478)
- [cleanup-orphan-candidates.ps1](file:///d:/Code/principles/scripts/cleanup-orphan-candidates.ps1) is a one-off local script that uses `archive-candidate` review decisions — this should NOT be in the PR

### Proposed Changes

#### File 1: `packages/principles-core/src/runtime-v2/pruning-read-model.ts`

1. **Add `OrphanDerivedCandidate` type**:
```typescript
export interface OrphanDerivedCandidate {
  candidateId: string;
  principleId: string;
  reason: string;
  sourceRef?: string;
  status?: string;
}
```

2. **Add `getOrphanDerivedCandidates()` method** to `PruningReadModel`:
   - Returns `OrphanDerivedCandidate[]` with full detail (not just count)
   - For each principle, iterate `derivedFromPainIds`
   - Check each ID against ALL candidates in state.db (not just consumed)
   - If not found in candidates table at all → orphan with reason "candidate not found in state.db"
   - Include the principle's status and sourceRef

3. **Update `PruningHealthSummary` type** to include `orphanDerivedCandidates: OrphanDerivedCandidate[]` (optional, for backward compat)

#### File 2: `packages/pd-cli/src/commands/runtime-pruning.ts`

Add `handlePruningOrphans` function:

1. **Default behavior (dry-run)**: List all orphan derived candidates with detail
2. **With `--confirm`**: Actually remove orphan IDs from `derivedFromPainIds` in the ledger
   - Read ledger, remove orphan IDs from `derivedFromPainIds` arrays
   - Write updated ledger
   - Output audit trail: list of all modified principle IDs and removed candidate IDs
   - Must NOT delete the candidate row from state.db (it may still be valid)
   - Must NOT delete the principle entry itself

**Output shape (JSON)**:
```json
{
  "orphanDerivedCandidateCount": 18,
  "candidates": [
    {
      "candidateId": "P_001",
      "principleId": "some-uuid",
      "reason": "candidate not found in state.db",
      "sourceRef": "derivedFromPainIds",
      "status": "active"
    }
  ],
  "dryRun": true
}
```

With `--confirm`:
```json
{
  "orphanDerivedCandidateCount": 18,
  "candidates": [...],
  "dryRun": false,
  "removedFromPrinciples": [
    { "principleId": "some-uuid", "removedIds": ["P_001"] }
  ]
}
```

#### File 3: `packages/pd-cli/src/index.ts`

Register the new subcommand under `pruningCmd`:
```typescript
pruningCmd
  .command('orphans')
  .description('List orphan derived candidates not found in state.db')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--dry-run', 'Report only, no modifications (default)', true)
  .option('--confirm', 'Actually remove orphan references from ledger')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    handlePruningOrphans({ workspace: opts.workspace, dryRun: !opts.confirm, confirm: opts.confirm, json: opts.json });
  });
```

#### File 4: `packages/principles-core/src/runtime-v2/__tests__/pruning-read-model.test.ts`

Add tests:
1. `getOrphanDerivedCandidates()` returns list with detail, not just count
2. Orphan list includes candidateId, principleId, reason
3. Non-orphan candidates are not included

#### File 5: `packages/pd-cli/tests/commands/runtime-pruning.test.ts`

Add tests:
1. `handlePruningOrphans` dry-run outputs orphan list with count
2. Default is dry-run (no modifications)
3. `--confirm` removes orphan IDs from ledger `derivedFromPainIds`
4. `--confirm` does not touch non-orphan candidates
5. Health snapshot still works after orphan cleanup

### TDD Order (Red → Green)
1. Add `OrphanDerivedCandidate` type and `getOrphanDerivedCandidates()` test in pruning-read-model.test.ts (RED)
2. Implement `getOrphanDerivedCandidates()` in pruning-read-model.ts (GREEN)
3. Add CLI tests for `handlePruningOrphans` (RED)
4. Implement `handlePruningOrphans` in runtime-pruning.ts (GREEN)
5. Register command in index.ts
6. Run all tests

### Verification Commands
```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npx vitest run packages/principles-core/src/runtime-v2/__tests__/pruning-read-model.test.ts
npx vitest run packages/pd-cli/tests/commands/runtime-pruning.test.ts
pd runtime health snapshot --workspace "D:\.openclaw\workspace" --json
pd runtime pruning orphans --workspace "D:\.openclaw\workspace" --json
```

### Branch & PR
- Branch: `codex/pri-94-pruning-orphan-dry-run`
- PR title: `feat(runtime-v2): add pruning orphan dry-run report (PRI-94)`

---

## Cross-Cutting Constraints

1. **No local temp scripts in PRs** — `scripts/cleanup-orphan-candidates.ps1`, `patch-*.cjs`, `fix-*.ps1` must NOT be included in any PR diff
2. **No `.trae/` in PRs** — Ensure `.gitignore` covers it
3. **Strict TDD** — Write failing tests first, then implement
4. **Each PRI = separate branch + separate PR** — No mixing
5. **No data loss** — Migrations must be additive only; cleanup must be opt-in
6. **No hardcoded paths** — No `D:\Code\principles` in committed source
