# Phase m5-01: Artifact Registry Schema - Research

**Researched:** 2026-04-24
**Domain:** SQLite schema design for artifact/commit/principle_candidates tables in PD Runtime v2
**Confidence:** HIGH

## Summary

Phase m5-01 adds three new SQLite tables (`artifacts`, `commits`, `principle_candidates`) to the existing `state.db` managed by `SqliteConnection`. The existing schema has two tables (`tasks`, `runs`) with a well-established pattern: idempotent `CREATE TABLE IF NOT EXISTS` inside `initSchema()`, `CREATE INDEX IF NOT EXISTS` for indexes, and `PRAGMA foreign_keys = ON` enabled at connection open. The new tables introduce FK relationships into the existing tables and add UNIQUE constraints for idempotency enforcement.

The three tables form a linear FK dependency chain: `artifacts` references `runs`, `commits` references `tasks`+`runs`+`artifacts`, and `principle_candidates` references `artifacts`+`tasks`+`runs`. Creation order matters. All tables use TEXT primary keys (matching existing `task_id` / `run_id` patterns), ISO timestamp strings for temporal fields, and nullable TEXT columns for optional payloads.

**Primary recommendation:** Extend `SqliteConnection.initSchema()` with three new `db.exec()` blocks following the exact same idempotent pattern already used for tasks and runs. No new dependencies required -- the project already uses better-sqlite3 v12.9.0, @sinclair/typebox for schema validation, and vitest for testing.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ARTF-01 | `artifacts` table: artifact_id, run_id, task_id, artifact_kind, content_json, created_at | See Schema Design section -- column types, FK to runs, idempotent CREATE TABLE |
| ARTF-02 | `principle_candidates` table: candidate_id, artifact_id, task_id, source_run_id, title, description, confidence, source_recommendation_json, idempotency_key, status, created_at, consumed_at | See Schema Design section -- extended columns, FK chain, nullable fields, status enum |
| ARTF-03 | Foreign keys with ON DELETE CASCADE across all three tables | See FK Chain section -- linear dependency, SQLite CASCADE behavior verified |
| ARTF-04 | Indexes on artifacts(task_id, run_id, artifact_kind), candidates(status, source_run_id, task_id), commits(task_id, artifact_id) | See Index Strategy section -- all idempotent via CREATE INDEX IF NOT EXISTS |
| ARTF-05 | `commits` table: commit_id, task_id, run_id (UNIQUE), artifact_id, idempotency_key (UNIQUE), status, created_at | See Schema Design section -- UNIQUE constraints for 1:1 run-to-commit mapping |
| ARTF-06 | Uniqueness constraints: commits.run_id UNIQUE, commits.idempotency_key UNIQUE, principle_candidates.idempotency_key UNIQUE | See Uniqueness section -- SQLite UNIQUE constraint enforcement, INSERT OR IGNORE pattern |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Schema definition (DDL) | Database / Storage | -- | SQLite state.db owns all table definitions |
| Idempotent migration | Database / Storage | -- | SqliteConnection.initSchema() owns creation logic |
| FK constraint enforcement | Database / Storage | -- | SQLite engine enforces CASCADE at DB level |
| TypeBox schema for row records | API / Backend | -- | @sinclair/typebox schemas for runtime validation |
| Test infrastructure | Test layer | -- | vitest + in-memory SQLite for schema conformance |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.9.0 (installed) | SQLite driver | Already in use throughout store layer [VERIFIED: package.json] |
| @sinclair/typebox | ^0.34.48 (installed) | Schema validation | Used for all record validation (TaskRecordSchema, RunRecordSchema) [VERIFIED: package.json] |
| vitest | ^4.1.0 (installed) | Test framework | Already configured for store tests [VERIFIED: package.json, vitest.config.ts] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| TypeScript | project-wide | Type safety | All new code files |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Inline DDL in initSchema() | Migration framework (e.g., knex migrations) | Overkill for 3 new tables; existing pattern is inline DDL, changing it would break consistency |

**Installation:**
No new packages required. All dependencies already installed.

**Version verification:**
```
better-sqlite3: ^12.9.0 (installed, latest is 12.9.0) [VERIFIED: npm registry]
@sinclair/typebox: ^0.34.48 (installed) [VERIFIED: package.json]
vitest: ^4.1.0 (installed) [VERIFIED: package.json]
```

