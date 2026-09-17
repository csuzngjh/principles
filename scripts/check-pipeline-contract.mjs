#!/usr/bin/env node
// PD Pipeline Safety Net v1.2 — thin merge-time contract aggregator (PRI-807 / PRI-828)
//
// What this is: SELECT existing focused vitest tests, RUN them through each
// package's real vitest config, PROPAGATE exit codes, print a minimal claim
// summary. That is all.
//
// What this deliberately is NOT: a test registry, a result database, a DSL,
// a scanner framework, an AST checker, or a second source of truth. The only
// durable artifact is the manifest below + the summary it prints.
//
// C0 (test discoverability): each group is executed via vitest path filters
// against the package's own vitest config. In `vitest run` mode a filter that
// matches no collected file exits non-zero ("No test files found"), so a
// Safety Net test that stops being collected — or a file renamed out from
// under the manifest — cannot silently pass. File existence is additionally
// pre-checked for a clearer nextAction.
//
// Determinism: no network, no API keys, no real LLM, no real host process.
// The selected tests use scripted adapters and temp SQLite workspaces only.
//
// Prerequisites: `npm run build --workspace=@principles/core` (the openclaw-plugin
// tests import `@principles/core/runtime-v2` from dist). verify:merge runs this
// after the full workspace build, so the prerequisite holds on the merge path.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Selection manifest ─────────────────────────────────────────────────────
// One entry per focused vitest invocation. Groups map to the Safety Net
// invariants (I1..I6) and golden journeys (J1/J2/J4) defined in
// docs/audit/pri-807-safety-net/SAFETY_NET_REUSE_MATRIX.md.

const GROUPS = [
  {
    id: 'j1-formation-e2e',
    label: 'Formation wiring + provenance (J1/J2 backbone)',
    pkgDir: 'packages/openclaw-plugin',
    invariants: ['I1', 'I2', 'I5'],
    journeys: ['J1', 'J2'],
    filters: [
      'tests/integration/rulehost-seed-mvp-e2e.test.ts',
      'tests/integration/pain-id-chain-e2e.test.ts',
    ],
    timeoutMs: 420_000,
    expect:
      'formal pain input reaches production formation wiring and produces a governable artifact; pain ids stay traceable into rules and blocks',
  },
  {
    id: 'host-adapter-boundary',
    label: 'Runtime consumer boundary — host hook + blockReason',
    pkgDir: 'packages/openclaw-plugin',
    invariants: ['I5'],
    journeys: ['J2'],
    filters: [
      'tests/hooks/gate-rule-host-real-pipeline.test.ts',
      'tests/hooks/gate-rule-host-pipeline.test.ts',
    ],
    timeoutMs: 240_000,
    expect:
      'activated RuleCode reaches the production host hook boundary with a consumer-visible block decision and reason',
  },
  {
    id: 'prompt-exposure-boundary',
    label: 'Principle prompt exposure + authority attribution',
    pkgDir: 'packages/openclaw-plugin',
    invariants: ['I3', 'I5', 'I6'],
    journeys: ['J1'],
    filters: [
      'tests/hooks/runtime-v2-prompt-triple-proof.test.ts',
      'tests/hooks/runtime-v2-prompt-activation.test.ts',
    ],
    timeoutMs: 300_000,
    expect:
      'activated principles reach the production prompt boundary; owner vs system_policy is attributed correctly; a recycled artifact cannot ride an old activation',
  },
  {
    id: 'revocation-precision',
    label: 'Precise revocation on a live instance (J4)',
    pkgDir: 'packages/openclaw-plugin',
    invariants: ['I6'],
    journeys: ['J4'],
    filters: ['tests/core/rule-host-cache-invalidation.test.ts'],
    timeoutMs: 240_000,
    expect:
      'revoking intervention A stops A on the same live runtime while B stays effective; no restart required',
  },
  {
    id: 'governance-contract',
    label: 'Authorization boundary + governance idempotency/recovery',
    pkgDir: 'packages/principles-core',
    invariants: ['I3', 'I4'],
    journeys: ['J1', 'J2'],
    filters: [
      'src/runtime-v2/activation/__tests__/sqlite-activation-safety-store.test.ts',
      'src/runtime-v2/activation/__tests__/activation-dispatcher.test.ts',
      'src/runtime-v2/activation/__tests__/approval-completion-service.test.ts',
      'src/runtime-v2/activation/__tests__/rulecode-owner-decision-service.test.ts',
      'src/runtime-v2/activation/__tests__/promotion-readiness-evaluator.test.ts',
      'src/runtime-v2/activation/__tests__/promotion-readiness-reader.test.ts',
      'src/runtime-v2/activation/writers/__tests__/rule-host-writer.test.ts',
      'src/runtime-v2/activation/__tests__/story-a-acceptance.test.ts',
    ],
    timeoutMs: 420_000,
    expect:
      'owner authority required where policy says owner; observation never promotes; duplicate/stale governance commits are refused or idempotent; recovery never regains live authority',
  },
  {
    id: 'formation-governance',
    label: 'Internalization governance journeys',
    pkgDir: 'packages/principles-core',
    invariants: ['I1', 'I4'],
    journeys: [],
    filters: [
      'src/runtime-v2/internalization/__tests__/mvp-core-loop-journeys.test.ts',
      'src/runtime-v2/internalization/__tests__/diag-chain-e2e.test.ts',
    ],
    timeoutMs: 420_000,
    expect:
      'verdict-driven transitions stay wired through the canonical funnel; diagnosis from pain signals validates against current schemas',
  },
];

