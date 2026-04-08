# Phase 12: Runtime Rule Host and Code Implementation Storage - Research

**Researched:** 2026-04-07
**Domain:** Constrained runtime execution for `Implementation(type=code)` plus versioned implementation asset storage
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
### Gate chain placement
- **D-01:** Keep the online gate order as `Thinking Checkpoint -> GFI -> Rule Host -> Progressive Gate -> Edit Verification`.
- **D-02:** `Progressive Gate` stays in place as a host hard-boundary layer for v1.9.0. Phase 12 must not delete or bypass it.
- **D-03:** `Rule Host` is inserted after GFI and before Progressive Gate so principle-constrained code can act before the capability-boundary fallback.

### Host execution contract
- **D-04:** `Rule Host` runs only `Implementation(type=code)` assets that are already active in the principle tree / implementation registry.
- **D-05:** Code implementations execute through a fixed host contract and helper whitelist, not arbitrary workspace IO.
- **D-06:** A code implementation exports a fixed interface (`meta + evaluate(input)` or equivalent host-owned contract), not arbitrary plugin hooks.
- **D-07:** Host decisions are limited to `allow`, `block`, or `requireApproval`, optionally with structured diagnostics.
- **D-08:** Host failure must degrade conservatively and must not disable existing hard-boundary gates.

### Storage shape
- **D-09:** `Implementation(type=code)` persists as a versioned asset with manifest, entry file, replay sample references, and latest evaluation report metadata, but this phase only needs storage and loading primitives - not replay execution.
- **D-10:** Code implementation lifecycle states must at least support `candidate`, `active`, `disabled`, and `archived`.
- **D-11:** Principle Tree remains the semantic source of truth; file-system asset storage is subordinate to Principle -> Rule -> Implementation relationships.

### Scope guards
- **D-12:** Phase 12 must not implement replay evaluation or manual promotion logic. Those belong to Phase 13.
- **D-13:** Phase 12 must not implement nocturnal `RuleImplementationArtifact` generation. That belongs to Phase 14.
- **D-14:** Phase 12 must not broaden into skill/LoRA routing logic. This milestone branch is code implementation only.

### Helper whitelist
- **D-15:** First-pass helpers remain minimal: tool/path checks, risk-path checks, plan/file existence checks, estimated line changes, current GFI/EP tier, and bash risk helpers.
- **D-16:** No implementation gets direct file reads, directory walking, network access, dynamic import, `eval`, `Function`, or subprocess execution.

### Claude's Discretion
- Exact module/file naming for Rule Host internals
- Whether host loading and registry logic live in one module or a small set of focused modules
- Whether implementation storage is anchored under `.principles/implementations/code/` or an equivalent state-owned directory, as long as Principle Tree remains authoritative

### Deferred Ideas (OUT OF SCOPE)
- Replay evaluation and manual promotion loop - Phase 13
- Nocturnal `RuleImplementationArtifact` generation - Phase 14
- Coverage, false-positive, adherence, and deprecation accounting - Phase 15
- Multi-form routing between skill / code / LoRA - later milestone
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| HOST-01 | runtime gate chain executes a `Rule Host` between `GFI Gate` and `Progressive Gate` | Insert a single host adapter call in `gate.ts` after GFI has passed and after path normalization/risk derivation, but before `checkProgressiveTrustGate()` [VERIFIED: codebase grep] |
| HOST-02 | active code implementations execute through a fixed host contract and helper whitelist instead of arbitrary workspace access | Use a host-owned `RuleHostInput` snapshot plus pure helper whitelist; do not expose `WorkspaceContext`, `fs`, module loading, subprocesses, or network [VERIFIED: codebase grep] [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html] |
| HOST-03 | a code implementation can return `allow`, `block`, or `requireApproval` plus structured diagnostics | Define a host-internal decision union and adapt it to the current hook result surface, which today only has block/allow semantics at the gate boundary [VERIFIED: codebase grep] |
| HOST-04 | host failure degrades conservatively without disabling existing hard-boundary gates | Fail closed in the host adapter and keep `Progressive Gate` and `Edit Verification` in the chain; do not let host load/eval exceptions bypass them [VERIFIED: codebase grep] [VERIFIED: codebase grep] |
| IMPL-01 | `Implementation(type=code)` is stored as a versioned asset with manifest, entry file, replay samples, and latest evaluation report | Keep ledger as semantic source of truth and store subordinate asset files under one implementation root with manifest + versioned entry/eval/sample refs [VERIFIED: codebase grep] [CITED: docs/design/2026-04-07-principle-internalization-system-technical-appendix.md] [ASSUMED] |
| IMPL-02 | code implementations support lifecycle states `candidate`, `active`, `disabled`, and `archived` | Add lifecycle state to the canonical implementation metadata path, not just the filesystem manifest, because the current `Implementation` schema cannot represent it yet [VERIFIED: codebase grep] |
</phase_requirements>

## Summary

