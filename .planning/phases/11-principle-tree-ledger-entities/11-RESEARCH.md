# Phase 11: Principle Tree Ledger Entities - Research

**Researched:** 2026-04-07 [VERIFIED: codebase grep]  
**Domain:** Principle-tree ledger persistence and migration inside `packages/openclaw-plugin` [VERIFIED: codebase grep]  
**Confidence:** HIGH [VERIFIED: codebase grep]

<user_constraints>
## User Constraints (from CONTEXT.md)

Source: [CITED: /D:/Code/principles/.planning/phases/11-principle-tree-ledger-entities/11-CONTEXT.md]

### Locked Decisions

#### Ledger authority and storage shape
- **D-01:** Phase 11 will treat the principle tree as the semantic source of truth and persist `Rule` and `Implementation` alongside `Principle`, rather than introducing a separate parallel ledger for code implementations.
- **D-02:** The first persistence target should extend the existing `.state/principle_training_state.json` / principle-tree store path already implied by [`packages/openclaw-plugin/src/core/principle-training-state.ts`](/D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts) and [`packages/openclaw-plugin/src/types/principle-tree-schema.ts`](/D:/Code/principles/packages/openclaw-plugin/src/types/principle-tree-schema.ts), instead of inventing a new top-level state file in this phase.
- **D-03:** `Rule` remains the semantic trunk and `Implementation` remains the leaf. This phase must not collapse them into a single script-oriented record.

#### Scope and migration constraints
- **D-04:** Phase 11 is ledger-only. It must not wire `Rule Host`, replay evaluation, promotion automation, or nocturnal code artifact flow. Those belong to later phases.
- **D-05:** Existing `EvolutionReducer` principle lifecycle behavior stays in place for this phase. The ledger work should integrate without forcing a broad refactor of candidate/probation/active principle flows.
- **D-06:** Migration must preserve existing principle training state and avoid breaking any code that already reads `.state/principle_training_state.json`.

#### Service boundaries
- **D-07:** Ledger CRUD should follow the repo's existing service/store pattern: small core persistence module plus access through workspace-scoped services rather than ad hoc file writes from hooks.
- **D-08:** `WorkspaceContext` should become the main integration point for future principle-tree ledger access, because it already centralizes workspace-specific services and path resolution.
- **D-09:** File writes for the ledger must continue to use the project's existing lock discipline (`withLock` / `withLockAsync`) to avoid corrupting shared state.

#### Data model expectations
- **D-10:** A single `Principle` may reference multiple `Rule` records, and a single `Rule` may reference multiple `Implementation` records. This multiplicity is a hard requirement in Phase 11, not a later enhancement.
- **D-11:** `Implementation(type=code)` is only one implementation form. Phase 11 must keep the schema open for `skill`, `prompt`, `lora`, and `test` implementations even if only code-oriented work is planned later.
- **D-12:** The existing schema fields in `principle-tree-schema.ts` are the starting contract, but planner/researcher may refine storage shape if needed so long as the Principle/Rule/Implementation hierarchy remains explicit and queryable.

### Claude's Discretion
- Exact repository/module naming for the ledger store layer
- Whether CRUD is exposed as one service or split into focused repositories
- Whether migration is implemented as in-place upgrade or read-with-defaults plus write-back

### Deferred Ideas (OUT OF SCOPE)
- Runtime `Rule Host` integration - Phase 12
- Versioned code implementation asset layout and manifests - Phase 12
- Replay evaluation and manual promotion loop - Phase 13
- Nocturnal `RuleImplementationArtifact` generation - Phase 14
- Coverage, adherence, and internalization routing - Phase 15
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TREE-01 | system can persist `Rule` entities as first-class principle-tree records rather than document-only concepts [CITED: /D:/Code/principles/.planning/REQUIREMENTS.md] | Backward-compatible `_tree.rules` ledger inside `principle_training_state.json`, plus locked CRUD service and migration adapter [VERIFIED: codebase grep] |
| TREE-02 | system can persist `Implementation` entities as first-class principle-tree leaves linked to a parent `Rule` [CITED: /D:/Code/principles/.planning/REQUIREMENTS.md] | Backward-compatible `_tree.implementations` ledger with `ruleId` linkage and multiplicity-preserving arrays on parent records [CITED: /D:/Code/principles/packages/openclaw-plugin/src/types/principle-tree-schema.ts] |
| TREE-03 | system can query `Principle -> Rule -> Implementation` relationships for any active principle [CITED: /D:/Code/principles/.planning/REQUIREMENTS.md] | Query helpers should join `evolutionReducer.getActivePrinciples()` with ledger reads exposed through `WorkspaceContext` [VERIFIED: codebase grep] |
| TREE-04 | one Rule can reference multiple Implementations without collapsing semantic and runtime layers [CITED: /D:/Code/principles/.planning/REQUIREMENTS.md] | Use explicit `ruleIds` on principle records and `implementationIds` on rule records; do not treat code path as the rule itself [CITED: /D:/Code/principles/docs/design/2026-04-07-principle-internalization-system.md] |
</phase_requirements>