const INVARIANT_LABELS = {
  I1: 'Formation wiring',
  I2: 'Provenance / identity',
  I3: 'Authorization boundary',
  I4: 'Governance idempotency / recovery',
  I5: 'Runtime consumer boundary',
  I6: 'Precise revocation',
};

// ── Preconditions ──────────────────────────────────────────────────────────

function failFast(message, nextAction) {
  process.stderr.write(`[check:pipeline-contract] ${message}\nNext action: ${nextAction}\n`);
  process.exit(1);
}

const vitestEntry = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
if (!fs.existsSync(vitestEntry)) {
  failFast(
    'vitest is not installed at the repository root.',
    'run `npm install` (or `npm run dev:worktree:bootstrap` in a task worktree) and retry.',
  );
}
const coreDist = path.join(ROOT, 'packages', 'principles-core', 'dist');
if (!fs.existsSync(coreDist)) {
  failFast(
    '@principles/core has no dist build — the selected openclaw-plugin tests import `@principles/core/runtime-v2` from dist.',
    'run `npm run build --workspace=@principles/core` and retry.',
  );
}

// ── Execution ──────────────────────────────────────────────────────────────

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

function lastSummaryLines(output, maxLines = 6) {
  const lines = stripAnsi(output).split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(-maxLines).join('\n');
}

function parseTestFileLine(output) {
  const m = stripAnsi(output).match(/Test Files\s+([^\n]+)/);
  return m ? m[1].trim() : null;
}

const results = [];
let failed = false;

