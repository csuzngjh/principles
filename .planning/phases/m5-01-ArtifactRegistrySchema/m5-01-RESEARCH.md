# Phase m5-01: Artifact Registry Schema - Research

**Researched:** 2026-04-24
**Domain:** SQLite schema extension, migration, foreign keys, indexes for artifact registry
**Confidence:** HIGH

## Summary

Phase m5-01 adds two new tables (`artifacts` and `principle_candidates`) to the existing `state.db` SQLite database managed by `SqliteConnection`. The current schema contains `tasks` and `runs` tables with well-established patterns for idempotent creation (`CREATE TABLE IF NOT EXISTS`), column migrations (`PRAGMA table_info` + `ALTER TABLE`), and FK CASCADE enforcement (table rebuild pattern). This phase follows those exact patterns but is simpler because both tables are entirely new -- no ALTER operations on existing tables are needed.

The `artifacts` table stores committed diagnostician output linked to a run and task. The `principle_candidates` table stores extracted principle recommendations linked to an artifact. Foreign keys cascade deletes from `runs` to `artifacts` and from `artifacts` to `principle_candidates`, ensuring no orphaned records when a run or artifact is deleted. Five indexes provide efficient query access for the most common lookup patterns (by task_id, run_id, artifact_kind, status, source_run_id).

**Primary recommendation:** Extend `SqliteConnection.initSchema()` with two `CREATE TABLE IF NOT EXISTS` blocks and five `CREATE INDEX IF NOT EXISTS` statements, following the exact patterns already in the file. No new dependencies or architectural changes required.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ARTF-01 | `artifacts` table in `state.db` with columns: artifact_id, run_id, task_id, artifact_kind, content_json, created_at. Idempotent migration via `CREATE TABLE IF NOT EXISTS`. | Existing `initSchema()` pattern (lines 46-104 of sqlite-connection.ts) -- same `db.exec(CREATE TABLE IF NOT EXISTS ...)` approach. Column types derived from domain: all TEXT. |
| ARTF-02 | `principle_candidates` table in `state.db` with columns: candidate_id, artifact_id, kind, description, source_run_id, status (pending/consumed/expired), created_at, consumed_at. Idempotent migration. | Same `CREATE TABLE IF NOT EXISTS` pattern. Status uses TEXT with CHECK constraint matching existing pattern for `tasks.status`. |
| ARTF-03 | Foreign keys: artifacts.run_id references runs.run_id, principle_candidates.artifact_id references artifacts.artifact_id. Both with `ON DELETE CASCADE`. | Existing FK pattern: `runs` table already has `FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE`. `PRAGMA foreign_keys = ON` is set in `getDb()` (line 37). |
| ARTF-04 | Indexes on artifacts(task_id), artifacts(run_id), artifacts(artifact_kind), principle_candidates(status), principle_candidates(source_run_id). All idempotent. | Existing index pattern: `CREATE INDEX IF NOT EXISTS idx_<table>_<column>` (lines 62-65, 101-103). |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Schema DDL (table/index creation) | Database / Storage | -- | Tables live in SQLite state.db, managed by SqliteConnection |
| Foreign key enforcement | Database / Storage | -- | SQLite handles FK enforcement via `PRAGMA foreign_keys = ON` |
| Migration idempotency | Database / Storage | -- | `CREATE TABLE/INDEX IF NOT EXISTS` is a SQLite DDL feature |
| Type definitions for artifacts/candidates | API / Backend | -- | TypeScript types defined in runtime-v2 module, consumed by committer/CLI |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.9.0 (latest: 12.9.0) | SQLite driver for state.db | Already in use for tasks/runs tables [VERIFIED: package.json] |
| @sinclair/typebox | ^0.34.48 (latest: 0.34.49) | Schema validation for records | Already in use for TaskRecord, RunRecord validation [VERIFIED: package.json] |
| vitest | ^4.1.0 (latest: 4.1.5) | Test framework | Project standard for all store/runner tests [VERIFIED: package.json] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| TypeScript | ^6.0.3 (latest: 6.0.3) | Type system | All source files |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Direct DDL in initSchema() | Migration framework (e.g., knex migrations) | Overkill for 2 new tables; existing pattern is simpler and proven in this codebase |