## Summary

The repo already has the three pieces Phase 11 needs: a schema that models `Principle`, `Rule`, `Implementation`, and `PrincipleTreeStore`; a hardened JSON persistence module for `principle_training_state.json`; and a workspace-scoped service pattern through `WorkspaceContext`. The main gap is that only principle-training records are persisted today, while `Rule` and `Implementation` exist only as schema or advisory `suggestedRules` metadata on reducer principles. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/types/principle-tree-schema.ts] [VERIFIED: codebase grep]

The safest Phase 11 shape is to keep using `.state/principle_training_state.json` but extend it compatibly, not replace it. Existing code still assumes the file is a top-level `Record<string, PrincipleTrainingState>` and one hook mutates it directly by raw filename, so a wrapped envelope would create avoidable breakage. A reserved top-level ledger namespace such as `_tree` lets Phase 11 add first-class `rules` and `implementations` while preserving current principle-training reads. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts] [CITED: /D:/Code/principles/packages/openclaw-plugin/src/hooks/pain.ts] [VERIFIED: codebase grep]

**Primary recommendation:** Implement a new workspace-scoped ledger module that reads and writes a hybrid `principle_training_state.json` shape, then refactor `principle-training-state.ts` and the one raw hook writer to use that module before adding any Rule Host, replay, or nocturnal artifact work. [VERIFIED: codebase grep]

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node `fs` / `path` | built-in | JSON persistence for `.state` files [VERIFIED: codebase grep] | Existing state modules already use synchronous and async JSON IO; no new storage dependency is needed for Phase 11 [VERIFIED: codebase grep] |
| `withLock` / `withLockAsync` | project-local | Protect read-modify-write cycles [VERIFIED: codebase grep] | `principle-training-state.ts`, `evolution-reducer.ts`, and other stateful modules already rely on the same lock discipline [VERIFIED: codebase grep] |
| `WorkspaceContext` | project-local | Workspace-scoped service access [VERIFIED: codebase grep] | The repo centralizes per-workspace singletons here already, including config, event log, dictionary, evolution reducer, and trajectory [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/workspace-context.ts] |
| TypeScript | 6.0.2, published 2026-03-23 [VERIFIED: npm registry] | Strict typing and migration-safe store types [CITED: /D:/Code/principles/packages/openclaw-plugin/package.json] | Already pinned in the workspace and appropriate for Phase 11 store typing [VERIFIED: npm registry] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Vitest | 4.1.2, published 2026-03-26 [VERIFIED: npm registry] | Unit tests for migration, CRUD, and workspace getters [CITED: /D:/Code/principles/packages/openclaw-plugin/package.json] | Use for all Phase 11 verification since the plugin package already runs `vitest run` [CITED: /D:/Code/principles/packages/openclaw-plugin/package.json] |
| `@sinclair/typebox` | 0.34.49, published 2026-03-28 [VERIFIED: npm registry] | Optional future schema validation [CITED: /D:/Code/principles/packages/openclaw-plugin/package.json] | Do not introduce it unless planner explicitly wants runtime validation; Phase 11 can stay with migration-default guards only [VERIFIED: codebase grep] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hybrid `principle_training_state.json` file | New separate ledger JSON file | Violates D-02 and forces more cross-file migration now without reducing Phase 11 risk [CITED: /D:/Code/principles/.planning/phases/11-principle-tree-ledger-entities/11-CONTEXT.md] |
| Hybrid `principle_training_state.json` file | SQLite ledger table | The repo already uses SQLite for trajectory analytics, but Phase 11 requirements target the current principle-training store path and not a new persistence substrate [CITED: /D:/Code/principles/.planning/phases/11-principle-tree-ledger-entities/11-CONTEXT.md] [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/trajectory.ts] |

