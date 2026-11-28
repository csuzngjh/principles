/**
 * Service-Host-only boundary guard.
 *
 * The Electron main process cannot be imported in vitest without starting the
 * application, so this guard proves the negative at the production-source
 * boundary instead: worker reintroduction must either add a child_process call
 * (caught by the AST scan), change the single remaining Console spawn away
 * from its Console-only argv, or restore one of the worker protocol/module
 * names below. Each path fails loudly.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, scanTree } from '../../../../scripts/lib/child-process-window-scan.mjs';

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));
const MAIN_SRC = path.join(SRC_ROOT, 'main', 'main.ts');
const WORKER_ARGV_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['direct codex worker argv', /['"`]codex['"`]\s*,\s*['"`]worker['"`]/],
  ['direct workbuddy worker argv', /['"`]workbuddy['"`]\s*,\s*['"`]worker['"`]/],
  ['parameterized worker argv', /\bworkerCommand\b\s*,\s*['"`]worker['"`]/],
];

function mainSource(): string {
  return fs.readFileSync(MAIN_SRC, 'utf8');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(?:ts|mts|cts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** The body of a top-level function, from its declaration to the next one. */
function topLevelFn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  const next = source.indexOf('\nfunction ', start + 1);
  const end = next === -1 ? source.length : next;
  return source.slice(start, end);
}

describe('Service-Host-only boundary: Companion never supervises workers', () => {
  it('main.ts contains no worker command, worker supervision, drain, or liveness machinery', () => {
    const source = mainSource();
    const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
      ...WORKER_ARGV_PATTERNS,
      ['worker registry', /\bWorkspaceWorkerRegistry\b/],
      ['worker spawn helper', /\bspawnWorkspaceWorker(?:For)?\b/],
      ['worker supervision startup', /\bstartWorkspaceWorkerSupervision\b/],
      ['worker supervision shutdown', /\bstopWorkspaceWorkerSupervision\b/],
      ['worker manifest reconciliation', /\bsyncFromManifest\b/],
      ['worker event namespace', /\bworkspace_worker_/],
      ['worker liveness file', /codex-worker-liveness\.json/],
    ];
    for (const [label, pattern] of forbidden) {
      expect(pattern.test(source), `main.ts must not contain ${label}`).toBe(false);
    }
    // Non-vacuousness proof: the control-plane Console path this guard protects
    // is still present rather than the whole file having been accidentally emptied.
    expect(source).toContain('function spawnCli()');
    expect(source).toContain("PD_INVOCATION_SOURCE: 'companion'");
    expect(source.match(/PD_INVOCATION_SOURCE/g) ?? []).toHaveLength(1);
  });

  it('no production module references the Companion worker IPC/drain protocol or the deleted registry module', () => {
    const files = sourceFiles(SRC_ROOT);
    expect(files.some((file) => path.basename(file) === 'workspace-workers.ts')).toBe(false);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const forbidden of ['PD_COMPANION_WORKER_IPC', 'pd.worker.drain', 'workspace_worker_']) {
        expect(text, `${path.relative(SRC_ROOT, file)} must not reference ${forbidden}`).not.toContain(forbidden);
      }
      for (const [label, pattern] of WORKER_ARGV_PATTERNS) {
        expect(pattern.test(text), `${path.relative(SRC_ROOT, file)} must not contain ${label}`).toBe(false);
      }
    }
  });

  it('the only child-process spawn in production source is the Console CLI launch', () => {
    const scanned = scanTree(SRC_ROOT);
    expect(scanned.findings.map((finding) => `${finding.file}:${finding.line} ${finding.fn} — ${finding.verdict}`)).toEqual([]);
    expect(scanned.files).toEqual(['main/main.ts']);
    expect(scanned.callSites).toBe(1);

    const source = mainSource();
    expect(source).toMatch(/spawn\(\s*['"]node['"]\s*,\s*args\s*,\s*\{/);
    expect(source).toMatch(/spawn\(\s*['"]node['"]\s*,\s*args\s*,\s*\{[\s\S]*windowsHide:\s*true/);
  });

  it('manifest workspace presence has no control-flow path to a non-Console child process', () => {
    const source = mainSource();
    // The worker-only manifest readers were removed. Exactly one child_process
    // call remains (asserted above), and this test pins its argv construction:
    // Console-open arguments plus the Owner's explicitly validated Console
    // workspace override — never the install manifest's workspace fleet.
    for (const forbidden of [
      'readManifestWorkspacesForHost',
      'manifestCodexWorkspaces',
      'manifestWorkbuddyWorkspaces',
      'backgroundExecutions',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    const spawnBody = topLevelFn(source, 'spawnCli');
    expect(spawnBody).toMatch(/buildConsoleOpenArgs\(\s*\{[\s\S]*workspaceDir:\s*validatedWorkspaceOverride\(\)[\s\S]*\}\s*\)/);
    expect(spawnBody).toContain("stdio: ['ignore', 'pipe', 'pipe']");
    expect(spawnBody).not.toContain("'ipc'");
    expect(spawnBody).not.toMatch(/\b(manifest|workspaces|workerCommand|syncFromManifest)\b/);
  });

  it('the guard is sensitive to a representative worker-spawn reintroduction (negative control)', () => {
    const reintroducedWorkerSpawn = [
      "import { spawn, type ChildProcess } from 'node:child_process';",
      'type WorkerChild = ChildProcess;',
      "const entry = 'pd-cli.js';",
      "const canonicalWorkspaceDir = 'D:/workspace';",
      "const workerCommand = 'codex';",
      'const child: WorkerChild = spawn(\'node\', [',
      '  entry,',
      "  workerCommand, 'worker',",
      "  '--workspace', canonicalWorkspaceDir,",
      '], {',
      "  env: { ...process.env, PD_COMPANION_WORKER_IPC: '1', PD_INVOCATION_SOURCE: 'companion' },",
      "  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],",
      '  windowsHide: true,',
      '});',
      'void child;',
    ].join('\n');

    // This is the sensitivity proof for the production assertions above: the
    // AST scanner really counts this worker spawn, and the same source patterns
    // really match the argv/protocol markers they forbid in src/.
    const scanned = scanSource('main/main.ts', reintroducedWorkerSpawn);
    expect(scanned.findings).toEqual([]);
    expect(scanned.callSites).toBe(1);
    expect(WORKER_ARGV_PATTERNS.some(([, pattern]) => pattern.test(reintroducedWorkerSpawn))).toBe(true);
    expect(reintroducedWorkerSpawn).toContain('PD_COMPANION_WORKER_IPC');
    expect(reintroducedWorkerSpawn).toContain("'ipc'");
  });
});