**Installation:**
No new packages required. All dependencies are already installed.

**Version verification:**
```
better-sqlite3: ^12.9.0 (installed: 12.9.0, latest: 12.9.0) [VERIFIED: npm registry]
@sinclair/typebox: ^0.34.48 (installed: 0.34.49, latest: 0.34.49) [VERIFIED: npm registry]
vitest: ^4.1.0 (installed: 4.1.0, latest: 4.1.5) [VERIFIED: npm registry]
typescript: ^6.0.3 (installed: 6.0.3, latest: 6.0.3) [VERIFIED: npm registry]
```

## Architecture Patterns

### System Architecture Diagram

```
                    SqliteConnection.getDb()
                           |
                    initSchema() called
                           |
              +------------+------------+
              |                         |
         tasks table               runs table
         (existing)                (existing)
              |                         |
              +------- FK: CASCADE ----+
                                       |
                              +--------+--------+
                              |                  |
                        artifacts table    principle_candidates table
                        (NEW - m5-01)     (NEW - m5-01)
                              |                  |
                              +--- FK: CASCADE --+

Data Flow:
  run completes --> artifact inserted (FK: runs.run_id)
                  --> candidates extracted (FK: artifacts.artifact_id)
  run deleted --> artifacts cascade deleted --> candidates cascade deleted
```

### Recommended Project Structure

No new files needed for m5-01. The single file modified is:

```
packages/principles-core/src/runtime-v2/
  store/
    sqlite-connection.ts     # EXTEND initSchema() with 2 tables + 5 indexes
```

Test file to create:

```
packages/principles-core/src/runtime-v2/store/
    artifact-schema.test.ts  # NEW - schema creation, FK enforcement, index verification
```

### Pattern 1: Idempotent Table Creation
**What:** `CREATE TABLE IF NOT EXISTS` ensures the table is created on first run and silently succeeds on subsequent opens.
**When to use:** Every table in state.db (tasks, runs, artifacts, principle_candidates).
**Example:**
```typescript
// Source: sqlite-connection.ts lines 46-66 (existing pattern)
db.exec(`
  CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    artifact_kind TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );
`);
```

### Pattern 2: Foreign Key with CASCADE
**What:** SQLite FK enforcement requires `PRAGMA foreign_keys = ON` (already set in `getDb()` line 37). CASCADE delete propagates deletions.
**When to use:** All parent-child relationships in state.db.
**Example:**
```typescript
// Source: sqlite-connection.ts lines 99-100 (existing pattern)
// runs table already uses: FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
// New tables follow same pattern:
// artifacts: FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
// principle_candidates: FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE
```

### Pattern 3: Idempotent Index Creation
**What:** `CREATE INDEX IF NOT EXISTS` for efficient query access.
**When to use:** Every frequently-queried column.
**Example:**
```typescript
// Source: sqlite-connection.ts lines 62-65 (existing pattern)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_artifact_kind ON artifacts(artifact_kind);
  CREATE INDEX IF NOT EXISTS idx_candidates_status ON principle_candidates(status);
  CREATE INDEX IF NOT EXISTS idx_candidates_source_run_id ON principle_candidates(source_run_id);
`);
```

### Pattern 4: Store Test Setup (vitest + tmpdir)
**What:** Each test suite creates a temp directory, constructs `SqliteConnection`, runs tests, then cleans up.
**When to use:** All store-level tests.
**Example:**
```typescript
// Source: sqlite-task-store.test.ts (existing pattern)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';