**Installation:** No new package installation is recommended for Phase 11. [VERIFIED: codebase grep]

**Version verification:** `typescript@6.0.2` is current as of 2026-04-07, `vitest@4.1.2` is newer than the package.json range baseline, and `@sinclair/typebox@0.34.49` is newer than the repo's pinned `^0.34.48`; Phase 11 does not require upgrading any of them because no new dependency is needed. [VERIFIED: npm registry]

## Architecture Patterns

### Recommended Project Structure
```text
packages/openclaw-plugin/src/
├── core/
│   ├── principle-tree-ledger.ts         # New locked file store + migration helpers
│   ├── principle-tree-ledger-service.ts # Optional singleton wrapper by stateDir
│   ├── principle-training-state.ts      # Compatibility adapter for per-principle training state
│   ├── workspace-context.ts             # New getter for ledger access
│   └── paths.ts                         # Optional file-key constant for principle_training_state.json
└── tests/core/
    ├── principle-tree-ledger.test.ts
    ├── principle-training-state.test.ts
    └── workspace-context.test.ts
```
[VERIFIED: codebase grep]

### Pattern 1: Hybrid File Shape for Backward Compatibility
**What:** Keep current top-level principle-training entries untouched and add a reserved ledger namespace, for example `_tree`, that contains `principles`, `rules`, `implementations`, `metrics`, and `lastUpdated`. Existing per-principle helpers continue to operate on top-level entries, while new ledger helpers read and write `_tree`. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts] [CITED: /D:/Code/principles/packages/openclaw-plugin/src/types/principle-tree-schema.ts]

**When to use:** Use this for Phase 11 because the file path is locked, the old top-level shape is already consumed, and the phase explicitly forbids broad runtime refactors. [CITED: /D:/Code/principles/.planning/phases/11-principle-tree-ledger-entities/11-CONTEXT.md]

**Example:**
```typescript
// Source: repo-adapted from principle-training-state.ts + principle-tree-schema.ts
interface PrincipleTrainingLedgerFile {
  _schemaVersion?: 2;
  _tree?: PrincipleTreeStore;
  [principleId: string]: PrincipleTrainingState | PrincipleTreeStore | number | undefined;
}
```
[CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts] [CITED: /D:/Code/principles/packages/openclaw-plugin/src/types/principle-tree-schema.ts]

### Pattern 2: Locked Read-Modify-Write in One Owner Module
**What:** Follow the existing `principle-training-state.ts` pattern: acquire the file lock, load the current file contents inside the lock, mutate one in-memory object, then write once. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts]

**When to use:** Use this for all Rule and Implementation CRUD so hooks and workers never append ad hoc JSON mutations. [VERIFIED: codebase grep]

**Example:**
```typescript
// Source: repo-adapted from principle-training-state.ts
withLock(filePath, () => {
  const file = loadLedgerFileUnlocked(filePath);
  file._tree ??= createEmptyPrincipleTreeStore();
  file._tree.rules[rule.id] = rule;
  file._tree.principles[rule.principleId].ruleIds.push(rule.id);
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
});
```
[CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts]

### Pattern 3: WorkspaceContext Getter, Not Hook-Level File Access
**What:** Expose the ledger through `WorkspaceContext` the same way the repo already exposes config, event log, dictionary, evolution reducer, and trajectory. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/workspace-context.ts]

**When to use:** Use this for any Phase 11 integration point that needs ledger reads, including future query helpers and the existing value-metrics write path in `hooks/pain.ts`. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/hooks/pain.ts]

**Example:**
```typescript
// Source: repo-adapted from workspace-context.ts
get principleTreeLedger(): PrincipleTreeLedger {
  if (!this._principleTreeLedger) {
    this._principleTreeLedger = PrincipleTreeLedgerService.get(this.stateDir);
  }
  return this._principleTreeLedger;
}
```
[CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/workspace-context.ts]