Phase 12 should be planned as two tightly scoped deliverables: a host adapter inserted into the existing `before_tool_call` orchestration path, and a ledger-backed asset store for active code implementations. The current codebase already has the right seams for this: `gate.ts` is the single authoritative orchestration path, `WorkspaceContext` is the workspace-scoped dependency hub, and the Phase 11 ledger already exposes active `Principle -> Rule -> Implementation` subtrees for runtime lookup [VERIFIED: codebase grep]. The safest insertion point is not “somewhere after GFI” in the abstract; it is concretely after `checkGfiGate()` succeeds and after `gate.ts` derives `relPath` and `risky`, but before `checkProgressiveTrustGate()` runs, so the host sees normalized input while `Progressive Gate` remains the hard-boundary fallback [VERIFIED: codebase grep].

The main planning risk is treating this as a sandboxing or promotion phase. Node’s `node:vm` API can help enforce a constrained execution contract, but the official docs explicitly say it is not a security mechanism and should not be used for untrusted code [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html]. That matters here because Phase 12 is only safe if it runs already-active implementations from the ledger, keeps the helper surface minimal, and refuses to drift into replay, promotion, nocturnal artifact generation, or coverage accounting, which the phase context explicitly defers to later phases [VERIFIED: codebase grep].

The storage half should stay ledger-first. Today the canonical `Implementation` schema only has `id`, `ruleId`, `type`, `path`, `version`, `coversCondition`, `coveragePercentage`, `createdAt`, and `updatedAt`, so Phase 12 cannot satisfy `IMPL-02` without extending canonical metadata to represent lifecycle state or an equivalent authoritative status field [VERIFIED: codebase grep]. The filesystem should hold code assets, manifests, and refs to later replay/evaluation files, but the planner should avoid implementing replay semantics now; Phase 12 only needs the storage layout and loading primitives that later phases will consume [VERIFIED: codebase grep].

**Primary recommendation:** Build a small `rule-host` subsystem under `src/core/`, invoke it once from `gate.ts` between GFI and Progressive Gate, keep canonical implementation status in the ledger, and store mutable code assets in a single subordinate versioned directory tree without adding replay or promotion behavior yet [VERIFIED: codebase grep] [ASSUMED].

## Project Constraints

