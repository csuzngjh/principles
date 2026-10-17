/**
 * PRI-1013 — the Codex governance health model must resolve the pd-cli entry
 * through the INSTALL LAYOUT authority, not through the npm dependency graph.
 *
 * Why these tests do not mock the model: `tests/server/routes/health-codex-
 * governance.test.ts` replaces this whole model with a `vi.mock` double, so the
 * real resolver's failure was structurally invisible in CI. On every installed
 * machine `require.resolve('@principles/pd-cli/package.json')` throws
 * MODULE_NOT_FOUND — console never declared that dependency — so the item
 * degraded forever with a nextAction telling the Owner to run a global
 * `npm i -g` this resolver could never read.
 *
 * Fixture installs are built under a temporary home by pinning `os.homedir()`
 * only; installed-layout, resolveInstallLayout and this model all run for real
 * (same harness as tests/models/health-check-model.test.ts).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CodexGovernanceHealthModel,
  resolvePdCliEntry,
} from '../../../src/server/models/CodexGovernanceHealthModel.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const realHomedir = actual.homedir.bind(actual);
  return { ...actual, homedir: vi.fn(() => realHomedir()) };
});

/** Marker no other pd-cli build could produce — proves WHICH entry ran. */
const FIXTURE_MARKER = 'FIXTURE-PD-CLI-ENTRY-1013';

let fakeHome: string;
let homedirPin: string;
let homedirRealImpl: (() => string) | undefined;
const savedOpenClawHome = process.env.OPENCLAW_HOME;

/**
 * Build a canonical flat install under `fakeHome`: <home>/.pd/install.json plus
 * <home>/.pd/runtime/<component>/… — the layout the installer delivers, where
 * components are SIBLING directories that are not reachable through each
 * other's npm dependency graph.
 */
function makeCanonicalInstall(): string {
  const runtimeDir = path.join(fakeHome, '.pd', 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, '.pd', 'install.json'),
    JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'] }),
  );
  return runtimeDir;
}

/** Deliver the sibling pd-cli entry as a file, as nothing, or as a directory. */
function makePdCliEntry(runtimeDir: string, mode: 'file' | 'absent' | 'directory'): string {
  const entry = path.join(runtimeDir, 'pd-cli', 'dist', 'index.js');
  if (mode === 'absent') return entry;
  if (mode === 'directory') {
    fs.mkdirSync(entry, { recursive: true });
    return entry;
  }
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  // Echo the argv it received (minus `node <entry>`) into `warnings` so the
  // test proves the production command line, and stamp generatedAt with a
  // marker unique to this fixture.
  fs.writeFileSync(entry, [
    'const argv = process.argv.slice(2);',
    'process.stdout.write(JSON.stringify({',
    "  status: 'ok',",
    `  generatedAt: '${FIXTURE_MARKER}',`,
    "  host: 'codex',",
    "  workspace: argv[argv.indexOf('--workspace') + 1] ?? '',",
    "  adapterVersion: 'fixture', runtimeVersion: 'fixture',",
    "  codexIngestionMinVersion: '0', codexIngestionVerifiedVersion: '0',",
    "  ingestionFlag: { enabled: true, source: 'fixture' },",
    "  consent: { state: 'granted' }, workspaceInit: { initialized: true },",
    '  hooksTrust: { detectable: false }, dualRegistration: { detected: false },',
    "  worker: { mode: 'fixture', registeredInInstallManifest: true },",
    '  rollouts: {}, observations: {}, admissions: {}, diagnosticianTasks: {},',
    '  ready: true, readyBlockers: [], warnings: argv,',
    '}, null, 2));',
    '',
  ].join('\n'));
  return entry;
}

function pinHome(dir: string): void {
  vi.mocked(os.homedir).mockImplementation(() => dir);
}

/**
 * A minimal stand-in for the production CLI's exit/stdout behaviour, used to
 * pin the contract the model reads (cli-1 one JSON object on stdout, cli-2 exit
 * 1 when the report says not ready). Passed as `cliEntryOverride`, so these
 * cases exercise the report half of the model without an install fixture.
 */
function writeCliScript(dir: string, source: string): string {
  const entry = path.join(dir, 'index.js');
  fs.writeFileSync(entry, source);
  return entry;
}

async function collectDegraded(runtimeDirEntry: string) {
  pinHome(fakeHome);
  const result = await new CodexGovernanceHealthModel(path.join(fakeHome, 'workspace')).collect();
  expect(result.status).toBe('unknown');
  if (result.status !== 'unknown') throw new Error(`expected unknown, got ${result.status}`);
  expect(result.ready).toBe(false);
  expect(result.productClaim).toBe('degraded');
  expect(result.readyBlockers).toEqual([`health_collection_failed: ${result.reason}`]);
  expect(result.nextAction).toContain(runtimeDirEntry);
  return result;
}