### Anti-Patterns to Avoid
- **Wrapped-envelope migration in Phase 11:** Replacing the file with `{ principleStates, tree }` breaks the current top-level contract and forces more downstream edits than the phase boundary warrants. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts] [CITED: /D:/Code/principles/packages/openclaw-plugin/src/hooks/pain.ts]
- **Direct hook writes:** `hooks/pain.ts` currently rewrites the JSON file without a lock when storing `valueMetrics`; Phase 11 should remove that pattern, not duplicate it. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/hooks/pain.ts]
- **Auto-creating runtime code artifacts:** Rule Host, asset manifests, replay reports, and nocturnal code candidates are explicitly later-phase work. [CITED: /D:/Code/principles/.planning/ROADMAP.md] [CITED: /D:/Code/principles/docs/design/2026-04-07-principle-internalization-roadmap.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Concurrent file update safety | Ad hoc `readFileSync` / `writeFileSync` sequences in hooks | Existing `withLock` / `withLockAsync` helpers [VERIFIED: codebase grep] | The repo already standardized on these helpers for state integrity [VERIFIED: codebase grep] |
| Workspace-scoped singleton access | Per-hook caches or global module state | `WorkspaceContext` and service `get(stateDir)` factories [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/workspace-context.ts] | This matches project conventions and keeps tests simple [CITED: /D:/Code/principles/AGENTS.md] |
| Separate SQLite or asset-storage layer in Phase 11 | New registry tables or `.principles/implementations/*` layout | Ledger metadata only in the existing JSON store [CITED: /D:/Code/principles/.planning/phases/11-principle-tree-ledger-entities/11-CONTEXT.md] | File-asset storage belongs to Phase 12 `IMPL-01/02`, not TREE work [CITED: /D:/Code/principles/.planning/REQUIREMENTS.md] |
| Runtime rule execution path | Mini Rule Host or helper whitelist now | Pure CRUD and query surface only [CITED: /D:/Code/principles/docs/design/2026-04-07-principle-internalization-roadmap.md] | Pulling runtime behavior into Phase 11 mixes M1 with M3/M4 and expands regression risk [CITED: /D:/Code/principles/docs/design/2026-04-07-principle-internalization-roadmap.md] |

**Key insight:** The repo already has a persistence pattern and a service pattern; Phase 11 should compose them, not invent a new architectural center of gravity. [VERIFIED: codebase grep]

## Runtime State Inventory

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `.state/principle_training_state.json` already stores top-level `PrincipleTrainingState` records keyed by principle ID; `hooks/pain.ts` also mutates this file directly for `valueMetrics` updates [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts] [CITED: /D:/Code/principles/packages/openclaw-plugin/src/hooks/pain.ts] | Code edit plus in-place data migration on next write or read-with-write-back so `_tree` can coexist without losing existing entries [VERIFIED: codebase grep] |
| Live service config | None found in UI-only or external-service configuration for Phase 11 ledger entities [VERIFIED: codebase grep] | None [VERIFIED: codebase grep] |
| OS-registered state | None found; the phase does not rely on OS task registrations or service names for the ledger file [VERIFIED: codebase grep] | None [VERIFIED: codebase grep] |
| Secrets/env vars | None found for principle-tree ledger naming or storage [VERIFIED: codebase grep] | None [VERIFIED: codebase grep] |
| Build artifacts | None found that cache principle-tree entity names; the package builds from source and does not install a separate ledger artifact [VERIFIED: codebase grep] | None [VERIFIED: codebase grep] |

## Common Pitfalls

### Pitfall 1: Breaking the Existing File Contract
**What goes wrong:** Planner wraps the store in a new envelope and silently breaks top-level readers. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts]  
**Why it happens:** The schema file suggests a full `PrincipleTreeStore`, but the current persistence file is still keyed directly by `principleId`. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/types/principle-tree-schema.ts] [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts]  
**How to avoid:** Keep top-level principle-training entries and add the tree in a reserved namespace. [VERIFIED: codebase grep]  
**Warning signs:** `listEvaluablePrinciples()` returns empty after migration or `hooks/pain.ts` stops finding `store[id]`. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/service/nocturnal-target-selector.ts] [CITED: /D:/Code/principles/packages/openclaw-plugin/src/hooks/pain.ts]