## Architecture Patterns

### System Architecture Diagram

```
tasks (existing)          runs (existing)
    ^                         ^  ^
    |                         |  |
    |                    FK   |  | FK
    |                         |  |
    +------+        +---------+  +---------+
           |        |                      |
           |   artifacts (NEW)             |
           |        ^                      |
           |        | FK                   |
           |        |                      |
           +--- commits (NEW) -------------+
           |        ^
           |        |
           +--------+
           |
   principle_candidates (NEW)

Data flow: run completes -> artifact created -> commit recorded -> candidates extracted
All writes happen in SqliteConnection.initSchema() (creation) and future committer (writes)
```

### Recommended Project Structure
```
src/runtime-v2/store/
  sqlite-connection.ts     # MODIFY: add 3 new table DDLs to initSchema()
  schema-conformance.test.ts  # EXTEND: add validation tests for new table schemas
  artifact-types.ts          # NEW (optional): TypeBox schemas for ArtifactRecord, CommitRecord, CandidateRecord
```

### Pattern 1: Idempotent Table Creation
**What:** Tables and indexes created with `IF NOT EXISTS` guards
**When to use:** Every new table added to state.db
**Example:**
```typescript
// Source: existing sqlite-connection.ts lines 46-66 [VERIFIED: codebase]
db.exec(`
  CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    artifact_kind TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(artifact_kind);
`);
```

### Pattern 2: TypeBox Schema for Record Validation
**What:** Every table row has a corresponding TypeBox schema for runtime validation on read
**When to use:** New record types read from SQLite
**Example:**
```typescript
// Source: existing task-status.ts, runtime-protocol.ts [VERIFIED: codebase]
export const ArtifactRecordSchema = Type.Object({
  artifactId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  taskId: Type.String({ minLength: 1 }),
  artifactKind: Type.String({ minLength: 1 }),
  contentJson: Type.String(),
  createdAt: Type.String(),
});
```

