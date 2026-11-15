/**
 * `pd health` console section (health-console.ts) + derived agent acceptance
 * summary (buildHealthSummary) tests.
 *
 * - assessConsole: real-filesystem fixtures under an exclusive mkdtemp HOME
 *   (install manifest, console entry, web bundle, runtime-dependency slots);
 *   port liveness via the established global mock hooks (__mockIsPortInUse /
 *   __mockProbeConsoleHealth) so nothing depends on the machine's ports.
 * - buildHealthSummary: pure derivation — every clause reads its OWN witness,
 *   asserted in DISAGREEING combinations (ERR-182), not only all-on/all-off.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assessConsole } from '../../src/commands/health-console.js';
import { buildHealthSummary } from '../../src/commands/health.js';
import type { McpHealthSection } from '../../src/commands/health-mcp.js';
import type { ConsoleHealthSection } from '../../src/commands/health-console.js';
import type { WorkspaceHealth } from '../../src/commands/health.js';

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '// fixture\n');
}

/** A canonical-mode install with an INTACT console (entry + web + dep slots). */
function makeInstalledConsoleHome(home: string): { home: string; consoleDir: string } {
  const pdDir = path.join(home, '.pd');
  writeJson(path.join(pdDir, 'install.json'), { layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'] });
  const consoleDir = path.join(pdDir, 'runtime', 'console');
  touch(path.join(consoleDir, 'dist', 'server.js'));
  touch(path.join(consoleDir, 'dist', 'web', 'index.html'));
  // The exact runtime-dependency slots checkConsoleRuntimeDependencies probes.
  const slots: { pkg: string; entries: string[] }[] = [
    { pkg: '@principles/core', entries: ['dist/principle-tree-ledger.js', 'dist/runtime/index.js'] },
    { pkg: '@principles/host-runtime', entries: ['dist/index.js'] },
    { pkg: '@principles/install-layout', entries: ['dist/index.js'] },
    { pkg: 'principles-disciple', entries: ['dist/governance-audit.js'] },
  ];
  for (const slot of slots) {
    writeJson(path.join(consoleDir, 'node_modules', slot.pkg, 'package.json'), { name: slot.pkg, version: '0.0.0' });
    for (const entry of slot.entries) touch(path.join(consoleDir, 'node_modules', slot.pkg, entry));
  }
  return { home, consoleDir };
}

function withHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-health-console-'));
  return (async () => {
    try {
      return await fn(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })();
}

const globalWithMocks = globalThis as typeof globalThis & {
  __mockIsPortInUse?: (host: string, port: number) => boolean;
  __mockProbeConsoleHealth?: (opts: { host: string; port: number }) => { healthy: boolean; reason?: string };
};

afterEach(() => {
  delete globalWithMocks.__mockIsPortInUse;
  delete globalWithMocks.__mockProbeConsoleHealth;
});

describe('assessConsole — install facts', () => {
  it('reports not_installed for an empty home (neutral, never a defect)', async () => {
    await withHome(async (home) => {
      const section = await assessConsole(home);
      expect(section.status).toBe('not_installed');
      expect(section.dir).toBeNull();
      expect(section.nextAction).toBeTruthy();
    });
  });

  it('reports broken when the console server entry is missing', async () => {
    await withHome(async (home) => {
      // Manifest + runtime exist (canonical), but no console bytes.
      writeJson(path.join(home, '.pd', 'install.json'), { layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'] });
      fs.mkdirSync(path.join(home, '.pd', 'runtime'), { recursive: true });
      const section = await assessConsole(home);
      expect(section.status).toBe('broken');
      expect(section.reason).toBe('console_server_entry_missing');
      expect(section.nextAction).toContain('create-principles-disciple');
    });
  });

  it('reports broken when a runtime-dependency slot is an empty shell', async () => {
    await withHome(async (home) => {
      const { consoleDir } = makeInstalledConsoleHome(home);
      // Empty the host-runtime slot (package.json without dist) — the exact
      // interrupted-update shell the check exists for.
      fs.rmSync(path.join(consoleDir, 'node_modules', '@principles', 'host-runtime', 'dist'), { recursive: true, force: true });
      const section = await assessConsole(home);
      expect(section.status).toBe('broken');
      expect(section.reason).toBe('console_runtime_dependency_broken');
      expect(section.integrity).toContain('host-runtime');
    });
  });

  it('reports installed_not_running when intact and no port answers (the normal on-demand state)', async () => {
    await withHome(async (home) => {
      makeInstalledConsoleHome(home);
      globalWithMocks.__mockIsPortInUse = () => false;
      const section = await assessConsole(home);
      expect(section.status).toBe('installed_not_running');
      expect(section.running.url).toBeNull();
      expect(section.integrity).toBeNull();
    });
  });

  it('reports installed_running when a healthy console answers in the port window', async () => {
    await withHome(async (home) => {
      makeInstalledConsoleHome(home);
      globalWithMocks.__mockIsPortInUse = (host, port) => port === 3101;
      globalWithMocks.__mockProbeConsoleHealth = () => ({ healthy: true });
      const section = await assessConsole(home);
      expect(section.status).toBe('installed_running');
      expect(section.running.url).toBe('http://127.0.0.1:3101');
      expect(section.running.port).toBe(3101);
    });
  });

  it('keeps scanning past a port occupied by a non-console process', async () => {
    await withHome(async (home) => {
      makeInstalledConsoleHome(home);
      globalWithMocks.__mockIsPortInUse = (host, port) => port === 3100 || port === 3102;
      globalWithMocks.__mockProbeConsoleHealth = (opts) => (opts.port === 3102 ? { healthy: true } : { healthy: false, reason: 'not a console' });
      const section = await assessConsole(home);
      expect(section.status).toBe('installed_running');
      expect(section.running.port).toBe(3102);
    });
  });
});

// ─── buildHealthSummary — pure derivation, DISAGREEING combinations ──────────

function mcpSection(overrides: Partial<McpHealthSection> = {}): McpHealthSection {
  return {
    host: 'openclaw',
    status: 'HEALTHY',
    server: { runtimeDir: '/r', entry: '/e', entryExists: true, version: '1.0.0', pin: '1.0.0', pinSource: 'binding.versions.mcpServer', versionMatchesPin: true },
    binding: {
      path: '/b', exists: true, schemaVersion: 'pd.mcp-binding.v1', host: 'openclaw',
      workspaceDir: '/w', runtimeDir: '/r', serverEntry: '/e', canonical: true, insideRuntime: true, versionMatchesInstalled: true,
    },
    hostConfig: { path: '/c', registered: true, launcher: './mcp/launcher.cjs' },
    declaredEntries: { checked: 4, missing: [], unverifiable: [] },
    workspace: { dir: '/w', exists: true },
    registrationConflict: { configPath: '/c', verdict: 'pd_owned' },
    restart: { required: false, reason: null },
    probe: { performed: false, reason: 'health_is_read_only_and_does_not_spawn_the_server' },
    ...overrides,
  } as McpHealthSection;
}

function consoleSection(overrides: Partial<ConsoleHealthSection> = {}): ConsoleHealthSection {
  return {
    status: 'installed_not_running',
    dir: '/console',
    entry: '/e',
    webIndex: '/w',
    integrity: null,
    running: { url: null, port: null },
    ...overrides,
  };
}

function reliability(hosts: string[]): WorkspaceHealth['reliability'] {
  return {
    registry: { status: hosts.length > 0 ? 'ok' : 'degraded', hosts, declaredTools: hosts.length },
    resolver: hosts.length > 0 ? 'ready' : 'not_ready',
    replay: hosts.length > 0 ? 'ready' : 'not_ready',
    ...(hosts.length === 0 ? { reason: 'host_tool_declaration_missing', nextAction: 'start the host once' } : {}),
  };
}

function report(overrides: {
  mcp?: McpHealthSection;
  console?: ConsoleHealthSection;
  hosts?: string[];
  ledger?: 'ok' | 'degraded';
  enforcementState?: 'healthy' | 'degraded' | 'unknown';
}): Parameters<typeof buildHealthSummary>[0] {
  return {
    mcp: overrides.mcp ?? mcpSection(),
    console: overrides.console ?? consoleSection(),
    reliability: reliability(overrides.hosts ?? ['openclaw']),
    candidateLedgerConsistency: { status: overrides.ledger ?? 'ok', missing: overrides.ledger === 'degraded' ? 2 : 0 },
    enforcement: { state: overrides.enforcementState ?? 'healthy', markerPath: '/m' } as WorkspaceHealth['enforcement'],
  };
}

describe('buildHealthSummary — each clause from its own witness (ERR-182)', () => {
  it('all-healthy install: overall healthy', () => {
    const summary = buildHealthSummary(report({}));
    expect(summary.overall).toBe('healthy');
    expect(summary.mcp.status).toBe('ok');
    expect(summary.console.status).toBe('ok');
    expect(summary.skills.status).toBe('ok');
    expect(summary.hostLoaded.status).toBe('ok');
    expect(summary.restart.status).toBe('ok');
  });

  it('DISAGREEING: mcp HEALTHY but console broken — only the console clause errors', () => {
    const summary = buildHealthSummary(report({ console: consoleSection({ status: 'broken', reason: 'console_server_entry_missing', nextAction: 'reinstall' }) }));
    expect(summary.mcp.status).toBe('ok');
    expect(summary.console.status).toBe('error');
    expect(summary.overall).toBe('error');
  });

  it('DISAGREEING: console running but skills declared path missing — only the skills clause errors', () => {
    const summary = buildHealthSummary(report({
      console: consoleSection({ status: 'installed_running', running: { url: 'http://127.0.0.1:3100', port: 3100 } }),
      mcp: mcpSection({
        status: 'CONFIG_DRIFT',
        reason: 'declared_entry_missing',
        nextAction: 'reinstall',
        declaredEntries: {
          checked: 2,
          missing: [{ declaration: 'openclaw.plugin.json#skills[0]', token: './skills', resolved: '/p/skills', exists: false }],
          unverifiable: [],
        },
      }),
    }));
    expect(summary.console.status).toBe('ok');
    expect(summary.skills.status).toBe('error');
    expect(summary.skills.detail).toContain('openclaw.plugin.json#skills[0]');
    expect(summary.mcp.status).toBe('error');
    expect(summary.overall).toBe('error');
  });

  it('DISAGREEING: non-skills declared entry missing does NOT trip the skills clause (own witness only)', () => {
    const summary = buildHealthSummary(report({
      mcp: mcpSection({
        declaredEntries: {
          checked: 2,
          missing: [{ declaration: 'openclaw.plugin.json#mcpServers.pd-recall.args[0]', token: './mcp/launcher.cjs', resolved: '/p/launcher.cjs', exists: false }],
          unverifiable: [],
        },
      }),
    }));
    expect(summary.skills.status).toBe('ok');
  });

  it('host not started yet: attention (not error) with a restart nextAction', () => {
    const summary = buildHealthSummary(report({ hosts: [] }));
    expect(summary.hostLoaded.status).toBe('attention');
    expect(summary.hostLoaded.nextAction).toBeTruthy();
    expect(summary.overall).toBe('attention');
  });

  it('restart required: attention with the reason carried through', () => {
    const summary = buildHealthSummary(report({ mcp: mcpSection({ status: 'RESTART_REQUIRED', restart: { required: true, reason: 'binding_written_after_newest_codex_session_started' } }) }));
    expect(summary.restart.status).toBe('attention');
    expect(summary.restart.detail).toContain('binding_written_after_newest_codex_session_started');
    expect(summary.overall).toBe('attention');
  });

  it('nothing installed: the component set is not_applicable; overall stays attention-free of errors', () => {
    const summary = buildHealthSummary(report({
      mcp: mcpSection({ status: 'NOT_INSTALLED' }),
      console: consoleSection({ status: 'not_installed' }),
      hosts: [],
    }));
    expect(summary.mcp.status).toBe('not_applicable');
    expect(summary.console.status).toBe('not_applicable');
    expect(summary.skills.status).toBe('not_applicable');
    // No ERRORS — but overall is attention because hostLoaded legitimately
    // flags "no host has started PD yet" even before anything is installed.
    expect(summary.hostLoaded.status).toBe('attention');
    expect(summary.overall).toBe('attention');
  });

  it('ledger degradation gates overall even when every summary item is ok', () => {
    const summary = buildHealthSummary(report({ ledger: 'degraded' }));
    expect(summary.mcp.status).toBe('ok');
    expect(summary.overall).toBe('error');
  });

  it('enforcement unknown gates overall even when every summary item is ok', () => {
    const summary = buildHealthSummary(report({ enforcementState: 'unknown' }));
    expect(summary.overall).toBe('error');
  });

  it('cli clause is the command itself (self-evident witness)', () => {
    const summary = buildHealthSummary(report({}));
    expect(summary.cli.status).toBe('ok');
    expect(summary.cli.note).toContain('pd CLI');
  });
});
