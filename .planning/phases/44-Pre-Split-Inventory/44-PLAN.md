---
phase: "44"
phase_name: Pre-Split Inventory
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/openclaw-plugin/eslint.config.js
autonomous: true
requirements:
  - INFRA-02
must_haves:
  truths:
    - "ESLint config enforces per-function cyclomatic complexity of max 15 in openclaw-plugin/src"
    - "ESLint config enforces per-file line count of max 500 in openclaw-plugin/src"
  artifacts:
    - path: "packages/openclaw-plugin/eslint.config.js"
      provides: "ESLint debt prevention gates"
      contains: "complexity.*max.*15"
      contains: "max-lines.*max.*500"
    - path: ".planning/phases/44-Pre-Split-Inventory/44-01-SUMMARY.md"
      provides: "Plan completion record"
---

<objective>
Add ESLint debt prevention gates to enforce complexity_max: 15 and max_file_lines: 500 in packages/openclaw-plugin/src/.
</objective>

<context>
@packages/openclaw-plugin/eslint.config.js
</context>

<interfaces>
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Add complexity and max-lines ESLint rules to openclaw-plugin/src</name>
  <files>packages/openclaw-plugin/eslint.config.js</files>
  <read_first>
    - packages/openclaw-plugin/eslint.config.js
  </read_first>
  <action>
    Edit packages/openclaw-plugin/eslint.config.js to add two new rules to the src rules section (the first config block targeting 'src/**/*.ts'):

    1. Find the rules block in the first config object (lines 18-25)
    2. Add to the rules object:
       - 'max-lines': ['error', { max: 500 }]
       - complexity: ['error', { max: 15 }]

    The existing rules block is:
    ```
    rules: {
      'no-empty': 'error',
      'no-console': 'warn',
      'complexity': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
    ```

    After editing, 'complexity': 'off' should be changed to 'complexity': ['error', { max: 15 }], and 'max-lines': ['error', { max: 500 }] should be added. The 'complexity' rule replaces the existing 'off' setting.

    IMPORTANT: These rules apply ONLY to the src files block (the first config object with files: ['src/**/*.ts']), NOT to the tests block.
  </action>
  <verify>
    <automated>grep -E "max-lines|complexity" packages/openclaw-plugin/eslint.config.js</automated>
  </verify>
  <done>ESLint config has complexity: ['error', { max: 15 }] and 'max-lines': ['error', { max: 500 }] in the src rules section</done>
  <acceptance_criteria>
    - grep "max-lines" packages/openclaw-plugin/eslint.config.js returns a line with "max-lines": ['error', { max: 500 }]
    - grep "complexity" packages/openclaw-plugin/eslint.config.js returns a line with complexity: ['error', { max: 15 }]
    - The rules appear in the first config block (src/**/*.ts), not the tests block
  </acceptance_criteria>
</task>

</tasks>

<verification>
1. Run eslint on a sample file to confirm rules are active (optional): npx eslint packages/openclaw-plugin/src/core/evolution-engine.ts --format compact 2>&1 | head -20
2. Verify no existing src file exceeds 500 lines (expected: some will fail since the rule is new): npx eslint packages/openclaw-plugin/src/core/ --rule 'max-lines: [error, { max: 500 }]' --format compact 2>&1 | head -30
</verification>

<success_criteria>
ESLint config at packages/openclaw-plugin/eslint.config.js contains:
- 'max-lines': ['error', { max: 500 }] in the src/**/*.ts rules section
- complexity: ['error', { max: 15 }] in the src/**/*.ts rules section (replacing 'complexity': 'off')
</success_criteria>

<output>
After completion, create .planning/phases/44-Pre-Split-Inventory/44-01-SUMMARY.md
</output>
---

---
phase: "44"
phase_name: Pre-Split Inventory
plan: "02"
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md
autonomous: true
requirements:
  - INFRA-01