- No `CLAUDE.md` exists at repo root, so there are no additional CLAUDE-specific directives to honor for this phase [VERIFIED: codebase grep].
- TypeScript strict mode and ESM module conventions are project defaults and should be preserved for any new host/storage modules [VERIFIED: codebase grep].
- Vitest is the project test framework; planner tasks should target Vitest test files, not Jest [VERIFIED: codebase grep].
- `WorkspaceContext` is the existing singleton/facade pattern for workspace-scoped services; new runtime services should follow that pattern instead of wiring state directly inside hooks [VERIFIED: codebase grep].
- File path logic should extend the existing PD path constants/resolvers rather than hardcoding absolute paths or ad hoc joins [VERIFIED: codebase grep].
- Critical state writes already rely on file-lock helpers in the ledger layer; storage tasks should preserve that pattern for any canonical metadata mutations [VERIFIED: codebase grep].
- The milestone state explicitly says “No new dependencies” for this work, so Phase 12 should prefer built-in Node/runtime facilities plus existing repo modules over third-party sandbox packages [VERIFIED: codebase grep].

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:vm` | bundled with Node `v24.14.0` on this machine [VERIFIED: local node --version] | Constrained compilation/execution of fixed-contract implementation code via host-owned contexts and functions [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html] | Already present, no new dependency, supports `vm.createContext()` and `vm.compileFunction()`, lets the host disable string code generation, and lets the host avoid dynamic import callbacks entirely [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html] |
| `WorkspaceContext` | repo-local service [VERIFIED: codebase grep] | Workspace-scoped access to config, trajectory, event log, and principle-tree ledger [VERIFIED: codebase grep] | Matches the project’s singleton service pattern and is already the natural boundary for new runtime services [VERIFIED: codebase grep] |
| `principle-tree-ledger.ts` | repo-local service [VERIFIED: codebase grep] | Canonical `Principle -> Rule -> Implementation` lookup and mutation path [VERIFIED: codebase grep] | Phase 11 already made it the semantic source of truth, so Phase 12 should read active implementations from here instead of inventing a parallel registry [VERIFIED: codebase grep] |
| `gate-block-helper.ts` | repo-local helper [VERIFIED: codebase grep] | Single authoritative gate-block persistence path [VERIFIED: codebase grep] | Host-originated blocks should reuse the same tracking/event/trajectory path to avoid duplicate persistence semantics [VERIFIED: codebase grep] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | installed `4.1.0`; npm registry current `4.1.2` modified `2026-03-26` [VERIFIED: npm ls] [VERIFIED: npm registry] | Unit and integration verification for gate order, host behavior, storage layout, and WorkspaceContext integration [VERIFIED: codebase grep] | Use for all new host/storage tests; existing hook and ledger test patterns are already in Vitest [VERIFIED: codebase grep] |
| `typescript` | installed `5.9.3`; package.json expects `^6.0.2`; npm registry current `6.0.2` modified `2026-04-01` [VERIFIED: npm ls] [VERIFIED: npm registry] | Strict typing for host contracts, manifests, and ledger schema changes [VERIFIED: codebase grep] | Use for all new types; note the local install mismatch is an environment risk until dependencies are refreshed [VERIFIED: npm ls] |
| `esbuild` | installed `0.27.4`; npm registry current `0.28.0` modified `2026-04-02` [VERIFIED: npm ls] [VERIFIED: npm registry] | Existing production build pipeline only [VERIFIED: codebase grep] | Keep Phase 12 compatible with the current bundle pipeline; do not add a separate runtime transpilation step for hosted implementation assets [VERIFIED: codebase grep] [ASSUMED] |
| `better-sqlite3` | installed and registry current `12.8.0` modified `2026-03-14` [VERIFIED: npm ls] [VERIFIED: npm registry] | Existing trajectory/event subsystems only [VERIFIED: codebase grep] | Reuse current trajectory/event telemetry if host execution needs audit logging; do not add new persistence engines [VERIFIED: codebase grep] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `node:vm` host-owned wrapper [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html] | Third-party sandbox package [ASSUMED] | Adds a new dependency despite milestone constraints, and Phase 12 only needs constrained active-implementation execution, not a full hostile-code isolation platform [VERIFIED: codebase grep] [ASSUMED] |
| Ledger-first implementation registry [VERIFIED: codebase grep] | Filesystem-only discovery by directory walk [ASSUMED] | Would violate the context decision that Principle Tree remains authoritative and would make lifecycle state/promotion history drift from semantic truth [VERIFIED: codebase grep] |
| Small focused host modules under `src/core/` [CITED: docs/design/2026-04-07-principle-internalization-system-technical-appendix.md] | Add host logic directly inside `gate.ts` [ASSUMED] | Would bloat the authoritative gate orchestrator and make later replay/promotion integration harder to reason about [VERIFIED: codebase grep] [ASSUMED] |

**Installation:**
```bash
cd packages/openclaw-plugin
npm install
```

**Version verification:** `vitest` current registry version is `4.1.2` modified `2026-03-26`; `typescript` current registry version is `6.0.2` modified `2026-04-01`; `esbuild` current registry version is `0.28.0` modified `2026-04-02`; `better-sqlite3` current registry version is `12.8.0` modified `2026-03-14` [VERIFIED: npm registry].

## Architecture Patterns

### Recommended Project Structure

```text
packages/openclaw-plugin/src/
├── core/
│   └── principle-internalization/
│       ├── rule-host.ts
│       ├── rule-host-types.ts
│       ├── rule-host-helpers.ts
│       ├── rule-implementation-registry.ts
│       ├── rule-implementation-loader.ts
│       └── rule-implementation-storage.ts
├── hooks/
│   └── gate.ts
└── types/
    └── principle-tree-schema.ts
```

This layout matches the design appendix’s recommended split and the repo’s existing pattern of thin hooks plus focused core modules [CITED: docs/design/2026-04-07-principle-internalization-system-technical-appendix.md] [VERIFIED: codebase grep].

### Pattern 1: Host As A Single Gate Stage Adapter

**What:** `gate.ts` stays the authoritative orchestration path and makes exactly one host call after GFI and normalization, before Progressive Gate [VERIFIED: codebase grep].  
**When to use:** Every tool event that already enters the existing write/bash/agent gate path and survives early return + thinking checkpoint + GFI [VERIFIED: codebase grep].  
**Example:**

```ts
// Source: gate.ts orchestration pattern + phase context
const gfiResult = checkGfiGate(event, wctx, ctx.sessionId, gfiGateConfig, logger);
if (gfiResult) return gfiResult;

const relPath = normalizePath(filePath, ctx.workspaceDir);
const risky = isRisky(relPath, profile.risk_paths);

const hostResult = ruleHost.evaluate({
  event,
  relPath,
  risky,
  sessionId: ctx.sessionId,
  workspaceDir: ctx.workspaceDir,
});
if (hostResult?.decision === 'block') {
  return recordGateBlockAndReturn(wctx, {
    filePath: relPath,
    toolName: event.toolName,
    reason: hostResult.reason,
    sessionId: ctx.sessionId,
    blockSource: 'rule-host',
  }, logger);
}

