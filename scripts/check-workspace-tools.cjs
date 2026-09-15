#!/usr/bin/env node
// Workspace-tools gate (PRI-796, SPEC §22).
//
// The worktree lifecycle tools guard other people's work, so they need a guard
// of their own: without one, the next refactor can quietly delete the mutex
// around a `git worktree remove`, drop the `--ack-unknown` requirement, or
// reintroduce a hardcoded drive path — and everything would still "pass".
//
// Every check below is a structural invariant of the tools, not of the product:
// they read source text and package.json, never run git. That keeps the gate fast
// enough to sit in verify:merge and deterministic enough to be trustworthy.
//
// A failure here means one of the invariants below was broken. The message names
// which one and where.

const fs = require('node:fs');
const path = require('node:path');

// `--root <dir>` lets the gate's own test run it against a fixture whose
// invariants are deliberately broken. Without that, a gate that quietly stopped
// checking anything (bad path, renamed file) would keep reporting "passed" and
// nobody would notice.
const rootArgIndex = process.argv.indexOf('--root');
const ROOT = rootArgIndex === -1 ? path.resolve(__dirname, '..') : path.resolve(process.argv[rootArgIndex + 1]);
const DEV = path.join(ROOT, 'scripts', 'dev');
const LIB = path.join(DEV, 'lib');

const violations = [];
const fail = (invariant, detail) => violations.push({ invariant, detail });

// ---------------------------------------------------------------------------
// A. The documented npm surface exists and points at real files (SPEC §24).
// ---------------------------------------------------------------------------
const EXPECTED_SCRIPTS = [
  'dev:worktree',
  'dev:worktree:bootstrap',
  'dev:worktree:ready',
  'dev:worktree:claim',
  'dev:worktree:release',
  'dev:worktree:check',
  'dev:worktree:cleanup',
  'dev:workspace:snapshot',
  'dev:workspace:migrate',
  'dev:workspace:cleanup',
  'check:workspace-tools',
];

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
for (const name of EXPECTED_SCRIPTS) {
  const command = pkg.scripts?.[name];
  if (typeof command !== 'string') {
    fail('npm-surface', `package.json is missing the script "${name}"`);
    continue;
  }
  const match = /node\s+(\S+\.(?:mjs|cjs|js))/.exec(command);
  if (!match) {
    fail('npm-surface', `script "${name}" does not invoke a node entry file: ${command}`);
    continue;
  }
  const entry = path.resolve(ROOT, match[1]);
  if (!fs.existsSync(entry)) {
    fail('npm-surface', `script "${name}" points at a missing file: ${match[1]}`);
  }
}

// ---------------------------------------------------------------------------
// B. The gate protects itself from the first change onwards (SPEC §22).
// ---------------------------------------------------------------------------
if (!String(pkg.scripts?.['verify:merge'] || '').includes('check:workspace-tools')) {
  fail('merge-gate', 'verify:merge does not run check:workspace-tools');
}