must_haves:
  truths:
    - "Mutable state inventory documents all module-level mutable state in god class candidates"
    - "Import graph shows file-level dependencies for god class candidates as Mermaid flowchart"
  artifacts:
    - path: ".planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md"
      provides: "Module-level mutable state inventory with markdown tables and Mermaid import graph"
      contains: "## Mutable State Inventory"
      contains: "```mermaid"
---

<objective>
Document all module-level mutable state in god class candidates (nocturnal-trinity.ts, evolution-engine.ts, and related core modules) and draw an import graph showing file-level dependencies. This is pure analysis - no implementation changes.
</objective>

<context>
@packages/openclaw-plugin/src/core/nocturnal-trinity.ts
@packages/openclaw-plugin/src/core/evolution-engine.ts
</context>

<interfaces>
Key files in scope (from D-03):
- packages/openclaw-plugin/src/core/nocturnal-trinity.ts (2429L — god class candidate)
- packages/openclaw-plugin/src/core/evolution-engine.ts (612L — god class candidate)

Related modules to check for mutable state context:
- packages/openclaw-plugin/src/core/evolution-migration.ts
- packages/openclaw-plugin/src/core/rule-host.ts
- packages/openclaw-plugin/src/core/evolution-logger.ts
- packages/openclaw-plugin/src/core/event-log.ts

Phase 46 split map (from canonical refs):
- SPLIT-01: evolution-migration.ts — queue-migration concern
- SPLIT-02: rule-host.ts — workflow watchdog concern
- SPLIT-03: evolution-logger.ts / event-log.ts — queue-io concern
- SPLIT-05: nocturnal-trinity.ts — sleep-cycle concern
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Scan source files for module-level mutable state</name>
  <files>
    - packages/openclaw-plugin/src/core/nocturnal-trinity.ts
    - packages/openclaw-plugin/src/core/evolution-engine.ts
    - packages/openclaw-plugin/src/core/evolution-migration.ts
    - packages/openclaw-plugin/src/core/rule-host.ts
    - packages/openclaw-plugin/src/core/evolution-logger.ts
    - packages/openclaw-plugin/src/core/event-log.ts
  </files>
  <read_first>
    - packages/openclaw-plugin/src/core/nocturnal-trinity.ts
    - packages/openclaw-plugin/src/core/evolution-engine.ts
  </read_first>
  <action>
    Read each of the following files and identify module-level mutable state per D-05 through D-08 categories:
    1. Module-level `let` variables (explicit mutable state)
    2. Module-level class instances stored in `const` (implicitly mutable via methods)
    3. Mutable collections (arrays, Maps, Sets) assigned at module level
    4. Imported mutable singletons (e.g., imported and reassigned)

    Scan these files:
    - packages/openclaw-plugin/src/core/nocturnal-trinity.ts (2429L)
    - packages/openclaw-plugin/src/core/evolution-engine.ts (612L)
    - packages/openclaw-plugin/src/core/evolution-migration.ts
    - packages/openclaw-plugin/src/core/rule-host.ts
    - packages/openclaw-plugin/src/core/evolution-logger.ts
    - packages/openclaw-plugin/src/core/event-log.ts

    For each mutable state item found, record:
    - File (relative to packages/openclaw-plugin/src/)
    - Export Name (the variable/constant name)
    - Type (e.g., "Map<string, Snapshot>", "EvolutionEngine", "let number")
    - Initialized By (where/how initialized: "lazy init in constructor", "module init", etc.)
    - Mutation Pattern (how it changes: "keys added/removed", "instance methods mutate state", etc.)
    - SPLIT annotation: which Phase 46 SPLIT requirement it maps to (SPLIT-01 through SPLIT-05)

    Also scan all files in packages/openclaw-plugin/src/core/ for import statements to build the dependency graph.
  </action>
  <verify>
    <automated>test -f .planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md && grep -c "^\| " .planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md</automated>
  </verify>
  <done>All module-level mutable state identified across 6 core files, categorized by type</done>
  <acceptance_criteria>
    - nocturnal-trinity.ts module-level mutable state documented
    - evolution-engine.ts module-level mutable state documented
    - evolution-migration.ts, rule-host.ts, evolution-logger.ts, event-log.ts mutable state checked
    - Each entry has: File, Export Name, Type, Initialized By, Mutation Pattern, SPLIT annotation
  </acceptance_criteria>