const progressiveGateResult = checkProgressiveTrustGate(
  event,
  wctx,
  relPath,
  risky,
  estimateLineChanges({ toolName: event.toolName, params: event.params }),
  logger,
  ctx,
  profile,
);
```

### Pattern 2: Registry, Loader, Evaluator Separation

**What:** Split “which implementations are eligible,” “how assets are loaded,” and “how decisions are merged” into separate modules [CITED: docs/design/2026-04-07-principle-internalization-system-technical-appendix.md].  
**When to use:** Always; this keeps `gate.ts` thin and prevents storage concerns from leaking into runtime evaluation [VERIFIED: codebase grep].  
**Example:**

```ts
// Source: WorkspaceContext + ledger subtree pattern
const activeSubtrees = wctx.getActivePrincipleSubtrees();
const activeCodeImplementations = registry.listActiveCodeImplementations(activeSubtrees);
const loaded = activeCodeImplementations.map((impl) => loader.load(impl));
const decision = evaluator.evaluateAll(loaded, hostInput);
```

### Pattern 3: Ledger-First, Asset-Second Storage

**What:** The ledger remains canonical for relationships and lifecycle state; the filesystem stores entry code, manifests, and refs to future replay/eval artifacts [VERIFIED: codebase grep] [CITED: docs/design/2026-04-07-principle-internalization-system-technical-appendix.md].  
**When to use:** For all `Implementation(type=code)` records in Phase 12 [VERIFIED: codebase grep].  
**Example:**

```ts
// Source: principle-tree-ledger.ts CRUD pattern
updateImplementation(stateDir, implementationId, {
  path: assetRootRelativePath,
  version: manifest.version,
  status: 'active', // requires schema extension in Phase 12
  updatedAt: new Date().toISOString(),
});
```

### Pattern 4: Host-Owned Snapshot, Not Live Workspace Handles

**What:** Implementations receive a frozen, derived input snapshot plus a tiny helper surface, not `WorkspaceContext`, raw `ctx`, or direct Node globals [VERIFIED: codebase grep] [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html].  
**When to use:** For every hosted implementation evaluation [VERIFIED: codebase grep].  
**Example:**

```ts
// Source: phase context helper whitelist + Node vm docs
export interface RuleHostInput {
  action: { toolName: string; normalizedPath: string | null; paramsSummary: Record<string, unknown> };
  workspace: { isRiskPath: boolean; planStatus: 'NONE' | 'DRAFT' | 'READY' | 'UNKNOWN'; hasPlanFile: boolean };
  session: { sessionId?: string; currentGfi: number; recentThinking: boolean };
  evolution: { epTier: number };
  derived: { estimatedLineChanges: number; bashRisk: 'safe' | 'normal' | 'dangerous' | 'unknown' };
  helpers: RuleHostHelpers;
}
```

### Anti-Patterns to Avoid

- **Putting host logic directly in `gate.ts`:** This would break the existing “single authoritative orchestration path + focused policy modules” pattern and make later phase boundaries harder to enforce [VERIFIED: codebase grep].
- **Treating filesystem manifests as canonical state:** The context explicitly says the Principle Tree stays authoritative, so status and relationship truth cannot live only in `manifest.json` [VERIFIED: codebase grep].
- **Using ESM/dynamic import inside hosted assets:** Node documents `importModuleDynamically` in vm as experimental and not recommended for production, and the phase context explicitly forbids dynamic import for hosted implementations [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html] [VERIFIED: codebase grep].
- **Letting the host invent a second block persistence path:** Gate blocks already have a single helper; host blocks should flow through it [VERIFIED: codebase grep].
- **Implementing replay, promotion, or nocturnal artifact generation here:** Those are explicitly deferred to Phases 13-15 [VERIFIED: codebase grep].

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Hosted code execution | Raw `eval`, `new Function`, or ad hoc global injection [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html] | `node:vm` with `createContext()` + `compileFunction()` and host-controlled globals [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html] | Node docs allow constraining code generation and make clear the host must own the context surface [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html] |
| Runtime registry discovery | Directory walking from `gate.ts` [ASSUMED] | Ledger-backed registry via `WorkspaceContext.getActivePrincipleSubtrees()` [VERIFIED: codebase grep] | Reuses the Phase 11 semantic model and avoids a second source of truth [VERIFIED: codebase grep] |
| Gate block tracking | A new block logger inside Rule Host [ASSUMED] | `recordGateBlockAndReturn()` [VERIFIED: codebase grep] | Existing tests enforce a single persistence implementation for blocks [VERIFIED: codebase grep] |
| Storage path computation | Hardcoded workspace-relative or absolute paths [ASSUMED] | Extend `PD_DIRS`/`PD_FILES` and resolve through existing path utilities [VERIFIED: codebase grep] | Matches project conventions and avoids path drift across Windows/POSIX [VERIFIED: codebase grep] |
| Lifecycle truth | Inferring `candidate/active/disabled/archived` from directory names only [ASSUMED] | Canonical lifecycle field on implementation metadata plus mirrored manifest [VERIFIED: codebase grep] [ASSUMED] | IMPL-02 requires queryable lifecycle state and the current schema cannot express it yet [VERIFIED: codebase grep] |

**Key insight:** The hard part of this phase is not “running custom JS.” It is preserving a single authority chain: `gate.ts` owns orchestration, the ledger owns semantic truth, the host owns execution constraints, and later phases own replay/promotion logic [VERIFIED: codebase grep].

## Common Pitfalls

### Pitfall 1: Treating `node:vm` as a Real Security Sandbox

**What goes wrong:** Planners assume `vm` makes arbitrary implementation code “safe” and start expanding helper power or candidate execution too early [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html].  
**Why it happens:** The API feels sandbox-like, but Node explicitly warns that `node:vm` is not a security mechanism [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html].  
**How to avoid:** Only run already-active implementations, keep the helper surface tiny, omit dynamic import support, and treat the host as capability minimization rather than hostile-code isolation [VERIFIED: codebase grep] [ASSUMED].  
**Warning signs:** A plan proposes `import()`, file reads, network calls, subprocesses, or nocturnal candidate execution in the runtime host [VERIFIED: codebase grep].

### Pitfall 2: Inserting Rule Host Too Early In `gate.ts`

**What goes wrong:** The host runs before GFI or before normalization and ends up duplicating existing gating logic or working on raw/untrusted path strings [VERIFIED: codebase grep].  
**Why it happens:** “Between GFI and Progressive Gate” is read too literally instead of following the actual current code flow [VERIFIED: codebase grep].  
**How to avoid:** Insert the host after `checkGfiGate()` and after `filePath`, `relPath`, and `risky` are derived, then hand off to Progressive Gate unchanged [VERIFIED: codebase grep].  
**Warning signs:** A plan forces Rule Host to parse bash risk, normalize paths, or read PROFILE settings itself [VERIFIED: codebase grep].

### Pitfall 3: Letting Manifest Files Become The Real Registry

**What goes wrong:** The filesystem becomes the place that defines implementation status or parent relationships, and the ledger stops being authoritative [VERIFIED: codebase grep].  
**Why it happens:** IMPL-01 needs asset files, so it is tempting to stash all metadata there [VERIFIED: codebase grep].  
**How to avoid:** Keep Principle/Rule/Implementation relationships and lifecycle state in canonical metadata, and use manifests as subordinate loading metadata only [VERIFIED: codebase grep] [ASSUMED].  
**Warning signs:** Plans say “scan implementation directories to find active rules” or avoid schema changes because “manifest already has status” [ASSUMED].

### Pitfall 4: Accidentally Starting Phase 13 In Phase 12

**What goes wrong:** The plan adds replay execution, evaluation metrics, or manual promotion controls while building storage primitives [VERIFIED: codebase grep].  
**Why it happens:** IMPL-01 mentions replay samples and latest evaluation report, so planners start implementing the producers and evaluators too [VERIFIED: codebase grep].  
**How to avoid:** Store only refs/placeholders for replay sample sets and last evaluation reports in this phase; actual replay, report generation, and promotion stay deferred [VERIFIED: codebase grep].  
**Warning signs:** A task includes sample selection, replay commands, pass/fail thresholds, or promotion UI/commands [VERIFIED: codebase grep].

### Pitfall 5: Losing Single-Path Block Persistence

**What goes wrong:** Rule Host creates its own block logging path and breaks the existing one-call guarantees for `trackBlock`, event log writes, and trajectory retry behavior [VERIFIED: codebase grep].  
**Why it happens:** Host decisions look like a “new kind” of block and tempt separate handling [VERIFIED: codebase grep].  
**How to avoid:** Adapt host `block` and `requireApproval` results through the existing gate result helper path, with a distinct `blockSource` tag only [VERIFIED: codebase grep] [ASSUMED].  
**Warning signs:** New host code writes directly to `eventLog.recordGateBlock()` or `trajectory.recordGateBlock()` [VERIFIED: codebase grep].

## Code Examples

Verified patterns from official sources and current repo structure:

### Constrained Host Loading

```ts
// Source: Node vm docs + phase helper whitelist decisions
import vm from 'node:vm';