for (const group of GROUPS) {
  const cwd = path.join(ROOT, group.pkgDir);
  const missing = group.filters.filter((f) => !fs.existsSync(path.join(cwd, f)));
  if (missing.length > 0) {
    failed = true;
    results.push({ group, status: 'FAIL', detail: `missing file(s): ${missing.join(', ')}` });
    continue;
  }
  process.stdout.write(`[check:pipeline-contract] ${group.id} — running ${group.filters.length} test file(s)...\n`);
  const startedAt = Date.now();
  try {
    const output = execFileSync(
      process.execPath,
      [vitestEntry, 'run', ...group.filters],
      { cwd, timeout: group.timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    );
    const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
    results.push({ group, status: 'PASS', detail: parseTestFileLine(output) ?? '', durationS });
    process.stdout.write(`[check:pipeline-contract] ${group.id} — PASS (${durationS}s)\n`);
  } catch (err) {
    failed = true;
    const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
    const output = typeof err.stdout === 'string' ? err.stdout : '';
    const killed = Boolean(err.killed) || /timed out/.test(String(err.message ?? ''));
    results.push({
      group,
      status: 'FAIL',
      durationS,
      detail: killed ? 'vitest invocation timed out' : lastSummaryLines(output),
      output: stripAnsi(output).split(/\r?\n/).slice(-60).join('\n'),
    });
    process.stdout.write(`[check:pipeline-contract] ${group.id} — FAIL (${durationS}s)\n`);
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

function invariantVerdict(tag) {
  const relevant = results.filter((r) => r.group.invariants.includes(tag));
  if (relevant.length === 0) return 'UNVERIFIED';
  return relevant.every((r) => r.status === 'PASS') ? 'PASS' : 'FAIL';
}

function journeyVerdict(tag) {
  const relevant = results.filter((r) => r.group.journeys.includes(tag));
  if (relevant.length === 0) return 'UNVERIFIED';
  return relevant.every((r) => r.status === 'PASS') ? 'PASS' : 'FAIL';
}

const width = 38;
function row(label, verdict) {
  return `${label.padEnd(width)}${verdict}`;
}

process.stdout.write('\nPD Pipeline Safety Net v1.2\n\n');
// C0 fails only when discovery itself is broken (group missing from results,
// or a manifest file that no longer exists / is no longer collected). Red
// groups surface through the I-rows below.
const discoveryBroken =
  results.length !== GROUPS.length || results.some((r) => r.detail?.startsWith('missing file(s)'));
process.stdout.write(`${row('C0 Test execution', discoveryBroken ? 'FAIL' : 'PASS')}\n`);
for (const [tag, label] of Object.entries(INVARIANT_LABELS)) {
  process.stdout.write(`${row(`I${tag.slice(1)} ${label}`, invariantVerdict(tag))}\n`);
}
process.stdout.write('\n');
for (const j of ['J1', 'J2', 'J4']) {
  process.stdout.write(`${row(j, journeyVerdict(j))}\n`);
}
process.stdout.write(
  '\nKnown historical evidence gaps (reported, intentionally NOT fixed by the Safety Net):\n' +
  '  - approved historical artifact digest        KNOWN_GAP\n' +
  '  - executed historical artifact digest        KNOWN_GAP\n' +
  '  - exact Principle historical revision digest KNOWN_GAP\n' +
  '\nClaim boundary: merge-time mechanical contract only. This does NOT prove\n' +
  'installed-runtime correctness, real host registration, real agent feedback\n' +
  'comprehension, or absence of unknown writers.\n\n',
);

if (failed) {
  process.stdout.write('Result: FAIL\n\n');
  // SPEC §12 — failure diagnostics with entrypoint/expected/actual/nextAction
  for (const r of results.filter((x) => x.status === 'FAIL')) {
    process.stdout.write(`FAIL ${r.group.label}\n\n`);
    process.stdout.write(`Entry:\n  cd ${r.group.pkgDir} && node <root>/node_modules/vitest/vitest.mjs run ${r.group.filters.join(' ')}\n\n`);
    process.stdout.write(`Expected:\n  ${r.group.expect}\n\n`);
    process.stdout.write(`Actual:\n${r.detail ? `  ${r.detail}\n` : ''}${r.output ? `${r.output.split('\n').map((l) => `  ${l}`).join('\n')}\n` : '  (no output captured)\n'}\n`);
    process.stdout.write('NextAction:\n  reproduce the command above; fix the broken production wiring or contract\n' +
      '  it protects — do not weaken the assertion or remove the file from the\n' +
      '  Safety Net manifest to make it green.\n\n');
  }
  process.exit(1);
}

process.stdout.write('Result: PASS — merge-time mechanical contract only\n');