</task>

<task type="auto">
  <name>Task 2: Write mutable state inventory markdown tables and Mermaid import graph</name>
  <files>
    - .planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md
  </files>
  <read_first>
    - .planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md (created by Task 1 scan step — if not yet written, skip and create from scratch)
  </read_first>
  <action>
    Create the file .planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md with the following structure:

    ## Mutable State Inventory

    ### noctural-trinity.ts (2429L)
    | File | Export Name | Type | Initialized By | Mutation Pattern | SPLIT |
    |------|-------------|------|----------------|------------------|-------|
    | core/nocturnal-trinity.ts | [export name] | [type] | [how initialized] | [mutation pattern] | SPLIT-05 |

    [Repeat for each file that has module-level mutable state]

    ## Import Graph

    ```mermaid
    flowchart LR
        subgraph core
            NT[nocturnal-trinity.ts]
            EE[evolution-engine.ts]
            EM[evolution-migration.ts]
            RH[rule-host.ts]
            EL[evolution-logger.ts]
            EV[event-log.ts]
        end
        NT --> EE
        EE --> EM
        [add import edges based on actual imports found]
    ```

    The Mermaid graph must show file-level dependencies. Direction (LR/TD) is at your discretion.

    Key import relationships to identify (from scanning the source files):
    - evolution-engine.ts imports from: nocturnal-trinity.ts, evolution-migration.ts, rule-host.ts, evolution-logger.ts, event-log.ts
    - nocturnal-trinity.ts is primarily a leaf (called by evolution-engine.ts)
    - evolution-migration.ts handles queue file I/O (already somewhat isolated)
    - rule-host.ts is called by evolution-engine.ts

    Mark each node with its line count if known.
  </action>
  <verify>
    <automated>grep -E "^## Mutable State Inventory|^### .+\.ts|^\| File |^\|------|^\`\`\`mermaid|^    flowchart" .planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md</automated>
  </verify>
  <done>Markdown document contains: (1) section header "## Mutable State Inventory", (2) markdown table per file with columns File/Export/Type/Init/Mutation/SPLIT, (3) Mermaid flowchart LR or TD diagram showing import relationships</done>
  <acceptance_criteria>
    - Document has "## Mutable State Inventory" heading
    - At least one markdown table with columns: File, Export Name, Type, Initialized By, Mutation Pattern, SPLIT
    - Table includes nocturnal-trinity.ts entries
    - Table includes evolution-engine.ts entries
    - Document has Mermaid code block with flowchart showing file-level import dependencies
    - Import graph includes edges for evolution-engine.ts -> nocturnal-trinity.ts
  </acceptance_criteria>
</task>

</tasks>

<verification>
1. Document exists and is non-empty: wc -l .planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md
2. Contains inventory tables: grep -c "^\| " .planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md
3. Contains Mermaid graph: grep -c "^\`\`\`mermaid" .planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md
</verification>

<success_criteria>
1. .planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md exists with:
   - Markdown tables listing ALL module-level mutable state found in 6 core files
   - Each table row has: File, Export Name, Type, Initialized By, Mutation Pattern, SPLIT annotation
   - nocturnal-trinity.ts entries present (SPLIT-05)
   - evolution-engine.ts entries present (orchestrates all concerns)
   - evolution-migration.ts, rule-host.ts, evolution-logger.ts, event-log.ts entries present if mutable state found
2. Mermaid flowchart (```mermaid flowchart) showing file-level import dependencies for the god class candidates
3. Import graph correctly shows evolution-engine.ts as the orchestrator calling other modules
</success_criteria>

<output>
After completion, create .planning/phases/44-Pre-Split-Inventory/44-02-SUMMARY.md
</output>