### Pitfall 2: Letting Hooks Keep Raw JSON Ownership
**What goes wrong:** Multiple modules write the same file with different assumptions and lose `_tree` or metrics updates. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/hooks/pain.ts]  
**Why it happens:** One hook currently bypasses the locking and helper layer. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/hooks/pain.ts]  
**How to avoid:** Move all writes behind the new ledger owner module and make the hook call a helper instead. [VERIFIED: codebase grep]  
**Warning signs:** `_tree.lastUpdated` regresses, top-level metrics disappear, or concurrent writes produce partial files. [ASSUMED]

### Pitfall 3: Mixing Phase 12 Runtime Semantics into Phase 11 Records
**What goes wrong:** Planner starts encoding host contracts, active code-asset directories, or replay lifecycle states into the Phase 11 ledger. [CITED: /D:/Code/principles/.planning/ROADMAP.md]  
**Why it happens:** The design docs discuss M1-M4 together, and the `Implementation(type=code)` concept tempts early runtime wiring. [CITED: /D:/Code/principles/docs/design/2026-04-07-principle-internalization-roadmap.md]  
**How to avoid:** Keep Phase 11 fields semantic and relational only; runtime host, asset manifests, evaluation reports, and promotion states remain later concerns. [CITED: /D:/Code/principles/.planning/phases/11-principle-tree-ledger-entities/11-CONTEXT.md]  
**Warning signs:** Planner touches `hooks/gate.ts`, adds `rule-host.ts`, or introduces `.principles/implementations/code/*` storage in Phase 11. [CITED: /D:/Code/principles/docs/design/2026-04-07-principle-internalization-roadmap.md]

## Code Examples

Verified patterns from repo sources:

### Locked Update Helper
```typescript
// Source: packages/openclaw-plugin/src/core/principle-training-state.ts
withLock(filePath, () => {
  const store = loadStoreUnlocked(filePath);
  store[state.principleId] = state;
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
});
```
[CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts]

### Workspace-Scoped Service Access
```typescript
// Source: packages/openclaw-plugin/src/core/workspace-context.ts
get trajectory(): TrajectoryDatabase {
  if (!this._trajectory) {
    this._trajectory = TrajectoryRegistry.get(this.workspaceDir, this.getTrajectoryOptions());
  }
  return this._trajectory;
}
```
[CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/workspace-context.ts]

### Active-Principle Query Join for Phase 11
```typescript
// Source shape: evolution-reducer.ts + principle-tree-schema.ts
const active = wctx.evolutionReducer.getActivePrinciples();
return active.map((principle) => ledger.getPrincipleSubtree(principle.id));
```
[CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/evolution-reducer.ts] [CITED: /D:/Code/principles/packages/openclaw-plugin/src/types/principle-tree-schema.ts]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `suggestedRules` live as advisory metadata on reducer principles | Rules should become first-class persisted entities in Phase 11 [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/evolution-types.ts] | Planned in M1 / Phase 11 docs dated 2026-04-07 [CITED: /D:/Code/principles/docs/design/2026-04-07-principle-internalization-roadmap.md] | Planner should preserve `suggestedRules` as transitional input, not final storage authority [VERIFIED: codebase grep] |
| Principles are synced to `PRINCIPLES.md` for human-facing display | Structured consumers should read the ledger or `evolutionReducer` APIs first [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/evolution-reducer.ts] [CITED: /D:/Code/principles/docs/architecture-governance/PRINCIPLE-TREE-ARCHITECTURE.md] | Active already in codebase; Phase 11 extends it [VERIFIED: codebase grep] | Avoid designing Phase 11 around markdown parsing [VERIFIED: codebase grep] |

