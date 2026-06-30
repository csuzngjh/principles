# ADR-0017: Principle Ledger Single Implementation (core/plugin convergence)

> **Status**: Accepted
> **Date**: 2026-06-25
> **Drives**: PRI-459 (follows PRI-413 / PRI-443)
> **Context**: MVP-First (ADR-0014), seed-customer readiness

## 1. Context

`principle_training_state.json` is the on-disk ledger for owner-internalized
principles — the canonical state file read by all three MVP activation paths
(`prompt`, `defer_archive`, `code_tool_hook` / RuleHost) per ADR-0014. It stores
a hybrid shape: top-level legacy training records plus a `_tree` subtree
(principles → rules → implementations + metrics).

Until PRI-459 this single state file had **two full implementations**:

- `packages/principles-core/src/principle-tree-ledger.ts` — used by pd-cli and
  pd-console. **Unlocked.** No lock acquired on read-modify-write.
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` — used by the
  evolution reducer, commands, replay engine, workspace context. **Locked**
  via a file lock. Also carried a full inlined parser/serializer/mutator.

Each copy had its own codec (different parse strictness) and the two writers
did not share a lock. This produced two real, recurring failure classes:

1. **Lost updates.** Core wrote unlocked; the plugin wrote with a lock, but
   core's writer never acquired that lock. A concurrent evolution-worker write
   (async, locked) and a pd-cli write (unlocked) on the same `.pd/` could
   silently drop edits. Atomic rename only prevents torn files — it does not
   prevent lost updates.
2. **Silent field loss.** The two codecs parsed the same bytes at different
   strictness. A field one side persisted could be dropped on the next load by
   the other (e.g. consumer-written `compilationRetryCount` survived at runtime
   only because of a `{...value}` spread, never as a typed member).

PRI-413 and PRI-443 reduced type/codec drift but left the duplicate mutator
ownership in place. PRI-459 closes the last gap.

## 2. Decision

The principle ledger has a **single source of truth** for parsing,
serialization, and mutation:

| Concern | Sole owner |
|---|---|
| Parse / serialize | `packages/principles-core/src/runtime-v2/principle-tree/ledger-codec.ts` (PRI-443) |
| Mutation (read-modify-write) | `packages/principles-core/src/principle-tree-ledger.ts` |
| Types | `packages/principles-core/src/runtime-v2/types/ledger-store.ts` |

The openclaw-plugin ledger file is a **thin re-export adapter** — it declares
no parser, serializer, mutator, or type. It exists only so existing relative
imports (`from './principle-tree-ledger.js'`) keep resolving.

### 2.1 The file lock is owned by core

The cross-process file lock (O_EXCL | O_CREAT with PID liveness + stale
reclamation) is hoisted into `principle-tree-ledger.ts`. **Every** mutation —
synchronous and asynchronous — acquires `<ledger>.lock`. This is what actually
eliminates the lost-update class: there is no longer a writer that bypasses the
lock.

### 2.2 Type alignment with the rich schema

The ledger `Principle` re-exports the rich `principle-schema.ts` `Principle`,
because consumers read rich-only fields (e.g. `compilationRetryCount`) that the
old narrow ledger copy silently lacked at the type level. `Rule` /
`Implementation` carry the rich fields consumers write as **optional** members
(a candidate created at intake only has `id`/`ruleId`/`lifecycleState`, so the
rich required-field shape does not apply to the file store).

`PrincipleValueMetrics` stays intentionally **partial** in the ledger: a
principle may have no metrics recorded yet, and the codec builds partial
objects. Aligning it with the required-field rich version would break
`parseMetrics`. This is a deliberate exception, documented in
`ledger-store.ts`.

### 2.3 No behavior change, no schema migration

On-disk schema is unchanged. No feature flag is introduced (rollback = PR
revert). Consumers' observable behavior is preserved — verified by the full
plugin suite (1914 tests) and core suite remaining green.

## 3. Enforcement

The convergence is enforced by an architecture-regression-style guard
(`tests/ledger-schema-diff.test.ts`) that asserts the plugin ledger file:

- does **not** define any ledger interface (`HybridLedgerStore`,
  `LedgerPrinciple`, `PrincipleSubtree`, …) or codec function
  (`parseHybridLedger`, `serializeLedger`, …) or mutator (`mutateLedger`);
- **does** re-export from `@principles/core/principle-tree-ledger`.

Re-introducing duplicate parsing/serialization/mutation logic in the plugin
re-opens the dual-implementation drift and fails this guard.

## 4. Consequences

- One place to fix a ledger bug; one codec to evolve.
- No lost updates between pd-cli / pd-console / evolution-worker writers.
- Extra ledger fields survive a save→load cycle with an explicit round-trip
  test (EP-09 / ERR-025) rather than by accident.
- Plugin consumers that previously relied on plugin-local rich types now use
  ledger types where they read ledger data (one-time type-debt cleanup).

## 5. Alternatives considered

- **Keep lock in plugin adapter.** Rejected: pd-cli/pd-console write through
  core unlocked, so cross-process lost updates would persist. Does not actually
  solve the problem.
- **All-unlock, document single-process.** Rejected: abandons cross-process
  safety for the evolution-worker + CLI coexistence case.
- **Re-export rich Principle in adapter only (don't align core).** Rejected:
  the adapter would no longer be a pure re-export, weakening the single-
  implementation guard.

## 6. References

- PRI-413 — ledger schema SSOT guard (field parity era)
- PRI-443 — extract pure codec + types from core ledger
- PRI-459 — this convergence (file lock into core, plugin → re-export adapter)
- ADR-0014 — MVP-First strategy; ledger is MVP-Core state
- `docs/process/error-management/ERROR_PATTERN_INDEX.md` EP-07 (single state source), EP-09 / ERR-025
  (round-trip field preservation), EP-10 (do not re-open merged convergence)
