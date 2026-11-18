/**
 * MCP binding contract — the single declaration the installer, `pd health` and
 * the launcher parity test all rely on.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  buildMcpBindingFixture,
  collectHostWorkspaceClaims,
  findForeignWorkspaceHost,
  findForeignWorkspaceOwner,
  getCanonicalMcpServerEntry,
  getHostDefaultWorkspaceDirs,
  MCP_BINDING_FIXTURES,
  MCP_BINDING_HOSTS,
  MCP_BINDING_LAUNCHER_ONLY_REASONS,
  MCP_BINDING_SCHEMA_VERSION,
  MCP_BINDING_SHAPE_CODES,
  validateMcpBinding,
  type HostClaimReaders,
} from '../src/mcp-binding-contract.js';

const RUNTIME = path.resolve('/pd/runtime');
const WORKSPACE = path.resolve('/pd/workspace');
const ELSEWHERE = path.resolve('/pd/elsewhere.js');

function context(host: (typeof MCP_BINDING_HOSTS)[number]) {
  return {host, runtimeDir: RUNTIME, workspaceDir: WORKSPACE, foreignServerEntry: ELSEWHERE, versions: {mcpServer: '0.1.0'}};
}

describe('getCanonicalMcpServerEntry', () => {
  it('uses the npm dependency layout for codex and the component layout for the shared runtime hosts', () => {
    expect(getCanonicalMcpServerEntry('codex', RUNTIME)).toBe(
      path.join(RUNTIME, 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'),
    );
    expect(getCanonicalMcpServerEntry('openclaw', RUNTIME)).toBe(
      path.join(RUNTIME, 'pd-mcp-server', 'dist', 'index.js'),
    );
    expect(getCanonicalMcpServerEntry('workbuddy', RUNTIME)).toBe(
      path.join(RUNTIME, 'pd-mcp-server', 'dist', 'index.js'),
    );
  });
});

describe('validateMcpBinding — shared fixture table', () => {
  for (const host of MCP_BINDING_HOSTS) {
    for (const fixture of MCP_BINDING_FIXTURES) {
      it(`${host} / ${fixture.id}`, () => {
        // `posix` keeps the fixture expectations OS-independent: identical
        // casing must be accepted on every platform. The win32 rule below.
        const verdict = validateMcpBinding(buildMcpBindingFixture(fixture.id, context(host)), host, 'posix');
        if (fixture.expectedReasonPrefix === null) {
          expect(verdict.ok).toBe(true);
          return;
        }
        expect(verdict.ok).toBe(false);
        if (verdict.ok) return;
        expect(verdict.reason.startsWith(fixture.expectedReasonPrefix)).toBe(true);
        expect(verdict.nextAction.length).toBeGreaterThan(20);
      });
    }
  }

  it('accepts the exact schema version the writers emit', () => {
    const verdict = validateMcpBinding(buildMcpBindingFixture('valid', context('codex')), 'codex', 'posix');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.binding.schemaVersion).toBe(MCP_BINDING_SCHEMA_VERSION);
  });
});

describe('canonical entry comparison — launcher platform rule', () => {
  it('accepts a case-only difference on win32 and rejects it on posix', () => {
    // The launcher's samePath() lowercases both sides on win32. The shared
    // declaration must agree, or the installer rewrites a binding the launcher
    // accepts and `pd health` reports drift. The platform is injected, so this
    // exercises win32 semantics on Linux CI.
    const runtimeDir = path.join(RUNTIME, 'CaseSensitive');
    const raw = buildMcpBindingFixture('valid', {
      host: 'codex',
      runtimeDir,
      workspaceDir: WORKSPACE,
      foreignServerEntry: ELSEWHERE,
      versions: {mcpServer: '0.1.0'},
    }) as Record<string, unknown>;
    const caseOnly = {...raw, serverEntry: getCanonicalMcpServerEntry('codex', runtimeDir.toUpperCase())};

    expect(validateMcpBinding(caseOnly, 'codex', 'win32').ok).toBe(true);
    const strict = validateMcpBinding(caseOnly, 'codex', 'posix');
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.reason).toBe('server_entry_not_canonical:codex');
  });
});

describe('host workspace ownership (PRI-1247 cross-host misbinding)', () => {
  const home = path.resolve('/home/owner');
  const options = {homeDir: home, platform: 'posix'};

  it('declares each host\'s own default workspace', () => {
    expect(getHostDefaultWorkspaceDirs('openclaw', options)).toEqual([
      path.join(home, 'clawd'),
      path.join(home, '.openclaw', 'workspace'),
    ]);
    expect(getHostDefaultWorkspaceDirs('codex', options)).toEqual([path.join(home, '.codex', 'pd-workspace')]);
    expect(getHostDefaultWorkspaceDirs('workbuddy', options)).toEqual([path.join(home, '.workbuddy', 'pd-workspace')]);
  });

  it('rejects the OpenClaw defaults (and descendants) for a Codex binding', () => {
    expect(findForeignWorkspaceHost('codex', path.join(home, 'clawd'), options)).toBe('openclaw');
    expect(findForeignWorkspaceHost('codex', path.join(home, '.openclaw', 'workspace'), options)).toBe('openclaw');
    expect(findForeignWorkspaceHost('codex', path.join(home, '.openclaw', 'workspace', 'project'), options)).toBe('openclaw');
  });

  it('rejects another host\'s defaults symmetrically', () => {
    expect(findForeignWorkspaceHost('openclaw', path.join(home, '.codex', 'pd-workspace'), options)).toBe('codex');
    expect(findForeignWorkspaceHost('workbuddy', path.join(home, '.codex', 'pd-workspace'), options)).toBe('codex');
    expect(findForeignWorkspaceHost('codex', path.join(home, '.workbuddy', 'pd-workspace'), options)).toBe('workbuddy');
  });

  it('honors CODEX_HOME when naming Codex\'s owned workspace', () => {
    const custom = {homeDir: home, codexHome: path.join(home, 'custom-codex'), platform: 'posix'};
    expect(findForeignWorkspaceHost('openclaw', path.join(home, 'custom-codex', 'pd-workspace'), custom)).toBe('codex');
  });

  it('honors OpenClaw and WorkBuddy config-root overrides', () => {
    const custom = {
      homeDir: home,
      openclawHome: path.join(home, 'custom-openclaw'),
      workbuddyConfigDir: path.join(home, 'custom-workbuddy'),
      platform: 'posix',
    };
    expect(findForeignWorkspaceHost('codex', path.join(custom.openclawHome, 'workspace'), custom)).toBe('openclaw');
    expect(findForeignWorkspaceHost('codex', path.join(custom.workbuddyConfigDir, 'pd-workspace'), custom)).toBe('workbuddy');
  });

  it('accepts arbitrary project/workspace directories and its own default', () => {
    expect(findForeignWorkspaceHost('codex', path.join(home, 'projects', 'app'), options)).toBeNull();
    expect(findForeignWorkspaceHost('codex', path.join(home, '.codex', 'pd-workspace'), options)).toBeNull();
    expect(findForeignWorkspaceHost('openclaw', path.join(home, 'clawd'), options)).toBeNull();
  });

  it('uses the injected platform rule (win32 is case-insensitive)', () => {
    const win = {homeDir: path.resolve('/Home/Owner'), platform: 'win32'};
    expect(findForeignWorkspaceHost('codex', path.resolve('/home/owner/CLAWD'), win)).toBe('openclaw');
    // posix keeps the real case; this is a DIFFERENT directory.
    expect(findForeignWorkspaceHost('codex', path.resolve('/home/owner/CLAWD'), options)).toBeNull();
  });
});

describe('reason vocabulary', () => {
  it('keeps the shape and launcher-only vocabularies disjoint', () => {
    const shape = new Set<string>(MCP_BINDING_SHAPE_CODES);
    expect(MCP_BINDING_LAUNCHER_ONLY_REASONS.filter((entry) => shape.has(entry.code))).toEqual([]);
  });

  it('justifies every launcher-only exemption', () => {
    for (const entry of MCP_BINDING_LAUNCHER_ONLY_REASONS) {
      expect(entry.why.length, entry.code).toBeGreaterThan(20);
    }
  });
});

// ── PRI-1247 reopen: declaration-based ownership (injectable readers) ─────────

describe('declaration-based workspace ownership (PRI-1247 reopen)', () => {
  const home = path.resolve('/home/owner');
  const codexHome = path.join(home, '.codex');
  const declaredOpenClaw = path.join(home, 'openclaw-custom-ws');
  const codexBoundCustom = path.join(home, 'codex-bound-ws');
  const wbBoundCustom = path.join(home, 'wb-bound-ws');

  /** Readers over an in-memory declaration store — no filesystem involved. */
  function makeReaders(files: Record<string, unknown>, dirs: Record<string, string[]> = {}, realpaths: Record<string, string> = {}): HostClaimReaders {
    return {
      readJson(file: string) {
        const value = files[file];
        if (value === undefined) return undefined;
        return typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      },
      listDir(dir: string) {
        return dirs[dir];
      },
      realpath(target: string) {
        return realpaths[target];
      },
    };
  }

  const fullReaders = makeReaders(
    {
      [path.join(home, '.openclaw', 'principles-disciple.json')]: {workspace: declaredOpenClaw},
      [path.join(codexHome, 'plugins', 'data', 'principles-disciple-principles', 'mcp-binding.json')]: {
        schemaVersion: 'pd.mcp-binding.v1', host: 'codex', workspaceDir: codexBoundCustom,
        runtimeDir: '/x', serverEntry: '/x.js', versions: {mcpServer: '0.1.0'},
      },
      [path.join(home, '.pd', 'workbuddy-marketplace', 'principles-disciple', 'mcp-binding.json')]: {
        schemaVersion: 'pd.mcp-binding.v1', host: 'workbuddy', workspaceDir: wbBoundCustom,
        runtimeDir: '/x', serverEntry: '/x.js', versions: {mcpServer: '0.1.0'},
      },
    },
    {[path.join(codexHome, 'plugins', 'data')]: ['principles-disciple-principles', 'unrelated-plugin']},
  );
  const options = {homeDir: home, codexHome, platform: 'posix', readers: fullReaders};

  it('collects defaults, the OpenClaw declaration, and both payload bindings', () => {
    const claims = collectHostWorkspaceClaims(options);
    const summarized = claims.map((claim) => `${claim.host}:${claim.via}:${claim.workspaceDir}`);
    expect(summarized).toContain(`openclaw:default:${path.join(home, 'clawd')}`);
    expect(summarized).toContain(`openclaw:host_declaration:${declaredOpenClaw}`);
    expect(summarized).toContain(`codex:payload_binding:${codexBoundCustom}`);
    expect(summarized).toContain(`workbuddy:payload_binding:${wbBoundCustom}`);
    // Non-matching plugin-data directories never produce claims.
    expect(summarized.filter((entry) => entry.includes('unrelated-plugin'))).toEqual([]);
  });

  it('the defaults-only check still misses the declared workspace — the shared verdict must not', () => {
    // This is the regression shape of the reopen: the ORIGINAL incident target
    // passed findForeignWorkspaceHost but must fail findForeignWorkspaceOwner.
    expect(findForeignWorkspaceHost('codex', declaredOpenClaw, options)).toBeNull();
    const verdict = findForeignWorkspaceOwner('codex', declaredOpenClaw, options);
    expect(verdict.owners).toEqual(['openclaw']);
    expect(verdict.via).toBe('host_declaration');
  });

  it('payload bindings guard the reverse directions', () => {
    expect(findForeignWorkspaceOwner('openclaw', codexBoundCustom, options).owners).toEqual(['codex']);
    expect(findForeignWorkspaceOwner('openclaw', wbBoundCustom, options).owners).toEqual(['workbuddy']);
  });

  it('ignores the host\'s own claims and unclaimed custom directories', () => {
    expect(findForeignWorkspaceOwner('openclaw', declaredOpenClaw, options).owners).toEqual([]);
    expect(findForeignWorkspaceOwner('codex', path.join(home, 'projects', 'x'), options).owners).toEqual([]);
  });

  it('multiple owners are all reported (ambiguity is the Owner\'s to fix)', () => {
    const contested = path.join(home, 'contested');
    const readers = makeReaders(
      {
        [path.join(home, '.openclaw', 'principles-disciple.json')]: {workspace: contested},
        [path.join(home, '.pd', 'workbuddy-marketplace', 'principles-disciple', 'mcp-binding.json')]: {
          schemaVersion: 'pd.mcp-binding.v1', host: 'workbuddy', workspaceDir: contested,
          runtimeDir: '/x', serverEntry: '/x.js', versions: {mcpServer: '0.1.0'},
        },
      },
    );
    const verdict = findForeignWorkspaceOwner('codex', contested, {homeDir: home, platform: 'posix', readers});
    expect([...verdict.owners].sort()).toEqual(['openclaw', 'workbuddy']);
  });

  it('uses realpath identity when resolvable — a junction path reaching the declared tree is foreign', () => {
    const junction = path.join(home, 'alias');
    const readers = makeReaders(
      {[path.join(home, '.openclaw', 'principles-disciple.json')]: {workspace: declaredOpenClaw}},
      {},
      {[junction]: declaredOpenClaw},
    );
    const verdict = findForeignWorkspaceOwner('codex', junction, {homeDir: home, platform: 'posix', readers});
    expect(verdict.owners).toEqual(['openclaw']);
  });

  it('malformed declarations are ignored, never trusted (rc-1/rc-3: relative/empty/non-string)', () => {
    const readers = makeReaders({
      [path.join(home, '.openclaw', 'principles-disciple.json')]: {workspace: 'relative/path'},
      [path.join(home, '.principles', 'principles-disciple.json')]: {workspace: ''},
      [path.join(codexHome, 'plugins', 'data', 'principles-disciple-x', 'mcp-binding.json')]: {workspaceDir: 42},
    });
    const claims = collectHostWorkspaceClaims({homeDir: home, codexHome, platform: 'posix', readers});
    expect(claims.filter((claim) => claim.via !== 'default')).toEqual([]);
    expect(findForeignWorkspaceOwner('codex', path.join(home, 'relative', 'path'), {homeDir: home, platform: 'posix', readers}).owners).toEqual([]);
  });
});
