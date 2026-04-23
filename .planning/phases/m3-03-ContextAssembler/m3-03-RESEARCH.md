# Phase m3-03: Context Assembler — Research

**Date:** 2026-04-22
**Status:** Complete

## Implementation Pattern Analysis

### Constructor Signature
- `private readonly` for injected dependencies
- Implement corresponding interface
- Dependencies are abstractions, not concrete implementations
- No direct SqliteConnection dependency (compose existing abstractions)

### Method Signature
- Interface: `assemble(taskId: string): Promise<DiagnosticianContextPayload>`
- No options parameter in initial implementation

### Error Handling (PDRuntimeError)
- Task not found: `PDRuntimeError('storage_unavailable', ...)`
- Task is not diagnostician: `PDRuntimeError('input_invalid', ...)`
- Never throw for empty history (return valid payload)

### Return Type Validation (TypeBox)
- `Value.Check(DiagnosticianContextPayloadSchema, payload)` on return
- Throw `PDRuntimeError('storage_unavailable', ...)` on validation failure

### Test Setup Pattern
```typescript
function createFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-context-assembler-test-'));
  const connection = new SqliteConnection(tmpDir);
  const taskStore = new SqliteTaskStore(connection);
  const runStore = new SqliteRunStore(connection);
  const historyQuery = new SqliteHistoryQuery(connection);
  const assembler = new SqliteContextAssembler(taskStore, historyQuery);
  return { tmpDir, connection, taskStore, runStore, historyQuery, assembler };
}
```

## Data Availability

### From TaskStore.getTask()
- Base TaskRecord: taskId, taskKind, status, createdAt, updatedAt, attemptCount, maxAttempts, etc.
- DiagnosticianTaskRecord adds: workspaceDir, sourcePainId, severity, source, sessionIdHint, agentIdHint, reasonSummary

### From HistoryQuery.query()
- sourceRef: string (= taskId)
- entries: HistoryQueryEntry[] → conversationWindow
- truncated: boolean → ambiguityNotes generation
- nextCursor: NOT used in payload

### runIds Extraction
**Critical**: HistoryQueryEntry does NOT contain runId field.
**Solution**: Query RunStore.listRunsByTask(taskId) for sourceRefs. This requires adding RunStore as a third dependency.
**Alternative**: Accept only taskId in sourceRefs and skip runIds (simpler, per D-06 "Claude's discretion").

### workspaceDir Access
- Only in DiagnosticianTaskRecord, not base TaskRecord
- Requires type narrowing: check taskKind === 'diagnostician' before cast
- Cast is safe after check (TypeScript understands this pattern)

## Technical Notes

### Node.js Crypto
- `import { randomUUID, createHash } from 'node:crypto'`
- contextId: `randomUUID()` → UUIDv4
- contextHash: `createHash('sha256').update(JSON.stringify(entries)).digest('hex')`
- Empty array serializes to `"[]"` — valid SHA-256 input, no special handling needed

### Circular Dependencies
- None identified. ContextAssembler depends on TaskStore (M2) and HistoryQuery (m3-02)
- Output type DiagnosticianContextPayload is in context-payload.ts (no store dependencies)

### Type Safety for DiagnosticianTaskRecord Cast
```typescript
if (task.taskKind !== 'diagnostician') {
  throw new PDRuntimeError('input_invalid', 'task is not a diagnostician task');
}
const dt = task as DiagnosticianTaskRecord; // Safe after check
```

## Key Decision Point: RunStore Dependency

D-06 says sourceRefs = [taskId, ...runIds], but HistoryQueryEntry has no runId.
Two approaches:
1. **Add RunStore as third dependency** → can query listRunsByTask for runIds
2. **Omit runIds from sourceRefs** → sourceRefs = [taskId] only, simpler but less traceable

Recommendation: Add RunStore as dependency. It's a lightweight interface and listRunsByTask is already available.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `store/context-assembler.ts` | CREATE | Interface definition |
| `store/sqlite-context-assembler.ts` | CREATE | SQLite implementation |
| `store/sqlite-context-assembler.test.ts` | CREATE | Test suite |
| `index.ts` | MODIFY | Add exports |

## RESEARCH COMPLETE