describe('CodexGovernanceHealthModel pd-cli entry resolution (PRI-1013)', () => {
  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-1013-home-'));
    // Keep the legacy extension dir inside the fixture home so a real install
    // on the machine running the tests cannot leak into layout resolution.
    process.env.OPENCLAW_HOME = path.join(fakeHome, '.openclaw');
    homedirPin = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-1013-homedir-'));
    const homedirMock = vi.mocked(os.homedir);
    homedirRealImpl = homedirMock.getMockImplementation();
    pinHome(homedirPin);
  });

  afterEach(() => {
    const homedirMock = vi.mocked(os.homedir);
    if (homedirRealImpl) homedirMock.mockImplementation(homedirRealImpl);
    else homedirMock.mockReset();
    if (savedOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = savedOpenClawHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(homedirPin, { recursive: true, force: true });
  });

  it('executes the pd-cli entry delivered beside the runtime, not the dev-tree package', async () => {
    const workspaceDir = path.join(fakeHome, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    const entry = makePdCliEntry(makeCanonicalInstall(), 'file');
    pinHome(fakeHome);

    const result = await new CodexGovernanceHealthModel(workspaceDir).collect();

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // Pre-PRI-1013 this resolved through the monorepo's node_modules link and
    // ran the real pd-cli, so the fixture marker below could never appear.
    expect(result.health.generatedAt).toBe(FIXTURE_MARKER);
    expect(result.health.host).toBe('codex');
    // The production command line is unchanged (cli-1: same --json invocation).
    expect(result.health.warnings).toEqual(
      expect.arrayContaining(['health', '--host', 'codex', '--workspace', workspaceDir, '--json']),
    );
    expect(entry).toBe(path.join(fakeHome, '.pd', 'runtime', 'pd-cli', 'dist', 'index.js'));
  });

  it('degrades with an install-specific reason when the resolved entry is absent', async () => {
    const entry = makePdCliEntry(makeCanonicalInstall(), 'absent');

    const result = await collectDegraded(entry);

    expect(result.reason).toBe('pd_cli_entry_missing');
    expect(result.nextAction).toContain('create-principles-disciple');
    expect(result.nextAction).not.toMatch(/npm i -g|npm install -g/);
  });

  it('degrades with a distinct reason when the entry exists but is not a regular file', async () => {
    const entry = makePdCliEntry(makeCanonicalInstall(), 'directory');

    const result = await collectDegraded(entry);

    expect(result.reason).toBe('pd_cli_entry_invalid');
  });

  it('falls back to the workspace package graph only when no install layout resolves', () => {
    // homedirPin is an empty temp home: no ~/.pd/install.json, no canonical
    // runtime, no legacy extension dir → layout mode 'missing'. The dev tree
    // must still resolve the in-repo pd-cli, or this fix would regress local
    // and CI health instead of repairing the installed case.
    const resolution = resolvePdCliEntry();

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(path.normalize(resolution.entry)).toContain(
      path.normalize(path.join('packages', 'pd-cli', 'dist', 'index.js')),
    );
    expect(path.resolve(resolution.entry)).not.toContain(path.normalize(fakeHome));
  });

  // PRI-1013, second half of the same symptom: on a machine whose Codex host is
  // disabled the CLI EXITS 1 while printing a complete report (cli-2 — the exit
  // code IS the not-ready signal). Treating that as a collection failure hid the
  // real blockers behind a constant, exactly like the unresolved entry did.
  it('keeps a not-ready report produced by an exit-1 CLI run as a real report', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-1013-cli-'));
    const entry = writeCliScript(dir, [
      'process.stdout.write(JSON.stringify({',
      "  generatedAt: 'fixture', host: 'codex', workspace: 'fixture',",
      "  ready: false, readyBlockers: ['host.codex: disabled', 'worker: host_codex_disabled'],",
      '  warnings: [],',
      '}));',
      'process.exitCode = 1;',
      '',
    ].join('\n'));

    const result = await new CodexGovernanceHealthModel(dir, entry).collect();

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.health.ready).toBe(false);
    expect(result.health.readyBlockers).toEqual(['host.codex: disabled', 'worker: host_codex_disabled']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('degrades when an exit-1 run prints a rejection instead of a report (no ready field)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-1013-cli-'));
    const entry = writeCliScript(dir, [
      "process.stdout.write(JSON.stringify({ ok: false, reason: 'invalid_host', host: 'codex', nextAction: 'use --host' }));",
      'process.exitCode = 1;',
      '',
    ].join('\n'));

    const result = await new CodexGovernanceHealthModel(dir, entry).collect();

    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') return;
    expect(result.reason).toBe('health_collection_failed');
    expect(result.nextAction).toContain('pd health --host codex');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('degrades with a distinct reason when a successful run prints something that is not the JSON contract', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-1013-cli-'));
    const entry = writeCliScript(dir, "process.stdout.write('human-readable banner, not the --json contract\\n');\n");

    const result = await new CodexGovernanceHealthModel(dir, entry).collect();

    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') return;
    // rc-9: "the CLI ran but broke its own output contract" must not be filed
    // under the same reason as "the CLI could not run".
    expect(result.reason).toBe('report_unusable');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
