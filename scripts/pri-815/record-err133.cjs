// One-shot: record ERR-133 into the Error Experience Handbook (AGENTS.md §14).
const fs = require('node:fs');
const p = 'docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md';
let h = fs.readFileSync(p, 'utf8');
if (h.includes('**[ERR-133]**')) { console.log('ERR-133 already present'); process.exit(0); }

const row = '| ERR-133 | Experiment tooling mutated evidence via import side effect: a script that is both module and CLI was imported for a constant, executing its top-level experiment driver and overwriting 3 groups\' raw data files | PRI-815 Phase A |\n';
const rowAnchor = h.indexOf('| ERR-131 |');
const rowLineEnd = h.indexOf('\n', rowAnchor);
h = h.slice(0, rowLineEnd + 1) + row + h.slice(rowLineEnd + 1);

const entry = `
---
**[ERR-133]** | Experiment tooling mutated evidence via import side effect — a file used as both module and CLI ran its top-level experiment driver when imported for a constant, overwriting raw evidence files

- **What happened**: In the PRI-815 Phase A harness, the report generator imported \`run-ab.mjs\` to reuse the exported B-arm addendum constant. That file is dual-use: exported constants AND a top-level CLI driver (reads \`process.argv\`, launches the experiment loop at module scope). The import executed the driver, which found 3 run files not matching its completeness predicate, re-ran those groups against the real LLM, and OVERWROTE their raw evidence files before the process was killed.
- **Why it's wrong**: Evidence/audit artifacts are frozen inputs (experiment SPEC §8/§12); a read-only reporting tool must be structurally incapable of mutating them. Import-for-constant is an invisible execution path — nobody "runs" anything, yet the driver executes. Cached judgments survived, but the overwritten raws are unrecoverable.
- **Correct approach**: Constants shared between a driver script and other tooling live in a separate side-effect-free module (\`b-addendum.mjs\`); the driver imports from it. Guard evidence immutability structurally: report/judge tooling opens evidence read-only, or asserts evidence hashes/mtimes unchanged after a report run.
- **How to prevent**: Before importing any script, check it for module-scope side effects (driver loops, \`process.argv\` reads). Rule of thumb: a file that reads \`process.argv\` at top level is a CLI — never import it; extract shared exports into a plain module first.
- **Regression guard**: none mechanized (one-off experiment tooling); structural fix = import-safe module split, committed in the same PR.
- **Related ERRs**: ERR-024 (side-effect/write discipline), EP-05 (evidence & tooling hazards)
- **Source**: PRI-815 Phase A data incident 2026-09-17 (disclosed in docs/audit/pri-815-quality-first/PHASE_A_REPORT.md)
- **Date**: 2026-09-18
- **Recurrence**: None

  <!-- recurrence-meta
  {
    "date": "2026-09-18",
    "pattern": "EP-05",
    "invariant": "evidence-immutability-under-read-only-tooling",
    "severity": "P2",
    "escaped": "none",
    "caughtBy": "self-review",
    "guard": "import-safe module split (b-addendum.mjs); no mechanized guard"
  }
  -->
`;
h = h.replace(/\n*$/, '\n') + entry;
fs.writeFileSync(p, h);
console.log('handbook updated, bytes:', Buffer.byteLength(h));

// INDEX: add ERR-133 to EP-05 representative ERRs
const ip = 'docs/process/error-management/ERROR_PATTERN_INDEX.md';
let idx = fs.readFileSync(ip, 'utf8');
const rep = 'ERR-126, ERR-131.';
if (idx.includes(rep) && !idx.includes('ERR-133')) {
  idx = idx.replace(rep, 'ERR-126, ERR-131, ERR-133.');
  fs.writeFileSync(ip, idx);
  console.log('index updated');
} else {
  console.log('index anchor not found or already referenced — manual check needed');
}