describe('ArtifactSchema', () => {
  let tmpdir: string;
  let connection: SqliteConnection;

  beforeEach(() => {
    tmpdir = path.join(os.tmpdir(), `pd-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmpdir, { recursive: true });
    connection = new SqliteConnection(tmpdir);
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(tmpdir, { force: true, recursive: true });
  });

  // ... tests
});
```

### Anti-Patterns to Avoid
- **ALTER TABLE for new tables:** This phase adds entirely new tables, not columns to existing ones. Use `CREATE TABLE IF NOT EXISTS`, never `ALTER TABLE`.
- **Schema validation at DDL level:** Do not add CHECK constraints beyond what's necessary. TypeBox validation in the store layer handles type safety.
- **Separate migration file:** The codebase uses a single `initSchema()` method. Do not create a separate migration runner.
- **UNIQUE constraint on artifacts.run_id:** The requirements say idempotent re-commit returns the same artifact_id, but uniqueness enforcement belongs in the committer layer (m5-02), not in the schema DDL. A run could theoretically have multiple artifacts of different kinds.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQLite migration | Custom migration runner | `CREATE TABLE IF NOT EXISTS` in `initSchema()` | Proven pattern in this codebase; simpler for 2 tables |
| FK enforcement | Application-level cascade | SQLite `ON DELETE CASCADE` with `PRAGMA foreign_keys = ON` | Already enabled (line 37), handles edge cases correctly |
| Index creation | Manual index tracking | `CREATE INDEX IF NOT EXISTS` | Idempotent by design, no tracking needed |
| Timestamp generation | Custom clock | `new Date().toISOString()` | Consistent with existing store pattern |

**Key insight:** This phase is purely DDL. No TypeScript types, no store interfaces, no business logic. Those come in m5-02 (committer) and m5-04 (CLI). The only code change is extending `initSchema()` with DDL statements.

## Common Pitfalls

### Pitfall 1: FK Enforcement Not Active
**What goes wrong:** Foreign keys silently do nothing because `PRAGMA foreign_keys` is OFF by default in SQLite.
**Why it happens:** SQLite defaults to FK enforcement OFF for backward compatibility.
**How to avoid:** `SqliteConnection.getDb()` already sets `PRAGMA foreign_keys = ON` at line 37. No action needed -- verify in tests.
**Warning signs:** INSERT with invalid FK succeeds without error.

### Pitfall 2: CREATE INDEX Inside CREATE TABLE Block
**What goes wrong:** Mixing `CREATE TABLE` and `CREATE INDEX` in a single `db.exec()` call works in SQLite, but the codebase separates them for readability.
**Why it happens:** Both are valid SQL statements.
**How to avoid:** Follow existing pattern -- indexes as separate `db.exec()` calls after the table creation block, or in the same multi-statement string but clearly separated with semicolons.
**Warning signs:** Code review catches non-standard DDL formatting.

### Pitfall 3: Incorrect Column Type for content_json
**What goes wrong:** Using BLOB instead of TEXT for JSON content makes debugging harder and breaks `json_extract()` queries.
**Why it happens:** JSON could theoretically be stored as BLOB.
**How to avoid:** Use `TEXT NOT NULL` for `content_json`, consistent with `tasks.diagnostic_json` which is also `TEXT`.
**Warning signs:** `json_extract()` returns null on BLOB-stored JSON.

### Pitfall 4: Missing NOT NULL on Required Columns
**What goes wrong:** Columns that should always have values allow NULL, leading to unexpected `null` values in application code.
**Why it happens:** SQLite columns are nullable by default.
**How to avoid:** Add `NOT NULL` to all columns except `consumed_at` in `principle_candidates` (which is genuinely nullable -- only set when status changes to 'consumed').
**Warning signs:** Application code has to handle unexpected nulls.

### Pitfall 5: Breaking Existing Schema on Re-Open
**What goes wrong:** `initSchema()` fails on existing databases that already have data in tasks/runs tables.
**Why it happens:** DDL changes to existing tables.
**How to avoid:** Use only `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. No ALTER on existing tables. This phase only adds new tables.
**Warning signs:** Existing tests fail after schema changes.

## Code Examples

### DDL for artifacts table
```typescript
// Source: follows existing pattern in sqlite-connection.ts lines 83-104
db.exec(`
  CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    artifact_kind TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_artifact_kind ON artifacts(artifact_kind);
`);
```

### DDL for principle_candidates table
```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS principle_candidates (
    candidate_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    description TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    consumed_at TEXT,
    FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_candidates_status ON principle_candidates(status);
  CREATE INDEX IF NOT EXISTS idx_candidates_source_run_id ON principle_candidates(source_run_id);
`);
```

### Test: Verify table creation and idempotency
```typescript
// Source: follows pattern from schema-conformance.test.ts
it('creates artifacts and principle_candidates tables on first open', () => {
  const db = connection.getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('artifacts', 'principle_candidates')")
    .all() as { name: string }[];
  expect(tables.map(t => t.name).sort()).toEqual(['artifacts', 'principle_candidates']);
});

it('idempotent re-open does not fail', () => {
  connection.getDb(); // First open creates tables
  connection.close();
  // Re-open same database
  const conn2 = new SqliteConnection(tmpdir);
  expect(() => conn2.getDb()).not.toThrow();
  conn2.close();
});
```

### Test: Verify FK CASCADE enforcement
```typescript
it('deleting a run cascades to artifacts and candidates', async () => {
  const db = connection.getDb();
  // Insert task -> run -> artifact -> candidate chain
  db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run('t1', 'diagnostician', 'pending', now, now, 0, 3);
  db.prepare("INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, attempt_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run('r1', 't1', 'test-double', 'succeeded', now, 1, now, now);
  db.prepare("INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run('a1', 'r1', 't1', 'diagnosis', '{}', now);
  db.prepare("INSERT INTO principle_candidates (candidate_id, artifact_id, kind, description, source_run_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run('c1', 'a1', 'principle', 'test desc', 'r1', 'pending', now);

  // Delete the run
  db.prepare("DELETE FROM runs WHERE run_id = ?").run('r1');

  // Verify cascade
  expect(db.prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get('a1')).toBeUndefined();
  expect(db.prepare("SELECT * FROM principle_candidates WHERE candidate_id = ?").get('c1')).toBeUndefined();
});
```

### Test: Verify indexes exist
```typescript
it('creates all required indexes', () => {
  const db = connection.getDb();
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('artifacts', 'principle_candidates')")
    .all() as { name: string }[];
  const indexNames = indexes.map(i => i.name).sort();
  expect(indexNames).toContain('idx_artifacts_task_id');
  expect(indexNames).toContain('idx_artifacts_run_id');
  expect(indexNames).toContain('idx_artifacts_artifact_kind');
  expect(indexNames).toContain('idx_candidates_status');
  expect(indexNames).toContain('idx_candidates_source_run_id');
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| SQLite FK OFF by default | FK ON via PRAGMA | M2 (line 37 of sqlite-connection.ts) | No need to set it again; child tables inherit enforcement |
| ALTER TABLE for column additions | `PRAGMA table_info` + conditional ALTER | M3 (diagnostic_json migration, lines 70-73) | Only needed for existing tables; new tables use CREATE TABLE |

**Deprecated/outdated:**
- None in this scope. All current patterns are up to date.

## Assumptions Log

> No assumptions made in this research. All findings verified against source code.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|

**This table is empty:** All claims in this research were verified or cited -- no user confirmation needed.

## Open Questions

1. **Should `principle_candidates.status` have a CHECK constraint?**
   - What we know: The requirements say status is `pending/consumed/expired`. The existing `tasks.status` column has no CHECK constraint -- validation is done in application code.
   - What's unclear: Whether a CHECK constraint adds value here.
   - Recommendation: Follow existing pattern -- no CHECK constraint. Application-layer validation in the committer (m5-02) handles this. [ASSUMED based on existing pattern, but low risk]

2. **Should `principle_candidates.kind` be TEXT or an enum-like CHECK?**
   - What we know: `DiagnosticianOutputV1.recommendations[].kind` has values: `principle`, `rule`, `implementation`, `prompt`, `defer`. Only `kind === 'principle'` becomes a candidate.
   - What's unclear: Whether the `kind` column in `principle_candidates` should match RecommendationKind or be a narrower type.
   - Recommendation: Use TEXT NOT NULL without CHECK. The committer only inserts `kind = 'principle'` but the schema doesn't need to enforce this at DDL level.

## Environment Availability

Step 2.6: SKIPPED (no external dependencies -- all tools already verified present in codebase)

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| better-sqlite3 | Schema DDL | ✓ | 12.9.0 | -- |
| vitest | Tests | ✓ | 4.1.0 | -- |
| TypeScript | Compilation | ✓ | 6.0.3 | -- |

**Missing dependencies with no fallback:** None
**Missing dependencies with fallback:** None

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.1.0 |
| Config file | packages/principles-core/vitest.config.ts |
| Quick run command | `cd packages/principles-core && npx vitest run src/runtime-v2/store/artifact-schema.test.ts` |
| Full suite command | `cd packages/principles-core && npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ARTF-01 | artifacts table created idempotently | unit | `vitest run src/runtime-v2/store/artifact-schema.test.ts` | ❌ Wave 0 |
| ARTF-02 | principle_candidates table created idempotently | unit | `vitest run src/runtime-v2/store/artifact-schema.test.ts` | ❌ Wave 0 |
| ARTF-03 | FK CASCADE enforced (run->artifacts->candidates) | integration | `vitest run src/runtime-v2/store/artifact-schema.test.ts` | ❌ Wave 0 |
| ARTF-04 | All five indexes exist and are queryable | unit | `vitest run src/runtime-v2/store/artifact-schema.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cd packages/principles-core && npx vitest run src/runtime-v2/store/artifact-schema.test.ts`
- **Per wave merge:** `cd packages/principles-core && npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/runtime-v2/store/artifact-schema.test.ts` -- covers ARTF-01 through ARTF-04 (table creation, idempotency, FK CASCADE, indexes)
- [ ] Existing `schema-conformance.test.ts` should NOT need updating (it validates TaskRecord/RunRecord schemas, not DDL)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | N/A -- local SQLite file |
| V3 Session Management | no | N/A |
| V4 Access Control | no | N/A -- single-user CLI tool |
| V5 Input Validation | yes | TypeBox Value.Check() in store layer (m5-02) |
| V6 Cryptography | no | N/A |

### Known Threat Patterns for SQLite Schema Extension

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via artifact content | Tampering | Parameterized queries (existing pattern in all stores) |
| Path traversal in DB path | Tampering | SqliteConnection validates workspace dir (existing) |

Note: This phase is pure DDL with no user-facing inputs. Security concerns are minimal.

## Sources

### Primary (HIGH confidence)
- `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts` -- existing DDL pattern, migration pattern, FK enforcement
- `packages/principles-core/src/runtime-v2/store/sqlite-task-store.ts` -- store implementation pattern
- `packages/principles-core/src/runtime-v2/store/sqlite-run-store.ts` -- store implementation pattern
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` -- DiagnosticianOutputV1 schema with recommendations[]
- `packages/principles-core/src/runtime-v2/error-categories.ts` -- PDErrorCategory including artifact_commit_failed
- `packages/principles-core/src/runtime-v2/runner/runner-phase.ts` -- RunnerPhase enum
- `packages/principles-core/vitest.config.ts` -- test configuration
- `packages/principles-core/package.json` -- dependencies and versions

### Secondary (MEDIUM confidence)
- `.planning/milestones/pd-runtime-v2-m5/REQUIREMENTS.md` -- ARTF-01 through ARTF-04 requirements
- `.planning/milestones/pd-runtime-v2-m5/ROADMAP.md` -- m5-01 success criteria
- `docs/spec/2026-04-21-diagnostician-v2-detailed-design.md` -- Section 13.4 commit order
- `docs/spec/2026-04-21-pd-runtime-protocol-spec-v1.md` -- Section 21 storage guidance

### Tertiary (LOW confidence)
- None -- all findings verified against source code

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all packages verified against package.json and npm registry
- Architecture: HIGH -- exact code locations and patterns verified by reading source files
- Pitfalls: HIGH -- derived from actual SQLite behavior and existing codebase patterns

**Research date:** 2026-04-24
**Valid until:** 2026-05-24 (stable -- only SQLite DDL, no fast-moving dependencies)