**Deprecated/outdated:**
- Treating `Rule` as only a doc concept is outdated for v1.9.0; M1 explicitly requires real storage and CRUD. [CITED: /D:/Code/principles/docs/design/2026-04-07-principle-internalization-roadmap.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | No out-of-repo consumer depends on the exact raw JSON shape of `principle_training_state.json` beyond the code found in this repo. [ASSUMED] | Summary / Common Pitfalls | A compatibility-preserving `_tree` migration could still break undocumented external tooling. |
| A2 | A reserved `_tree` namespace is acceptable and will not collide with future principle IDs. [ASSUMED] | Architecture Patterns | If the naming convention changes, the migration namespace would need revision before implementation. |

## Open Questions (RESOLVED)

1. **Should Phase 11 backfill `Rule` entities from existing `suggestedRules` automatically, or only provide CRUD plus migration scaffolding?**
What we know: `suggestedRules` already exist on reducer principles and are surfaced in the evolution worker for diagnostician context. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/evolution-types.ts] [CITED: /D:/Code/principles/packages/openclaw-plugin/src/service/evolution-worker.ts]
What's unclear: The docs do not require automatic conversion during Phase 11. [CITED: /D:/Code/principles/.planning/REQUIREMENTS.md]
Resolution: Phase 11 will not auto-backfill first-class `Rule` entities from existing `suggestedRules`. The phase is limited to ledger CRUD, migration compatibility, and queryability; any future backfill can happen as a deliberate follow-up once the ledger contract is stable. [VERIFIED: codebase grep]

