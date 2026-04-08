# Phase 12: Runtime Rule Host and Code Implementation Storage - Context

**Gathered:** 2026-04-07 (auto mode)
**Status:** Ready for planning

<domain>
## Phase Boundary

Add the constrained runtime host for `Implementation(type=code)` and define/store code implementations as versioned assets. This phase wires online execution and implementation storage only. It does not add replay promotion, nocturnal candidate generation, or coverage/deprecation accounting.

</domain>

<decisions>
## Implementation Decisions

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

### the agent's Discretion
- Exact module/file naming for Rule Host internals
- Whether host loading and registry logic live in one module or a small set of focused modules
- Whether implementation storage is anchored under `.principles/implementations/code/` or an equivalent state-owned directory, as long as Principle Tree remains authoritative

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone framing
- `docs/design/2026-04-07-principle-internalization-system.md` - top-level Principle Internalization System framing
- `docs/design/2026-04-07-principle-internalization-system-technical-appendix.md` - Rule Host, helper whitelist, artifact, and coverage definitions
- `docs/design/2026-04-07-principle-internalization-roadmap.md` - technical milestone mapping for M3/M4 and Phase 12 intent
- `docs/design/2026-04-06-dynamic-harness-evolution-engine.md` - narrowed DHSE framing as the code implementation branch

### Existing runtime and storage code
- `packages/openclaw-plugin/src/hooks/gate.ts` - current authoritative gate chain and insertion point for Rule Host
- `packages/openclaw-plugin/src/hooks/progressive-trust-gate.ts` - host hard-boundary capability gate that must remain in place
- `packages/openclaw-plugin/src/hooks/gfi-gate.ts` - fatigue gate that must stay ahead of Rule Host
- `packages/openclaw-plugin/src/core/workspace-context.ts` - workspace-scoped dependency hub
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` - current Phase 11 ledger source of truth for Principle / Rule / Implementation records
- `packages/openclaw-plugin/src/types/principle-tree-schema.ts` - canonical Principle / Rule / Implementation schema

### GSD planning source of truth
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/STATE.md`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `gate.ts` already orchestrates the current hard-boundary chain and is the single authoritative hook path
- `WorkspaceContext` already centralizes workspace-scoped services and is the natural Rule Host integration point
- `principle-tree-ledger.ts` already gives Phase 12 an authoritative Principle / Rule / Implementation store to load active code implementations from

### Established Patterns
- Hooks remain the entry point; policy modules are small and focused
- Workspace-scoped stateful services are cached/lazy via `WorkspaceContext`
- State ownership is centralized; new runtime modules should not scatter file-system writes across hooks

### Integration Points
- `gate.ts` for host insertion and result merging
- `WorkspaceContext` for registry/host access
- Phase 11 ledger for active implementation lookup and implementation metadata

</code_context>

<specifics>
## Specific Ideas

- Phase 12 should feel like “hosting constrained code implementations safely,” not “starting replay/promotion early.”
- The first implementation storage contract should be minimal but future-safe: manifest + entry + metadata pointers are enough.
- Rule Host should merge multiple implementation decisions deterministically and short-circuit on `block`.

</specifics>

<deferred>
## Deferred Ideas

- Replay evaluation and manual promotion loop - Phase 13
- Nocturnal `RuleImplementationArtifact` generation - Phase 14
- Coverage, false-positive, adherence, and deprecation accounting - Phase 15
- Multi-form routing between skill / code / LoRA - later milestone

</deferred>

---

*Phase: 12-runtime-rule-host-and-code-implementation-storage*
*Context gathered: 2026-04-07*