// ---------------------------------------------------------------------------
// C. No hardcoded workstation paths (SPEC D2: the pool is DERIVED).
// ---------------------------------------------------------------------------
/**
 * Strip comments before scanning for forbidden patterns.
 *
 * Without this the checks fire on DOCUMENTATION — a module that explains the
 * layout with an example path, or that justifies itself with "why not
 * fs.rmSync(recursive)" — which would make the honest comment the violation and
 * push authors toward saying less. Only executable text should be judged.
 *
 * The `//` handling is a deliberate heuristic: a `//` preceded by `:` is left
 * alone so `https://` inside a string is not treated as a comment.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/gu, '$1');
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'pipeline-closure-lab' || entry.name === 'pipeline-evolution') continue;
      walkFiles(full, out);
    } else if (/\.(mjs|cjs|js|ts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const devFiles = walkFiles(DEV);
const HARDCODED = [
  { re: /[A-Za-z]:[\\/]+Code[\\/]/u, why: 'a hardcoded D:\\Code-style path — the worktree pool must be derived from the primary checkout' },
  { re: /[A-Za-z]:[\\/]+Users[\\/]/u, why: 'a hardcoded user-home path — resolve it via os.homedir() instead' },
];
for (const file of devFiles) {
  stripComments(fs.readFileSync(file, 'utf8'))
    .split(/\r?\n/u)
    .forEach((line, index) => {
      for (const { re, why } of HARDCODED) {
        if (re.test(line)) {
          fail('no-hardcoded-paths', `${path.relative(ROOT, file)}:${index + 1} contains ${why}`);
        }
      }
    });
}

// ---------------------------------------------------------------------------
// D. Junction safety is structural, not a comment (SPEC §16).
//    The residue deleter must decide with lstat and detach links, and must never
//    hand the tree to a recursive remover that could follow a reparse point.
// ---------------------------------------------------------------------------
const residueDeleter = path.join(LIB, 'residue-delete.mjs');
if (!fs.existsSync(residueDeleter)) {
  fail('junction-safety', 'scripts/dev/lib/residue-delete.mjs is missing');
} else {
  const text = stripComments(fs.readFileSync(residueDeleter, 'utf8'));
  for (const required of ['lstatSync', 'isSymbolicLink', 'readlinkSync', 'unlinkSync']) {
    if (!text.includes(required)) {
      fail('junction-safety', `residue-delete.mjs no longer uses ${required} — reparse points must be detected and detached explicitly`);
    }
  }
  for (const forbidden of ['fs.rmSync(', 'rm -rf']) {
    if (text.includes(forbidden)) {
      fail('junction-safety', `residue-delete.mjs contains "${forbidden}" — a recursive remover can follow a junction into the primary checkout`);
    }
  }
  if (!/targetStillExists/u.test(text)) {
    fail('junction-safety', 'residue-delete.mjs no longer re-checks an external target after detaching a link');
  }
}

// ---------------------------------------------------------------------------
// E. UNKNOWN residue is never removed without an explicit acknowledgement
//    (SPEC D6 / §15.3).
// ---------------------------------------------------------------------------
const batchCleanup = path.join(DEV, 'workspace-cleanup.mjs');
if (!fs.existsSync(batchCleanup)) {
  fail('unknown-never-auto-deleted', 'scripts/dev/workspace-cleanup.mjs is missing');
} else {
  const text = stripComments(fs.readFileSync(batchCleanup, 'utf8'));
  if (!text.includes('--ack-unknown')) {
    fail('unknown-never-auto-deleted', 'workspace-cleanup.mjs no longer mentions --ack-unknown');
  }
  if (!/ackUnknown/u.test(text)) {
    fail('unknown-never-auto-deleted', 'workspace-cleanup.mjs no longer gates residue deletion on the ack flag');
  }
  const ackGateIndex = text.indexOf('if (!args.ackUnknown)');
  const deleteIndex = text.indexOf('removeResidueTree(');
  if (ackGateIndex === -1 || deleteIndex === -1 || ackGateIndex > deleteIndex) {
    fail('unknown-never-auto-deleted', 'the --ack-unknown check no longer runs before removeResidueTree()');
  }
}

// ---------------------------------------------------------------------------
// F. No background service sneaks in (SPEC §26: no daemon / watcher).
// ---------------------------------------------------------------------------
for (const file of devFiles) {
  const text = stripComments(fs.readFileSync(file, 'utf8'));
  for (const forbidden of ['setInterval(', 'detached: true', 'fs.watch(']) {
    if (text.includes(forbidden)) {
      fail('no-background-service', `${path.relative(ROOT, file)} contains "${forbidden}" — the worktree tools must not run background work`);
    }
  }
}

// ---------------------------------------------------------------------------
// G. Every shared-Git-metadata mutation is serialised (SPEC §4 / git-12).
//    A tool that runs `git worktree add|move|remove|prune` (or deletes a branch)
//    without the mutex is the exact concurrency bug this change exists to fix.
// ---------------------------------------------------------------------------
const MUTATING = [
  /'worktree',\s*'add'/u,
  /'worktree',\s*'move'/u,
  /'worktree',\s*'remove'/u,
  /'worktree',\s*'prune'/u,
  /'branch',\s*'-D'/u,
];
for (const file of devFiles) {
  const text = fs.readFileSync(file, 'utf8');
  if (!MUTATING.some((re) => re.test(text))) continue;
  if (!text.includes('withMutationLock')) {
    fail(
      'git-mutation-mutex',
      `${path.relative(ROOT, file)} runs a shared-Git-metadata mutation without withMutationLock()`
    );
  }
}

// ---------------------------------------------------------------------------
// H. The governance IDs this change introduced are actually documented.
// ---------------------------------------------------------------------------
const agentsPath = path.join(ROOT, 'AGENTS.md');
if (!fs.existsSync(agentsPath)) {
  fail('governance-ids', 'AGENTS.md is missing');
} else {
  const text = fs.readFileSync(agentsPath, 'utf8');
  for (const id of ['git-10', 'git-11', 'git-12', 'git-13', 'git-14']) {
    // Delimited, not substring: a substring check would accept a renamed
    // `git-14x` as if `git-14` were still documented (and would let `git-1`
    // satisfy every `git-1x`). The ID may legitimately be followed by the rest
    // of its heading slug (`git-14-unknown-residue-…`), so only an alphanumeric
    // continuation counts as a different identifier.
    const delimited = new RegExp('`' + id + '(?![A-Za-z0-9])');
    if (!delimited.test(text)) {
      fail('governance-ids', `AGENTS.md §23A does not define the stable ID \`${id}`);
    }
  }
  for (const writer of ['workbuddy', 'codex', 'zcode', 'trae']) {
    if (!text.includes(writer)) {
      fail('governance-ids', `AGENTS.md §23A does not document the writer label "${writer}"`);
    }
  }
}

// ---------------------------------------------------------------------------
if (violations.length > 0) {
  console.error('Workspace tools gate failed:');
  for (const violation of violations) {
    console.error(`- [${violation.invariant}] ${violation.detail}`);
  }
  process.exit(1);
}

console.log('Workspace tools gate passed.');