2. **Should `PrincipleTreeStore.principles` duplicate the full reducer principle payload or store only ledger-specific relational fields?**
What we know: The schema file defines a richer principle shape than the reducer's current runtime shape, and the reducer remains authoritative for lifecycle state in Phase 11. [CITED: /D:/Code/principles/packages/openclaw-plugin/src/types/principle-tree-schema.ts] [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/evolution-types.ts]
What's unclear: The design docs do not prescribe whether the ledger should mirror or subset reducer principle fields in M1. [CITED: /D:/Code/principles/docs/design/2026-04-07-principle-internalization-roadmap.md]
Resolution: `_tree.principles` will store only the ledger-specific relational metadata needed for `Principle -> Rule -> Implementation` joins and queryability. `EvolutionReducer` remains the lifecycle authority in Phase 11, so the ledger must not duplicate or replace the full reducer payload. [VERIFIED: codebase grep]

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.0 in `package.json`, current registry release 4.1.2 [VERIFIED: npm registry] |
| Config file | none found [VERIFIED: codebase grep] |
| Quick run command | `cd packages/openclaw-plugin && npx vitest run tests/core/principle-training-state.test.ts tests/core/workspace-context.test.ts tests/hooks/pain.test.ts` [VERIFIED: codebase grep] |
| Full suite command | `cd packages/openclaw-plugin && npm test` [CITED: /D:/Code/principles/packages/openclaw-plugin/package.json] |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TREE-01 | Persist Rule entities in ledger | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/principle-tree-ledger.test.ts -t "persists rule"` | ❌ Wave 0 |
| TREE-02 | Persist Implementation entities linked to Rule | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/principle-tree-ledger.test.ts -t "persists implementation"` | ❌ Wave 0 |
| TREE-03 | Query active principle subtree | unit/integration | `cd packages/openclaw-plugin && npx vitest run tests/core/principle-tree-ledger.test.ts tests/core/workspace-context.test.ts -t "active principle subtree"` | ❌ Wave 0 |
| TREE-04 | One Rule links to multiple Implementations | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/principle-tree-ledger.test.ts -t "multiple implementations"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cd packages/openclaw-plugin && npx vitest run tests/core/principle-tree-ledger.test.ts tests/core/principle-training-state.test.ts`
- **Per wave merge:** `cd packages/openclaw-plugin && npm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/openclaw-plugin/tests/core/principle-tree-ledger.test.ts` — new CRUD and migration coverage for TREE-01/02/03/04 [VERIFIED: codebase grep]
- [ ] `packages/openclaw-plugin/tests/core/principle-training-state.test.ts` — add hybrid-file migration cases and compatibility assertions [CITED: /D:/Code/principles/packages/openclaw-plugin/tests/core/principle-training-state.test.ts]
- [ ] `packages/openclaw-plugin/tests/core/workspace-context.test.ts` — add getter caching test for the new ledger service [CITED: /D:/Code/principles/packages/openclaw-plugin/tests/core/workspace-context.test.ts]
- [ ] `packages/openclaw-plugin/tests/hooks/pain.test.ts` — cover removal of raw unlocked JSON writes [CITED: /D:/Code/principles/packages/openclaw-plugin/src/hooks/pain.ts]

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no [VERIFIED: codebase grep] | Not part of Phase 11 [VERIFIED: codebase grep] |
| V3 Session Management | no [VERIFIED: codebase grep] | Not part of Phase 11 [VERIFIED: codebase grep] |
| V4 Access Control | yes [VERIFIED: codebase grep] | Keep workspace-scoped access through `WorkspaceContext`; do not wire runtime code execution here [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/workspace-context.ts] |
| V5 Input Validation | yes [VERIFIED: codebase grep] | Use migration-default guards and typed CRUD validation before writing ledger records [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts] |
| V6 Cryptography | no [VERIFIED: codebase grep] | Not part of Phase 11 [VERIFIED: codebase grep] |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Concurrent JSON write corruption | Tampering | Single-owner locked read-modify-write via `withLock` / `withLockAsync` [VERIFIED: codebase grep] |
| Silent schema drift after migration | Tampering | Apply migration defaults and compatibility tests on every load path [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts] |
| Unintended runtime code execution hidden in Phase 11 | Elevation of Privilege | Keep Rule Host and code-asset loading out of this phase [CITED: /D:/Code/principles/.planning/phases/11-principle-tree-ledger-entities/11-CONTEXT.md] |
| Unsafe direct path usage | Tampering | Route file access through `resolvePdPath` / `WorkspaceContext.resolve()` where possible [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/paths.ts] [CITED: /D:/Code/principles/packages/openclaw-plugin/src/core/workspace-context.ts] |

## Sources

### Primary (HIGH confidence)
- [packages/openclaw-plugin/src/core/principle-training-state.ts](/D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts) - current store shape, migration defaults, and lock pattern
- [packages/openclaw-plugin/src/types/principle-tree-schema.ts](/D:/Code/principles/packages/openclaw-plugin/src/types/principle-tree-schema.ts) - target Principle/Rule/Implementation schema
- [packages/openclaw-plugin/src/core/workspace-context.ts](/D:/Code/principles/packages/openclaw-plugin/src/core/workspace-context.ts) - workspace service pattern
- [packages/openclaw-plugin/src/hooks/pain.ts](/D:/Code/principles/packages/openclaw-plugin/src/hooks/pain.ts) - existing raw file write compatibility constraint
- [packages/openclaw-plugin/src/service/nocturnal-target-selector.ts](/D:/Code/principles/packages/openclaw-plugin/src/service/nocturnal-target-selector.ts) - existing `listEvaluablePrinciples` dependency
- [docs/design/2026-04-07-principle-internalization-roadmap.md](/D:/Code/principles/docs/design/2026-04-07-principle-internalization-roadmap.md) - M1/Phase 11 and later-phase boundaries
- [docs/design/2026-04-07-principle-internalization-system.md](/D:/Code/principles/docs/design/2026-04-07-principle-internalization-system.md) - Rule vs Implementation semantics and Rule Host separation
- [AGENTS.md](/D:/Code/principles/AGENTS.md) - project conventions and anti-patterns

### Secondary (MEDIUM confidence)
- [packages/openclaw-plugin/package.json](/D:/Code/principles/packages/openclaw-plugin/package.json) - package-local test/build stack
- npm registry - `typescript`, `vitest`, `@sinclair/typebox`, `better-sqlite3` current versions checked on 2026-04-07

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Phase 11 can stay on existing repo patterns and current package versions were verified against the registry. [VERIFIED: npm registry]
- Architecture: HIGH - The recommendation comes directly from current persistence code, `WorkspaceContext`, and the Phase 11 boundary docs. [VERIFIED: codebase grep]
- Pitfalls: MEDIUM - The breakage modes are strongly suggested by current call sites, but undocumented external consumers may still exist. [ASSUMED]

**Research date:** 2026-04-07 [VERIFIED: codebase grep]  
**Valid until:** 2026-05-07 for repo-internal patterns; re-check before planning if Phase 11 scope changes toward runtime host or storage assets. [VERIFIED: codebase grep]