const sandbox = vm.createContext(
  { helpers, frozenInput },
  {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  },
);

const factory = vm.compileFunction(
  `${source}\nreturn { meta, evaluate };`,
  ['helpers', 'frozenInput'],
  { parsingContext: sandbox, filename: entryFile },
);

const loaded = factory(helpers, frozenInput) as {
  meta: RuleHostMeta;
  evaluate: (input: RuleHostInput) => RuleHostDecision;
};
```

### Deterministic Decision Merge

```ts
// Source: phase context decision constraints
for (const implementation of orderedImplementations) {
  const result = implementation.evaluate(input);
  if (!result.matched) continue;
  if (result.decision === 'block') return result;
  if (result.decision === 'requireApproval') approvals.push(result);
}

if (approvals.length > 0) {
  return mergeApprovals(approvals);
}

return undefined;
```

### Ledger-First Asset Registration

```ts
// Source: principle-tree-ledger CRUD pattern
createImplementation(stateDir, {
  id: implementationId,
  ruleId,
  type: 'code',
  path: assetRootRelativePath,
  version,
  status: 'candidate',
  coversCondition,
  coveragePercentage: 0,
  createdAt: now,
  updatedAt: now,
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Special-case runtime hook logic such as `message-sanitize` [VERIFIED: codebase grep] | General `Rule Host` stage running active `Implementation(type=code)` assets in the gate chain [VERIFIED: codebase grep] [CITED: docs/design/2026-04-07-principle-internalization-system-technical-appendix.md] | Design reframing on `2026-04-07` [VERIFIED: codebase grep] | Runtime behavior becomes principle-tree-addressable instead of accumulating one-off hook logic [VERIFIED: codebase grep] |
| `Implementation` records as abstract leaves only [VERIFIED: codebase grep] | Ledger-backed implementation metadata plus subordinate versioned asset directories [VERIFIED: codebase grep] [ASSUMED] | Phase 12 target state [VERIFIED: codebase grep] | Makes later replay/promotion/rollback possible without redefining storage contracts [ASSUMED] |
| Gate-only hard boundaries (`Thinking`, `GFI`, `Progressive`, `Edit Verification`) [VERIFIED: codebase grep] | Same chain, with Rule Host inserted before Progressive Gate and without removing existing hard boundaries [VERIFIED: codebase grep] | Phase 12 target state [VERIFIED: codebase grep] | Adds semantic rule enforcement without opening a capability gap [VERIFIED: codebase grep] |

**Deprecated/outdated:**

- Treating DHSE as the whole system is outdated; the current design reframes it as only the code-implementation branch inside the broader Principle Internalization System [CITED: docs/design/2026-04-06-dynamic-harness-evolution-engine.md] [CITED: docs/design/2026-04-07-principle-internalization-system.md].
- Treating `message-sanitize.ts` as part of the future internalization path is outdated; the design docs call it out as planned simplification/removal ahead of host integration [CITED: docs/design/2026-04-07-principle-internalization-system.md].

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Mutable implementation assets should live under a state-owned directory such as `.state/implementations/code/` rather than `.principles/implementations/code/` because the repo currently treats mutable machine-owned data as state [ASSUMED] | Summary, Architecture Patterns | Path layout may conflict with user preference or future operator UX expectations |
| A2 | Hosted implementation entry files should be plain JavaScript (`entry.js`) rather than TypeScript (`entry.ts`) so the runtime host does not need a transpilation step [ASSUMED] | Standard Stack, Architecture Patterns | Planner may under-specify asset authoring if the project expects TS-authored hosted assets |
| A3 | Phase 12 can rely on capability minimization plus “active implementations only” rather than full hostile-code isolation, despite Node vm not being a security boundary [ASSUMED] | Summary, Common Pitfalls | If implementations must be treated as hostile, Phase 12 needs process isolation or a different trust model |
| A4 | The canonical `Implementation` schema should gain a lifecycle/status field in Phase 12 instead of leaving status only in manifests [ASSUMED] | Summary, Architecture Patterns | If status stays outside canonical metadata, IMPL-02 may be hard to query and reason about later |

## Open Questions

1. **Should the asset root be `.state/implementations/code/` or `.principles/implementations/code/`?**
   - What we know: The design appendix illustrates `.principles/implementations/code/...`, but the phase context explicitly allows an equivalent state-owned directory, and the repo currently stores mutable machine-owned data under `.state` [CITED: docs/design/2026-04-07-principle-internalization-system-technical-appendix.md] [VERIFIED: codebase grep].
   - What's unclear: Whether operator-facing discoverability under `.principles` matters more than keeping mutable assets with other stateful machine-owned files [ASSUMED].
   - Recommendation: Lock this before planning; if undecided, prefer `.state` for mutable assets and keep ledger references stable either way [ASSUMED].

2. **How should `requireApproval` map onto the current hook API surface?**
   - What we know: Current gate helpers return block-or-allow style `PluginHookBeforeToolCallResult`s, and current code/tests do not expose a richer approval result type at the hook boundary [VERIFIED: codebase grep].
   - What's unclear: Whether OpenClaw now supports an approval-specific hook return shape outside this repo’s current usage [ASSUMED].
   - Recommendation: Plan `requireApproval` as a host-internal decision enum that initially adapts to a blocking operator-facing message unless SDK support is verified before implementation starts [VERIFIED: codebase grep] [ASSUMED].

3. **Should lifecycle status live only on `Implementation`, or also on manifests?**
   - What we know: IMPL-02 requires lifecycle states, the current `Implementation` schema lacks them, and D-11 says the Principle Tree remains authoritative [VERIFIED: codebase grep].
   - What's unclear: Whether the team wants manifest status duplicated for human/debug convenience [ASSUMED].
   - Recommendation: Keep canonical status in the ledger and mirror it into manifests only if loader ergonomics justify the duplication [ASSUMED].

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime host implementation | ✓ [VERIFIED: local node --version] | `v24.14.0` [VERIFIED: local node --version] | — |
| npm | Dependency refresh and test execution | ✓ [VERIFIED: local npm --version] | `11.9.0` [VERIFIED: local npm --version] | — |
| Vitest | Unit/integration verification | ✓ [VERIFIED: npm ls] | installed `4.1.0` [VERIFIED: npm ls] | `npm install` refreshes to the declared range if needed [VERIFIED: codebase grep] |
| TypeScript | Build/typecheck | ✓ but wrong installed version [VERIFIED: npm ls] | installed `5.9.3`; declared `^6.0.2` [VERIFIED: npm ls] | `npm install` to sync local deps; no reliable fallback for “same as package.json” behavior [VERIFIED: npm ls] |
| esbuild | Existing production build | ✓ [VERIFIED: npm ls] | installed `0.27.4` [VERIFIED: npm ls] | — |
| better-sqlite3 | Existing plugin runtime dependency | ✓ [VERIFIED: npm ls] | `12.8.0` [VERIFIED: npm ls] | — |

**Missing dependencies with no fallback:**

- None found, but the local TypeScript install is behind the declared package range, so planner verification steps should include a dependency refresh before trusting build output [VERIFIED: npm ls].

**Missing dependencies with fallback:**

- None [VERIFIED: local environment probe].

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `vitest` with node environment and forked worker pool [VERIFIED: codebase grep] |
| Config file | `packages/openclaw-plugin/vitest.config.ts` [VERIFIED: codebase grep] |
| Quick run command | `cd packages/openclaw-plugin && npm test -- tests/hooks/gate-pipeline-integration.test.ts` [VERIFIED: codebase grep] [ASSUMED] |
| Full suite command | `cd packages/openclaw-plugin && npm test` [VERIFIED: codebase grep] |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| HOST-01 | Rule Host executes between GFI and Progressive Gate without breaking edit verification | integration | `cd packages/openclaw-plugin && npm test -- tests/hooks/gate-rule-host-pipeline.test.ts` | ❌ Wave 0 |
| HOST-02 | Active code implementations only run through fixed input/helpers | unit | `cd packages/openclaw-plugin && npm test -- tests/core/rule-host-helpers.test.ts` | ❌ Wave 0 |
| HOST-03 | Host decision union supports `allow` / `block` / `requireApproval` plus diagnostics | unit | `cd packages/openclaw-plugin && npm test -- tests/core/rule-host.test.ts` | ❌ Wave 0 |
| HOST-04 | Host failures degrade conservatively and preserve downstream hard boundaries | integration | `cd packages/openclaw-plugin && npm test -- tests/hooks/gate-rule-host-failure.test.ts` | ❌ Wave 0 |
| IMPL-01 | Code implementations persist as versioned assets with manifest/entry/ref metadata | unit | `cd packages/openclaw-plugin && npm test -- tests/core/code-implementation-storage.test.ts` | ❌ Wave 0 |
| IMPL-02 | Lifecycle states `candidate/active/disabled/archived` are represented canonically | unit | `cd packages/openclaw-plugin && npm test -- tests/core/code-implementation-registry.test.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `cd packages/openclaw-plugin && npm test -- tests/hooks/gate-pipeline-integration.test.ts` or the touched host/storage test file [VERIFIED: codebase grep] [ASSUMED]
- **Per wave merge:** `cd packages/openclaw-plugin && npm test` [VERIFIED: codebase grep]
- **Phase gate:** Full suite green after a dependency refresh if TypeScript remains mismatched locally [VERIFIED: npm ls]

### Wave 0 Gaps

- [ ] `packages/openclaw-plugin/tests/hooks/gate-rule-host-pipeline.test.ts` — covers HOST-01 and host ordering against existing gate chain
- [ ] `packages/openclaw-plugin/tests/core/rule-host.test.ts` — covers HOST-03 merge semantics and `requireApproval` behavior
- [ ] `packages/openclaw-plugin/tests/core/rule-host-helpers.test.ts` — covers HOST-02 whitelist boundaries and forbidden capability leaks
- [ ] `packages/openclaw-plugin/tests/hooks/gate-rule-host-failure.test.ts` — covers HOST-04 conservative degradation and downstream gate preservation
- [ ] `packages/openclaw-plugin/tests/core/code-implementation-storage.test.ts` — covers IMPL-01 asset layout and manifest/version refs
- [ ] `packages/openclaw-plugin/tests/core/code-implementation-registry.test.ts` — covers IMPL-02 lifecycle states and ledger-authoritative filtering
- [ ] Refresh local dependencies with `cd packages/openclaw-plugin && npm install` before trusting TypeScript-sensitive results [VERIFIED: npm ls]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no [ASSUMED] | Not directly in scope for a local plugin runtime host [ASSUMED] |
| V3 Session Management | no [ASSUMED] | Not directly in scope for this phase; session IDs are telemetry inputs, not auth/session primitives here [ASSUMED] |
| V4 Access Control | yes [VERIFIED: codebase grep] | Keep `Progressive Gate` in place and make Rule Host a narrower pre-filter, not a replacement [VERIFIED: codebase grep] |
| V5 Input Validation | yes [VERIFIED: codebase grep] | Validate manifest shape, host contract exports, lifecycle state values, and helper usage before loading/evaluating an implementation [VERIFIED: codebase grep] [ASSUMED] |
| V6 Cryptography | no [ASSUMED] | No crypto control is inherent to Phase 12 itself [ASSUMED] |

### Known Threat Patterns for Runtime Rule Host

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Hosted implementation reaches privileged Node APIs | Elevation of Privilege | Do not expose `fs`, `process`, module loaders, or dynamic import; use host-owned `vm` context with minimal globals and disabled string code generation [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html] [VERIFIED: codebase grep] |
| Host failure silently opens a gate hole | Tampering | Treat host errors as conservative deny/approval-required outcomes and keep `Progressive Gate` and `Edit Verification` in the chain [VERIFIED: codebase grep] [ASSUMED] |
| Duplicate block logging creates inconsistent audit trails | Repudiation | Reuse `recordGateBlockAndReturn()` for host-originated blocks with a distinct `blockSource` tag [VERIFIED: codebase grep] |
| Filesystem assets drift from semantic truth | Integrity | Keep lifecycle and parent relationships canonical in ledger metadata and validate manifests against ledger records on load [VERIFIED: codebase grep] [ASSUMED] |
| Hardcoded or platform-specific asset paths break on Windows/POSIX | Tampering | Extend existing PD path utilities and `WorkspaceContext` instead of ad hoc path joins in host/storage code [VERIFIED: codebase grep] |

## Sources

### Primary (HIGH confidence)

- `packages/openclaw-plugin/src/hooks/gate.ts` - authoritative gate chain, current insertion seam, and downstream gate behavior
- `packages/openclaw-plugin/src/hooks/gfi-gate.ts` - confirms GFI remains ahead of host logic
- `packages/openclaw-plugin/src/hooks/progressive-trust-gate.ts` - confirms Progressive Gate remains the hard-boundary fallback
- `packages/openclaw-plugin/src/hooks/gate-block-helper.ts` - authoritative block persistence path
- `packages/openclaw-plugin/src/core/workspace-context.ts` - workspace-scoped service/accessor pattern
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` - canonical ledger CRUD and subtree lookup
- `packages/openclaw-plugin/src/types/principle-tree-schema.ts` - current canonical Principle/Rule/Implementation schema
- `packages/openclaw-plugin/tests/hooks/gate-pipeline-integration.test.ts` - existing authoritative-path regression coverage
- `packages/openclaw-plugin/tests/core/principle-tree-ledger.test.ts` - existing ledger CRUD/query coverage
- `packages/openclaw-plugin/tests/core/workspace-context.test.ts` - existing WorkspaceContext integration pattern
- `packages/openclaw-plugin/vitest.config.ts` - current validation framework setup
- `docs/design/2026-04-07-principle-internalization-system-technical-appendix.md` - recommended Rule Host split, helper whitelist, and storage framing
- `docs/design/2026-04-07-principle-internalization-roadmap.md` - confirms M3/M4 are the Phase 12 slice and later milestones own replay/promotion/coverage
- [Node.js VM docs](https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html) - `node:vm` API constraints, `createContext`, `compileFunction`, dynamic import notes, and explicit non-security warning
- npm registry via `npm view` - current versions and modified dates for `vitest`, `typescript`, `esbuild`, and `better-sqlite3`

### Secondary (MEDIUM confidence)

- `docs/design/2026-04-07-principle-internalization-system.md` - system framing and `message-sanitize` simplification direction
- `docs/design/2026-04-06-dynamic-harness-evolution-engine.md` - narrowed DHSE framing as the code-implementation branch

### Tertiary (LOW confidence)

- None. Remaining uncertainty is captured in the Assumptions Log rather than sourced from unverified web results.

## Metadata

**Confidence breakdown:**

- Standard stack: MEDIUM - Current repo/runtime facts are verified, but the final asset root and asset authoring format still require one design choice to be locked [VERIFIED: codebase grep] [ASSUMED]
- Architecture: HIGH - The gate seam, service pattern, ledger authority, and test reuse paths are all directly visible in the codebase and phase context [VERIFIED: codebase grep]
- Pitfalls: HIGH - The biggest failure modes are explicit in current code/tests and official Node vm docs [VERIFIED: codebase grep] [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html]

**Research date:** 2026-04-07
**Valid until:** 2026-05-07 for codebase findings; re-verify npm registry and Node vm docs if planning slips beyond 30 days [VERIFIED: npm registry] [CITED: https://nodejs.org/download/release/latest-v20.x/docs/api/vm.html]