### Pattern 3: Test Fixture Setup
**What:** Tests create a temp directory, open SqliteConnection, verify schema, then clean up
**When to use:** All schema conformance tests
**Example:**
```typescript
// Source: existing schema-conformance.test.ts [VERIFIED: codebase]
beforeEach(() => {
  tmpdir = path.join(os.tmpdir(), `pd-test-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmpdir, { recursive: true });
  connection = new SqliteConnection(tmpdir);
});
afterEach(() => {
  connection.close();
  fs.rmSync(tmpdir, { force: true, recursive: true });
});
```

### Anti-Patterns to Avoid
- **ALTER TABLE for new tables:** Never ALTER existing tables to add new tables. Use CREATE TABLE IF NOT EXISTS in initSchema(). [VERIFIED: existing pattern]
- **Omitting IF NOT EXISTS:** Would cause errors on re-open. All DDL must be idempotent.
- **Creating tables before their FK targets:** artifacts must be created before commits and principle_candidates because they reference it. Order: artifacts, then commits, then principle_candidates.
- **Using INTEGER auto-increment PKs:** The existing convention is TEXT primary keys (UUIDs or structured IDs). Do not break this pattern.
- **Forgetting PRAGMA foreign_keys = ON:** Already enabled in getDb(). New FK constraints will be enforced automatically. [VERIFIED: sqlite-connection.ts line 37]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ID generation | Custom UUID generator | crypto.randomUUID() or structured IDs | Standard, collision-resistant, already used elsewhere |
| JSON serialization | Custom serializer | JSON.stringify/parse | SQLite TEXT column + JSON.parse on read is the existing pattern |
| Timestamp generation | Custom time format | new Date().toISOString() | Existing pattern throughout store layer |
| Schema validation | Manual field checks | @sinclair/typebox Value.Check() | Existing pattern in all rowToRecord methods |

**Key insight:** The store layer has a consistent, battle-tested pattern for every concern this phase needs. No new abstractions are required.

## Common Pitfalls

### Pitfall 1: FK Creation Order
**What goes wrong:** Creating `commits` before `artifacts` causes FK creation to fail because the referenced table doesn't exist yet.
**Why it happens:** SQLite validates FK references at CREATE TABLE time when `foreign_keys = ON`.
**How to avoid:** Create tables in dependency order: (1) tasks/runs (existing), (2) artifacts, (3) commits, (4) principle_candidates.
**Warning signs:** `SQLError: no such table: artifacts` during initSchema().

### Pitfall 2: UNIQUE Constraint Interaction with Transactions
**What goes wrong:** INSERT OR IGNORE silently swallows duplicate inserts, but the committer needs to return the existing commit_id. If using raw INSERT, UNIQUE violation throws.
**Why it happens:** UNIQUE constraint enforcement is immediate in SQLite.
**How to avoid:** Phase m5-01 only defines the schema. The committer (m5-02) should use INSERT ... ON CONFLICT DO NOTHING / DO UPDATE or INSERT OR IGNORE + SELECT to handle idempotency. Schema just needs the UNIQUE constraint in place.
**Warning signs:** Test inserting duplicate run_id into commits fails with CONSTRAINT_VIOLATION.

### Pitfall 3: Nullable Columns with UNIQUE
**What goes wrong:** SQLite treats NULL values as distinct for UNIQUE constraints, meaning multiple rows with NULL in a UNIQUE column are allowed.
**Why it happens:** SQL standard behavior -- NULL != NULL.
**How to avoid:** Ensure nullable UNIQUE columns like `consumed_at` are NOT UNIQUE. Only `idempotency_key` should be UNIQUE, and it should be NOT NULL.
**Warning signs:** Multiple candidates with NULL consumed_at don't violate UNIQUE (correct behavior, but worth noting).

### Pitfall 4: Forgetting to Test CASCADE Deletion
**What goes wrong:** FK declared with ON DELETE CASCADE but not verified -- if PRAGMA foreign_keys was off at connection time, CASCADE is silently ignored.
**Why it happens:** SQLite FK enforcement requires PRAGMA foreign_keys = ON per-connection.
**How to avoid:** Write explicit tests that delete a parent row and verify child rows are removed. The existing code already sets the pragma in getDb(). [VERIFIED: sqlite-connection.ts line 37]
**Warning signs:** Deleting a run leaves orphaned artifacts.

### Pitfall 5: Missing Index on FK Columns
**What goes wrong:** FK columns without indexes cause full table scans on CASCADE delete.
**Why it happens:** SQLite does not auto-create indexes on FK columns.
**How to avoid:** ARTF-04 explicitly lists all required indexes. Ensure every FK column that will be used in lookups or CASCADE operations has an index.
**Warning signs:** Slow DELETE operations as data grows.

## Code Examples

### Complete DDL for All Three Tables
```typescript
// Source: derived from REQUIREMENTS.md ARTF-01 through ARTF-06 and existing sqlite-connection.ts pattern

// Table 1: artifacts (depends on: runs, tasks)
db.exec(`
  CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    artifact_kind TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(artifact_kind);
`);

// Table 2: commits (depends on: tasks, runs, artifacts)
db.exec(`
  CREATE TABLE IF NOT EXISTS commits (
    commit_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    artifact_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'committed',
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_commits_task_id ON commits(task_id);
  CREATE INDEX IF NOT EXISTS idx_commits_artifact_id ON commits(artifact_id);
`);

// Table 3: principle_candidates (depends on: artifacts, tasks, runs)
db.exec(`
  CREATE TABLE IF NOT EXISTS principle_candidates (
    candidate_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    confidence REAL,
    source_recommendation_json TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    consumed_at TEXT,
    FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
    FOREIGN KEY (source_run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_candidates_status ON principle_candidates(status);
  CREATE INDEX IF NOT EXISTS idx_candidates_source_run_id ON principle_candidates(source_run_id);
  CREATE INDEX IF NOT EXISTS idx_candidates_task_id ON principle_candidates(task_id);
`);
```

### Schema Conformance Test Pattern
```typescript
// Source: existing schema-conformance.test.ts [VERIFIED: codebase]
it('artifacts table created idempotently', () => {
  const db = connection.getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'").all();
  expect(tables).toHaveLength(1);

  // Re-open should not throw
  connection.close();
  const conn2 = new SqliteConnection(tmpdir);
  expect(() => conn2.getDb()).not.toThrow();
  conn2.close();
});

