// PRI-920 Guard A tests: the writer-boundary scan must be a discriminating
// gate, not a list echo. Negative controls follow ERR-146/EP-09:
// every allowlist entry is proven to trip the predicate today (no rot), a
// synthetic out-of-authority writer is proven to redden, and the exclusions
// (authority dir, test files, read-only consumers, state-only writers) are
// proven to stay green.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_RUNTIME_WRITERS,
  collectScopeFiles,
  evaluateRuntimeWriters,
  scanRuntimeWriters,
} from '../check-runtime-writers.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const WRITER_BODY = [
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync(join(home, '.pd', 'install.json'), '{}');",
].join('\n');
const READER_BODY = [
  "import { readFileSync } from 'node:fs';",
  "export const layout = JSON.parse(readFileSync('install.json', 'utf8'));",
].join('\n');
const STATE_WRITER_BODY = [
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync(join(workspace, '.pd', 'config.yaml'), 'telemetry: off');",
].join('\n');
// PRI-920 review: the async fs/promises forms must trip the predicate too —
// a future runtime writer using only rm/mkdir/rename must not bypass the scan.
const ASYNC_WRITER_BODY = [
  "import { mkdir, rename, rm } from 'node:fs/promises';",
  'export async function mutate(runtimeDir) {',
  '  await mkdir(runtimeDir, { recursive: true });',
  "  await rename(runtimeDir + '.old', runtimeDir);",
  "  await rm(runtimeDir + '/stale', { recursive: true });",
  '}',
].join('\n');
// Word-boundary control: confirm( / arm( contain the literal `rm(` but are
// not call sites; they must not flag a file that only READS the runtime.
const LOOKALIKE_BODY = [
  'export function confirmLayout(runtimeDir) {',
  "  const armed = confirm('arm(' + runtimeDir);",
  '  return armed;',
  '}',
].join('\n');

const sandboxes: string[] = [];
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rw-gate-'));
  sandboxes.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe('real-repository baseline (SSoT two-way check)', () => {
  it('has no unauthorized runtime writers and no stale allowlist entries', () => {
    const r = evaluateRuntimeWriters(REPO_ROOT);
    expect(r.unauthorized).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  it('every ALLOWED_RUNTIME_WRITERS entry exists and trips the predicate (ERR-146)', () => {
    const { flagged } = scanRuntimeWriters(REPO_ROOT);
    expect([...flagged].sort()).toEqual(ALLOWED_RUNTIME_WRITERS.map((e) => e.file).sort());
    for (const entry of ALLOWED_RUNTIME_WRITERS) {
      expect(entry.reason.length, `allowlist entry ${entry.file} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('reports scope with forward-slash relative paths only', () => {
    for (const rel of collectScopeFiles(REPO_ROOT)) {
      expect(rel).not.toContain('\\');
    }
  });
});

describe('negative controls on synthetic repositories', () => {
  it('flags an out-of-authority runtime writer', () => {
    const root = makeRepo({ 'packages/evil/src/steal.mjs': WRITER_BODY });
    const r = evaluateRuntimeWriters(root, []);
    expect(r.flagged).toEqual(['packages/evil/src/steal.mjs']);
    expect(r.unauthorized).toEqual(['packages/evil/src/steal.mjs']);
  });

  it('flags async fs mutation primitives (rm/mkdir/rename) beside a runtime token', () => {
    const root = makeRepo({ 'packages/evil/src/async-steal.mjs': ASYNC_WRITER_BODY });
    const { flagged } = scanRuntimeWriters(root);
    expect(flagged).toEqual(['packages/evil/src/async-steal.mjs']);
  });

  it('does not flag word look-alikes of the async primitives', () => {
    const root = makeRepo({ 'packages/evil/src/dialog.ts': LOOKALIKE_BODY });
    const { flagged } = scanRuntimeWriters(root);
    expect(flagged).toEqual([]);
  });

  it('scans .cts and .tsx production files (PRI-920 review scope nitpick)', () => {
    const root = makeRepo({
      'packages/evil/src/preload.cts': ASYNC_WRITER_BODY,
      'packages/evil/src/panel.tsx': WRITER_BODY,
    });
    const { flagged } = scanRuntimeWriters(root);
    expect([...flagged].sort()).toEqual(['packages/evil/src/panel.tsx', 'packages/evil/src/preload.cts']);
  });

  it('does not flag the same code inside the installer authority', () => {
    const root = makeRepo({
      'packages/create-principles-disciple/src/legit.mjs': WRITER_BODY,
    });
    const { flagged } = scanRuntimeWriters(root);
    expect(flagged).toEqual([]);
  });

  it('does not flag test-owned files (fake/synthetic homes)', () => {
    const root = makeRepo({
      'packages/evil/tests/fixtures.mjs': WRITER_BODY,
      'packages/evil/src/helper.test.mjs': WRITER_BODY,
      'packages/evil/src/__tests__/scan.test.ts': WRITER_BODY,
    });
    const { flagged } = scanRuntimeWriters(root);
    expect(flagged).toEqual([]);
  });

  it('does not flag a runtime reader (token without mutation)', () => {
    const root = makeRepo({ 'packages/evil/src/reader.ts': READER_BODY });
    const { flagged } = scanRuntimeWriters(root);
    expect(flagged).toEqual([]);
  });

  it('does not flag a workspace-state writer (.pd state root, not runtime)', () => {
    const root = makeRepo({ 'packages/evil/src/state.ts': STATE_WRITER_BODY });
    const { flagged } = scanRuntimeWriters(root);
    expect(flagged).toEqual([]);
  });

  it('fails on a stale allowlist entry whose file no longer trips', () => {
    const root = makeRepo({ 'packages/evil/src/reader.ts': READER_BODY });
    const r = evaluateRuntimeWriters(root, [{ file: 'packages/evil/src/ghost.mjs', reason: 'gone' }]);
    expect(r.stale).toEqual(['packages/evil/src/ghost.mjs']);
    expect(r.unauthorized).toEqual([]);
  });

  it('passes when the synthetic writer is allowlisted', () => {
    const root = makeRepo({ 'packages/evil/src/steal.mjs': WRITER_BODY });
    const r = evaluateRuntimeWriters(root, [
      { file: 'packages/evil/src/steal.mjs', reason: 'fixture writer under a fake home' },
    ]);
    expect(r.unauthorized).toEqual([]);
    expect(r.stale).toEqual([]);
  });
});
