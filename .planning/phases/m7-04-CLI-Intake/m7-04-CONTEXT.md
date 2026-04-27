---
phase: m7-04-CLI-Intake
tags: [cli, pd-cli, candidate-intake, intake-handler, status-transition]
---

# Phase m7-04: CLI — `pd candidate intake`

**Gathered:** 2026-04-26

<domain>
## Phase Boundary

**Domain:** CLI handler for `pd candidate intake --candidate-id <id> --workspace <path> [--json] [--dry-run]`. Wires together CandidateIntakeService + PrincipleTreeLedgerAdapter, updates candidate status to `consumed`, and formats output for CLI users.

**Scope:**
- `handleCandidateIntake()` function in `packages/pd-cli/src/commands/candidate.ts`
- CLI argument parsing: `--candidate-id <id>` (required), `--workspace <path>`, `--json`, `--dry-run`
- Status transition: ledger write FIRST, then `principle_candidates.status = 'consumed'`
- Output format: JSON (`--json`) or human-readable (default)
- Error handling with user-friendly CLI messages

**Non-goals:**
- No CandidateIntakeService changes (m7-03 already complete)
- No LedgerAdapter changes (m7-02 already complete)
- No promotion to active principle
- No pain signal bridge

</domain>

<decisions>
## Implementation Decisions

### CLI-01 — Status Transition Order (D-09 applied)

**Decision: Ledger write FIRST, then update candidate status to `'consumed'`.**

Following D-09 from m7-01 CONTEXT.md: "Status transition order: write to ledger FIRST, then UPDATE `principle_candidates.status = 'consumed'`."

Implementation sequence in `handleCandidateIntake()`:
1. Create RuntimeStateManager, PrincipleTreeLedgerAdapter, CandidateIntakeService
2. Call `service.intake(candidateId)` — writes ledger entry (or returns existing if idempotent)
3. If ledger write succeeds (or entry already existed), update candidate status: `stateManager.updateCandidateStatus(candidateId, 'consumed')`
4. If ledger write fails, candidate stays `pending` (service already ensures this per E-01)

**Rationale:** If ledger write fails, we can retry later. If we marked `consumed` first and then ledger write fails, we'd need compensation logic. D-09 explicitly mandates this order.

### CLI-02 — `--dry-run` Implementation

**Decision: Dry-run builds the entry but skips both ledger write and status update.**

Implementation:
- Parse `--dry-run` flag in `handleCandidateIntake()`
- If dry-run:
  1. Load candidate via `stateManager.getCandidate(candidateId)`
  2. Load artifact via `stateManager.getArtifact(candidate.artifactId)`
  3. Parse artifact JSON to extract recommendation
  4. Build the 11-field `LedgerPrincipleEntry` (same logic as CandidateIntakeService)
  5. Display the entry (JSON or human-readable)
  6. **Do NOT call** `service.intake()` — no ledger write
  7. **Do NOT update** candidate status — stays `pending`
- If NOT dry-run: proceed with normal intake flow (CLI-01)

**Rationale:** Dry-run should show exactly what would be written without side effects. The CandidateIntakeService doesn't expose a "preview" method, so the CLI handler duplicates the entry-building logic. This is acceptable because:
- Entry building is simple (extract fields from candidate + artifact)
- Duplication is limited to this single preview use case
- Service logic remains clean without a preview-only method

### CLI-03 — Output Format

**Decision: Follow existing pattern from `handleCandidateShow()` and `handleCandidateList()`.**

Default output (human-readable):
```
Principle Candidate Intake: <candidateId>

  Candidate:    <candidateId>
  Title:        <title>
  Ledger Entry: <ledgerEntryId>
  Status:        consumed

Intake complete.
```

JSON output (`--json`):
```json
{
  "candidateId": "<candidateId>",
  "ledgerEntryId": "<ledgerEntryId>",
  "status": "consumed"
}
```

**Rationale:** Per ROADMAP.md m7-04 success criteria #2: "Output is machine-readable JSON: `{ candidateId, status, ledgerEntryId }`". The `--json` flag follows existing pattern in `candidate.ts` (lines 46, 98). Human-readable format follows the same style as `handleCandidateShow()` (lines 102-111).

### CLI-04 — Error Handling for CLI