it('commits FK CASCADE deletes artifacts row when run deleted', () => {
  const db = connection.getDb();
  // Insert parent records
  taskStore.createTask({ taskId: 't1', taskKind: 'test', status: 'pending', attemptCount: 0, maxAttempts: 3 });
  runStore.createRun({ runId: 'r1', taskId: 't1', runtimeKind: 'test-double', executionStatus: 'succeeded', startedAt: new Date().toISOString(), attemptNumber: 1 });
  db.prepare("INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run('a1', 'r1', 't1', 'diagnostician_output', '{}', new Date().toISOString());
  db.prepare("INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run('c1', 't1', 'r1', 'a1', 'ik-r1', 'committed', new Date().toISOString());

  // Delete the run
  db.prepare('DELETE FROM runs WHERE run_id = ?').run('r1');

  // Verify CASCADE
  const artifacts = db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get('a1');
  expect(artifacts).toBeUndefined();
  const commits = db.prepare('SELECT * FROM commits WHERE commit_id = ?').get('c1');
  expect(commits).toBeUndefined();
});

it('commits run_id UNIQUE prevents duplicate', () => {
  const db = connection.getDb();
  taskStore.createTask({ taskId: 't1', taskKind: 'test', status: 'pending', attemptCount: 0, maxAttempts: 3 });
  runStore.createRun({ runId: 'r1', taskId: 't1', runtimeKind: 'test-double', executionStatus: 'succeeded', startedAt: new Date().toISOString(), attemptNumber: 1 });
  db.prepare("INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run('a1', 'r1', 't1', 'diagnostician_output', '{}', new Date().toISOString());
  db.prepare("INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run('c1', 't1', 'r1', 'a1', 'ik-r1', 'committed', new Date().toISOString());

  // Duplicate run_id should fail
  expect(() => {
    db.prepare("INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run('c2', 't1', 'r1', 'a1', 'ik-r1-dup', 'committed', new Date().toISOString());
  }).toThrow(/UNIQUE constraint failed/);
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Runs FK without CASCADE | Runs FK with ON DELETE CASCADE | M2 (migration in sqlite-connection.ts) | Existing pattern already handles FK CASCADE migration |
| JSON in separate files | JSON in SQLite TEXT columns | M2 | content_json follows same pattern as diagnostic_json |

**Deprecated/outdated:**
- Nothing in this phase. The existing store pattern is current and stable.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `artifact_kind` values will always be short strings (e.g., "diagnostician_output") | Schema Design | Low -- column is TEXT with no length constraint |
| A2 | `status` column in commits will only use 'committed' value for M5 scope | Schema Design | Low -- TEXT allows future statuses without migration |
| A3 | `status` column in principle_candidates uses 'pending'/'consumed'/'expired' as TEXT enum | Schema Design | Low -- same TEXT enum pattern as PDTaskStatus |
| A4 | No need for a separate migration file -- inline DDL in initSchema() is sufficient | Architecture | Low -- matches existing 2-table pattern |

**Note:** A1-A4 are low-risk assumptions because SQLite TEXT columns are unbounded and the inline DDL pattern is proven across M1-M4. No user confirmation needed.

## Open Questions

1. **Should TypeBox schemas be defined in m5-01 or deferred to m5-02?**
   - What we know: TypeBox schemas are used for row validation on read (existing pattern). The committer (m5-02) will need them.
   - What's unclear: Whether defining them now (with the schema) or later (with the committer) is more appropriate.
   - Recommendation: Define them in m5-01 as part of the schema foundation. They cost nothing and make schema conformance tests cleaner.

2. **Should `artifact_kind` be a constrained enum or free-form TEXT?**
   - What we know: M5 only produces one kind: "diagnostician_output". Future milestones may add more.
   - What's unclear: Whether a CHECK constraint is worth the rigidity.
   - Recommendation: Leave as free-form TEXT. A CHECK constraint would need ALTER on every new kind. The TypeBox schema validates at read time instead.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| better-sqlite3 | Schema DDL | Yes | ^12.9.0 | -- |
| @sinclair/typebox | Schema validation | Yes | ^0.34.48 | -- |
| vitest | Test runner | Yes | ^4.1.0 | -- |
| TypeScript | Type checking | Yes | project-wide | -- |
| Node.js | Runtime | Yes | -- | -- |

**Missing dependencies with no fallback:**
None -- all dependencies already installed.

**Missing dependencies with fallback:**
None.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.1.0 |
| Config file | packages/principles-core/vitest.config.ts |
| Quick run command | `cd packages/principles-core && npx vitest run src/runtime-v2/store/schema-conformance.test.ts` |
| Full suite command | `cd packages/principles-core && npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ARTF-01 | artifacts table created idempotently with correct columns | unit | `npx vitest run src/runtime-v2/store/schema-conformance.test.ts -t "artifacts"` | No -- Wave 0 |
| ARTF-02 | principle_candidates table created idempotently with all columns including nullable confidence, consumed_at | unit | `npx vitest run src/runtime-v2/store/schema-conformance.test.ts -t "principle_candidates"` | No -- Wave 0 |
| ARTF-03 | FK CASCADE enforced: deleting run cascades to artifacts, commits, candidates | unit | `npx vitest run src/runtime-v2/store/schema-conformance.test.ts -t "CASCADE"` | No -- Wave 0 |
| ARTF-04 | All required indexes exist and are queryable | unit | `npx vitest run src/runtime-v2/store/schema-conformance.test.ts -t "index"` | No -- Wave 0 |
| ARTF-05 | commits table created idempotently with UNIQUE run_id and idempotency_key | unit | `npx vitest run src/runtime-v2/store/schema-conformance.test.ts -t "commits"` | No -- Wave 0 |
| ARTF-06 | UNIQUE constraints enforced on commits.run_id, commits.idempotency_key, candidates.idempotency_key | unit | `npx vitest run src/runtime-v2/store/schema-conformance.test.ts -t "UNIQUE"` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `cd packages/principles-core && npx vitest run src/runtime-v2/store/schema-conformance.test.ts`
- **Per wave merge:** `cd packages/principles-core && npx vitest run`
- **Phase gate:** Full suite green, plus manual verification that existing tests still pass.

### Wave 0 Gaps
- [ ] `src/runtime-v2/store/schema-conformance.test.ts` -- extend with artifacts/commits/candidates tests (file already exists, needs new test cases)
- [ ] No new framework install needed -- vitest already configured and running

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | No auth in scope |
| V3 Session Management | No | No sessions in scope |
| V4 Access Control | No | No access control in scope |
| V5 Input Validation | Yes | TypeBox Value.Check() on all records read from DB |
| V6 Cryptography | No | No crypto in scope |

### Known Threat Patterns for SQLite Schema

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via artifact content | Tampering | Parameterized queries (better-sqlite3 .prepare().run()) [VERIFIED: existing pattern] |
| Schema corruption | Tampering | Idempotent IF NOT EXISTS guards; no ALTER on existing tables |

## Sources

### Primary (HIGH confidence)
- Codebase: `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts` -- existing initSchema() pattern, FK CASCADE migration
- Codebase: `packages/principles-core/src/runtime-v2/store/schema-conformance.test.ts` -- test pattern reference
- Codebase: `packages/principles-core/src/runtime-v2/store/sqlite-task-store.ts` -- rowToRecord validation pattern
- Codebase: `packages/principles-core/src/runtime-v2/store/sqlite-run-store.ts` -- rowToRecord validation pattern
- Codebase: `packages/principles-core/package.json` -- dependency versions
- `.planning/milestones/pd-runtime-v2-m5/REQUIREMENTS.md` -- ARTF-01 through ARTF-06 specifications
- `.planning/milestones/pd-runtime-v2-m5/ROADMAP.md` -- phase m5-01 success criteria

### Secondary (MEDIUM confidence)
- npm registry: better-sqlite3 v12.9.0 confirmed as latest stable [VERIFIED: npm view]

### Tertiary (LOW confidence)
- None -- all findings verified against codebase or registry.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all dependencies verified in package.json
- Architecture: HIGH -- extending proven existing pattern, no novel designs
- Pitfalls: HIGH -- pitfalls derived from SQLite documentation and existing codebase behavior

**Research date:** 2026-04-24
**Valid until:** 2026-05-24 (stable -- schema design is foundational, unlikely to change)
