# Phase 44: Pre-Split Inventory - Context

**Gathered:** 2026-04-15
**Status:** Ready for planning

<domain>
## Phase Boundary

Document module-level mutable state and draw import graph before Phase 46's god class split. This is pure analysis — no implementation changes. The output guides Phase 46 planning by showing:
- Where mutable state lives (and how it flows)
- Module dependency structure (where each module can be extracted cleanly)

**INFRA-01:** Pre-split inventory — document all module-level mutable state in `evolution-engine.ts`, draw import graph before splitting
**INFRA-02:** Add `complexity_max: 15` and `max_file_lines: 500` to eslint config as debt prevention gates

</domain>

<decisions>
## Implementation Decisions

### INFRA-01: Mutable State Inventory Format
- **D-01:** Output mutable state inventory as markdown tables with columns: File, Export Name, Type, Initialized By, Mutation Pattern
- **D-02:** Draw import graph as a Mermaid `flowchart LR` or `graph TD` diagram showing file-level dependencies

### INFRA-01: Scope — Files to Inventory
- **D-03:** Inventory mutable state in all modules identified as "god class" candidates:
  - `nocturnal-trinity.ts` (2429L — largest)
  - `evolution-engine.ts` (612L)
  - Any other module with >500 lines or complex mutable state
- **D-04:** Inventory is annotated with which Phase 46 SPLIT requirement each module maps to

### INFRA-01: Mutable State Categories to Identify
- **D-05:** Module-level `let` variables (explicit mutable state)
- **D-06:** Module-level class instances stored in `const` (implicitly mutable via methods)
- **D-07:** Mutable collections (arrays, Maps, Sets) assigned at module level
- **D-08:** Imported mutable singletons (e.g., imported and reassigned)

### INFRA-02: ESLint Debt Gates
- **D-09:** `complexity_max: 15` — per-function cyclomatic complexity limit
- **D-10:** `max_file_lines: 500` — per-file line count limit
- **D-11:** Both rules should apply to `packages/openclaw-plugin/src/` only (not templates/test fixtures)

### Claude's Discretion
- How to detect "complex" functions (TSQuery patterns vs grep)
- Whether to include test files in eslint config scope

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### God Class Candidates
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — 2429 lines, trinity chain (Dreamer→Philosopher→Scribe), largest candidate
- `packages/openclaw-plugin/src/core/evolution-engine.ts` — 612 lines, evolution queue driving

### Phase 46 Split Map
- `packages/openclaw-plugin/src/core/evolution-migration.ts` — queue-migration concern (SPLIT-01)
- `packages/openclaw-plugin/src/core/rule-host.ts` — workflow watchdog concern (SPLIT-02)
- `packages/openclaw-plugin/src/core/evolution-logger.ts` / `event-log.ts` — queue-io concern (SPLIT-03)
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — sleep-cycle concern (SPLIT-05)

### eslint Config
- `packages/openclaw-plugin/eslint.config.js` — existing eslint configuration (base for adding debt gates)

### Requirements References
- `.planning/REQUIREMENTS.md` — INFRA-01, INFRA-02 requirements text
- `.planning/ROADMAP.md` — Phase 44 description and Phase 46 SPLIT requirements

</canonical_refs>

<codebase_context>
## Existing Code Insights

### Reusable Assets
- Mermaid diagrams already used in some project documentation (check `docs/` or `*.md` files for patterns)
- ESLint already configured in `packages/openclaw-plugin/eslint.config.js`

### Established Patterns
- Module-level mutable state pattern: modules in `src/core/` tend to export singleton instances or factories
- Dependency direction: `evolution-engine.ts` drives the queue; `nocturnal-trinity.ts` is called by `evolution-engine.ts`

### Integration Points
- `evolution-engine.ts` orchestrates: pain → queue → nocturnal → replay → promotion
- `nocturnal-trinity.ts` is a leaf in the call chain (receives snapshots, emits artifacts)
- `evolution-migration.ts` handles queue file I/O (already somewhat isolated)

</code_context>

<specifics>
## Specific Ideas

- Mutable state table format:
  | File | Export | Type | Init | Mutation Pattern |
  |------|--------|------|------|-----------------|
  | nocturnal-trinity.ts | `cache: Map<string, X>` | Map | lazy init | keys added/removed |
- Import graph: Mermaid `flowchart TD` with each node = a source file, edges = import relationships
- ESLint config add:
  ```js
  { rules: { 'max-lines': ['error', { max: 500 }], 'complexity': ['error', { max: 15 }] } }
  ```
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope
</deferred>