**Decision: Catch `CandidateIntakeError` and output user-friendly messages via `console.error()`, then `process.exit(1)`.**

Error display pattern (following existing `candidate.ts` line 93):
```typescript
try {
  // intake logic
} catch (err) {
  if (err instanceof CandidateIntakeError || err.name === 'CandidateIntakeError') {
    console.error(`Intake failed [${err.code}]: ${err.message}`);
  } else {
    console.error(`Intake failed: ${String(err)}`);
  }
  process.exit(1);
}
```

**Idempotent intake (already consumed):** Per D-10, re-intaking an already-consumed candidate returns the existing entry without error. The CLI handler should:
- Detect that candidate status is already `'consumed'` (check before or after intake)
- Output a info message: `"Candidate <id> was already consumed. Ledger entry: <ledgerEntryId>"`
- Exit successfully (no error)

**Rationale:** Follows existing error handling pattern in `candidate.ts`. The `instanceof` cross-module issue is solved by checking `err.name === 'CandidateIntakeError'` as fallback (already proven in m7-03 tests).

### CLI-05 — Dependency Wiring in CLI Handler

**Decision: CLI handler creates all dependencies, following DI pattern from D-07.**

```typescript
export async function handleCandidateIntake(opts: CandidateIntakeOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: workspaceDir });
  const service = new CandidateIntakeService({ stateManager, ledgerAdapter });

  // ... intake logic (CLI-01 through CLI-04)
}
```

**Rationale:** Per D-07 (m7-01 CONTEXT): "Adapter is injected into CandidateIntakeService via constructor dependency injection. Caller (CLI handler or test) creates the concrete implementation and passes it in." The CLI handler is the "caller" that wires everything together. Same pattern as `handleTaskList()` creating `RuntimeStateManager`.

### CLI-06 — Import Strategy for openclaw-plugin Types

**Decision: Import `PrincipleTreeLedgerAdapter` from `@principles/openclaw-plugin` package (or direct path if package alias not configured).**

The adapter lives in `packages/openclaw-plugin/src/core/principle-tree-ledger-adapter.ts`. The pd-cli package needs to import it.

Options:
1. **Package import:** `import { PrincipleTreeLedgerAdapter } from '@principles/openclaw-plugin'` — requires the package to export the adapter and be built first
2. **Direct path import:** `import { PrincipleTreeLedgerAdapter } from '../../openclaw-plugin/src/core/principle-tree-ledger-adapter.js'` — works without build step but brittle

**Chosen: Option 1 (package import)** with fallback to direct import if package exports not yet configured.

Check if `@principles/openclaw-plugin` exports the adapter:
- Read `packages/openclaw-plugin/src/index.ts` (or `packages/openclaw-plugin/index.ts`)
- If not exported, add export there
- pd-cli must have `@principles/openclaw-plugin` in its dependencies

**Rationale:** Proper package separation. The adapter is an implementation detail of openclaw-plugin, but it needs to be实例化 by the CLI handler. This is the same pattern as importing `RuntimeStateManager` from `@principles/core`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### CLI Patterns (pd-cli)
- `packages/pd-cli/src/commands/candidate.ts` — `handleCandidateList()`, `handleCandidateShow()` — existing CLI patterns, --json flag, error handling, resolveWorkspaceDir()
- `packages/pd-cli/src/commands/task.ts` — `handleTaskList()`, `handleTaskShow()` — RuntimeStateManager creation, initialization, try/finally pattern
- `packages/pd-cli/src/resolve-workspace.ts` — `resolveWorkspaceDir()`, WORKSPACE_ENV constant

### Service Layer (principles-core — SHIPPED)
- `packages/principles-core/src/runtime-v2/candidate-intake-service.ts` — `CandidateIntakeService`, `CandidateIntakeServiceOptions` — intake() method, error codes
- `packages/principles-core/src/runtime-v2/candidate-intake.ts` — `CandidateIntakeError`, `INTAKE_ERROR_CODES`, `LedgerAdapter` interface, `LedgerPrincipleEntry` type
- `packages/principles-core/src/runtime-v2/index.ts` — barrel exports for all intake types

### Adapter Layer (openclaw-plugin — SHIPPED)
- `packages/openclaw-plugin/src/core/principle-tree-ledger-adapter.ts` — `PrincipleTreeLedgerAdapter` class, writeProbationEntry(), existsForCandidate()
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` — `addPrincipleToLedger()`, `LedgerPrinciple` type

### State Management (principles-core)
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` — `RuntimeStateManager`, `updateCandidateStatus()`, `getCandidate()`, `getArtifact()`

### Prior Phase Context
- `.planning/phases/m7-01-Candidate-Intake-Contract/m7-01-CONTEXT.md` — D-09 (status transition order), D-10 (idempotency), D-11 (sourceRef format)
- `.planning/phases/m7-02-PrincipleTreeLedger-Adapter/m7-02-CONTEXT.md` — Field expansion, adapter in-memory Map, status mapping ('probation' → 'candidate')
- `.planning/phases/m7-03-CandidateIntakeService/m7-03-01-SUMMARY.md` — Service implementation, 11-field entry building
- `.planning/phases/m7-03-CandidateIntakeService/m7-03-02-SUMMARY.md` — Test patterns, error handling

### Roadmap
- `.planning/ROADMAP.md` §Phase m7-04 — Success criteria 1-4, CLI flags (--candidate-id, --workspace, --json, --dry-run)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `resolveWorkspaceDir(workspace?)` — resolves workspace from flag, env var, or throws
- `RuntimeStateManager` — `initialize()`, `getCandidate()`, `getArtifact()`, `updateCandidateStatus()`, `close()`
- `CandidateIntakeService` — `intake(candidateId)` returns `Promise<LedgerPrincipleEntry>`
- `PrincipleTreeLedgerAdapter` — constructor takes `{ stateDir: string }`, implements `LedgerAdapter`
- `CandidateIntakeError` — error class with `.code` and `.message`

### Established Patterns
- CLI handlers: create manager, try/initialize/finally/close
- `--json` flag: `if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }`
- Error output: `console.error(...)`, then `process.exit(1)`
- Export handler functions from `candidate.ts`, register in CLI main entry point

### Integration Points
- pd-cli depends on principles-core (has `@principles/core` in package.json)
- pd-cli may need to add dependency on openclaw-plugin (for PrincipleTreeLedgerAdapter)
- CLI entry point (likely `packages/pd-cli/src/index.ts` or similar) registers `pd candidate intake` subcommand

</code_context>

<specifics>
## Specific Ideas

### CLI Entry Point Registration

The `pd candidate intake` command needs to be registered in the CLI framework. Based on existing patterns:
- `handleCandidateList` and `handleCandidateShow` are already registered
- Need to add `handleCandidateIntake` registration following same pattern

Likely registration code (to be confirmed in planning):
```typescript
// In CLI setup:
.command('intake')
  .description('Intake a principle candidate into the ledger')
  .requiredOption('--candidate-id <id>', 'Candidate ID to intake')
  .option('--workspace <path>', 'Workspace directory')
  .option('--json', 'Output as JSON')
  .option('--dry-run', 'Show what would be written without writing')
  .action(async (opts) => {
    await handleCandidateIntake(opts);
  });
```

### Candidate Status Check Before Intake

To support idempotent re-intake (CLI-04), the handler should check candidate status BEFORE calling intake:
- If status is already `'consumed'`, skip intake, output info message
- This avoids unnecessary ledger adapter lookup (though adapter is idempotent anyway)

OR skip this check and let the service/adapter handle idempotency (simpler, relies on D-10).

**Chosen:** Skip pre-check. Let service/adapter handle idempotency. Simpler code, no race condition concerns.

</specifics>

<deferred>
## Deferred Ideas

- **Bulk intake:** `pd candidate intake --task-id <taskId>` to intake all pending candidates for a task. Defer to future phase.
- **Interactive mode:** Prompt user for confirmation before intake. Defer to future phase.
- **Ledger entry display:** `pd candidate show <id>` showing ledger entry link (E2E-INTAKE-04). This is m7-05 scope.
- **Package export wiring:** If `@principles/openclaw-plugin` doesn't export `PrincipleTreeLedgerAdapter`, need to add it. This is a prerequisite for m7-04 implementation.

</deferred>

---
*Phase: m7-04-CLI-Intake*
*Context gathered: 2026-04-26*
