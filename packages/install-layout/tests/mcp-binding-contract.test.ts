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
  type BindingReadDiagnostic,
  type DirReadStatus,
  type HostClaimReaders,
  type JsonFileReadStatus,
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
        runtimeDir: '/x', serverEntry: getCanonicalMcpServerEntry('codex', '/x'), versions: {mcpServer: '0.1.0'},
      },
      [path.join(home, '.pd', 'workbuddy-marketplace', 'principles-disciple', 'mcp-binding.json')]: {
        schemaVersion: 'pd.mcp-binding.v1', host: 'workbuddy', workspaceDir: wbBoundCustom,
        runtimeDir: '/x', serverEntry: getCanonicalMcpServerEntry('workbuddy', '/x'), versions: {mcpServer: '0.1.0'},
      },
    },
    {[path.join(codexHome, 'plugins', 'data')]: ['principles-disciple-principles', 'unrelated-plugin']},
  );
  const options = {homeDir: home, codexHome, platform: 'posix', readers: fullReaders};

  it('recognizes the externally located workspace declared by the configured OpenClaw state directory', () => {
    const openclawHome = path.join(home, 'host-state');
    const readers = makeReaders({
      [path.join(openclawHome, 'principles-disciple.json')]: {workspace: declaredOpenClaw},
    });
    const roots = {homeDir: home, openclawHome, platform: 'posix', readers} as const;
    expect(findForeignWorkspaceOwner('codex', declaredOpenClaw, roots).owners).toEqual(['openclaw']);
    expect(findForeignWorkspaceOwner('openclaw', declaredOpenClaw, roots).owners).toEqual([]);
  });

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
          runtimeDir: '/x', serverEntry: getCanonicalMcpServerEntry('workbuddy', '/x'), versions: {mcpServer: '0.1.0'},
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

  // ── Review 2026-11-18: the declaration lives under the ACTUAL OpenClaw ────
  // root (OPENCLAW_STATE_DIR/OPENCLAW_HOME → openclawHome), not a fixed
  // `<home>/.openclaw` — the launcher resolves the same actual root, so a
  // shared collector reading only the default accepted bindings the launcher
  // then refused. Both directions pin the parity.

  it('the declaration is read from the ACTUAL OpenClaw root (custom openclawHome)', () => {
    const openclawHome = path.join(home, 'custom-openclaw-state');
    const declared = path.join(home, 'custom-declared-ws');
    const readers = makeReaders({
      [path.join(openclawHome, 'principles-disciple.json')]: {workspace: declared},
    });
    const custom = {homeDir: home, codexHome, openclawHome, platform: 'posix', readers};
    const claims = collectHostWorkspaceClaims(custom);
    expect(claims.map((claim) => `${claim.host}:${claim.via}:${claim.workspaceDir}`))
      .toContain(`openclaw:host_declaration:${declared}`);
    const verdict = findForeignWorkspaceOwner('codex', declared, custom);
    expect(verdict.owners).toEqual(['openclaw']);
    expect(verdict.via).toBe('host_declaration');
  });

  // ── P0-1: OpenClaw's own persisted binding must be discovered too ────────
  // ensureMcpBinding writes <openclawHome>/extensions/principles-disciple/
  // mcp-binding.json; the launcher reads ONLY that file (never env vars), so
  // env-declared non-default workspaces were undiscoverable until now.

  const ocExtensionBindingPath = (openclawHome: string): string =>
    path.join(openclawHome, 'extensions', 'principles-disciple', 'mcp-binding.json');
  const ocBoundCustom = path.join(home, 'openclaw-bound-ws');
  const validOcBinding = (workspaceDir: string): Record<string, unknown> => ({
    schemaVersion: 'pd.mcp-binding.v1', host: 'openclaw', workspaceDir,
    runtimeDir: '/x', serverEntry: getCanonicalMcpServerEntry('openclaw', '/x'),
    versions: {mcpServer: '0.1.0'},
  });

  it('collects the OpenClaw payload binding under the default openclawHome', () => {
    const readers = makeReaders({[ocExtensionBindingPath(path.join(home, '.openclaw'))]: validOcBinding(ocBoundCustom)});
    const claims = collectHostWorkspaceClaims({homeDir: home, platform: 'posix', readers});
    expect(claims.map((claim) => `${claim.host}:${claim.via}:${claim.workspaceDir}`))
      .toContain(`openclaw:payload_binding:${ocBoundCustom}`);
  });

  it('collects the binding under a custom openclawHome (OPENCLAW_STATE_DIR resolution parity)', () => {
    const openclawHome = path.join(home, 'host-state');
    const readers = makeReaders({[ocExtensionBindingPath(openclawHome)]: validOcBinding(ocBoundCustom)});
    const claims = collectHostWorkspaceClaims({homeDir: home, openclawHome, platform: 'posix', readers});
    expect(claims.map((claim) => `${claim.host}:${claim.via}:${claim.workspaceDir}`))
      .toContain(`openclaw:payload_binding:${ocBoundCustom}`);
    // ...and it is NOT consulted under the default root then.
    const readersDefault = makeReaders({[ocExtensionBindingPath(path.join(home, '.openclaw'))]: validOcBinding(ocBoundCustom)});
    expect(collectHostWorkspaceClaims({homeDir: home, openclawHome, platform: 'posix', readers: readersDefault})
      .filter((claim) => claim.via === 'payload_binding')).toEqual([]);
  });

  it('an env-declared non-default OpenClaw workspace is now refused for a Codex binding', () => {
    const readers = makeReaders({[ocExtensionBindingPath(path.join(home, '.openclaw'))]: validOcBinding(ocBoundCustom)});
    const verdict = findForeignWorkspaceOwner('codex', ocBoundCustom, {homeDir: home, platform: 'posix', readers});
    expect(verdict.owners).toEqual(['openclaw']);
    expect(verdict.via).toBe('payload_binding');
  });

  it('missing binding → no claim; removal (revoked/uninstalled) is honored on the next collect', () => {
    const readers = makeReaders({});
    expect(collectHostWorkspaceClaims({homeDir: home, platform: 'posix', readers})
      .filter((claim) => claim.via === 'payload_binding')).toEqual([]);
    const withBinding = makeReaders({[ocExtensionBindingPath(path.join(home, '.openclaw'))]: validOcBinding(ocBoundCustom)});
    expect(collectHostWorkspaceClaims({homeDir: home, platform: 'posix', readers: withBinding})
      .filter((claim) => claim.via === 'payload_binding').length).toBe(1);
    // Binding file gone → claim gone (fail-closed, reads persisted state fresh).
    expect(collectHostWorkspaceClaims({homeDir: home, platform: 'posix', readers})
      .filter((claim) => claim.via === 'payload_binding')).toEqual([]);
  });

  it('a corrupted or invalid binding forms no claim (fail-closed for every shape defect)', () => {
    const file = ocExtensionBindingPath(path.join(home, '.openclaw'));
    for (const bad of [
      {workspaceDir: 42},                                            // corrupt
      {...validOcBinding(ocBoundCustom), schemaVersion: 'bogus'},   // schemaVersion
      {...validOcBinding(ocBoundCustom), host: 'codex'},            // host mismatch
      {...validOcBinding(ocBoundCustom), workspaceDir: 'rel/path'}, // workspaceDir not absolute
      {...validOcBinding(ocBoundCustom), runtimeDir: 'rel/path'},   // runtimeDir not absolute
      {...validOcBinding(ocBoundCustom), serverEntry: '/elsewhere.js'}, // non-canonical entry
      {...validOcBinding(ocBoundCustom), versions: {mcpServer: 'x'}},   // versions
    ]) {
      const readers = makeReaders({[file]: bad});
      expect(collectHostWorkspaceClaims({homeDir: home, platform: 'posix', readers})
        .filter((claim) => claim.via === 'payload_binding'), JSON.stringify(bad)).toEqual([]);
    }
  });

  it('a junction reaching the bound workspace tree resolves to an OpenClaw claim via realpath', () => {
    const junction = path.join(home, 'oc-alias');
    const readers = makeReaders(
      {[ocExtensionBindingPath(path.join(home, '.openclaw'))]: validOcBinding(ocBoundCustom)},
      {},
      {[junction]: ocBoundCustom},
    );
    expect(findForeignWorkspaceOwner('codex', junction, {homeDir: home, platform: 'posix', readers}).owners)
      .toEqual(['openclaw']);
  });

  it('the same workspace bound by OpenClaw and declared for it plus Codex is reported as multi-host', () => {
    const contested = path.join(home, 'oc-contested');
    const readers = makeReaders(
      {
        [path.join(home, '.openclaw', 'principles-disciple.json')]: {workspace: contested},
        [ocExtensionBindingPath(path.join(home, '.openclaw'))]: validOcBinding(contested),
      },
      {[path.join(codexHome, 'plugins', 'data')]: ['principles-disciple-a']},
    );
    const claims = collectHostWorkspaceClaims({homeDir: home, codexHome, platform: 'posix', readers});
    expect(claims.filter((claim) => claim.host === 'openclaw' && claim.workspaceDir === contested)
      .map((claim) => claim.via).sort()).toEqual(['host_declaration', 'payload_binding']);
    const verdict = findForeignWorkspaceOwner('workbuddy', contested, {homeDir: home, platform: 'posix', readers});
    expect(verdict.owners).toEqual(['openclaw']);
  });

  it('a declaration under the DEFAULT root is not consulted when openclawHome points elsewhere — the launcher reads only the actual root', () => {
    const openclawHome = path.join(home, 'custom-openclaw-state');
    const readers = makeReaders({
      [path.join(home, '.openclaw', 'principles-disciple.json')]: {workspace: declaredOpenClaw},
    });
    const custom = {homeDir: home, codexHome, openclawHome, platform: 'posix', readers};
    expect(collectHostWorkspaceClaims(custom).filter((claim) => claim.via === 'host_declaration'))
      .toEqual([]);
    expect(findForeignWorkspaceOwner('codex', declaredOpenClaw, custom).owners).toEqual([]);
  });
});

// ── SPEC-PD-SERVICE-HOST-001 §9.1.8: unreadable binding evidence is degraded,
//    never "no claim" (P2) ────────────────────────────────────────────────────

describe('binding read diagnostics (§9.1.8)', () => {
  const home = path.resolve('/home/owner');
  const codexHome = path.join(home, '.codex');
  const ocBinding = path.join(home, '.openclaw', 'extensions', 'principles-disciple', 'mcp-binding.json');

  /** Readers whose readJsonStatus reports each file's structured outcome. */
  function statusReaders(statuses: Record<string, JsonFileReadStatus>): HostClaimReaders {
    return {
      readJson(file: string) {
        const status = statuses[file];
        return status !== undefined && status.kind === 'ok' ? status.value : undefined;
      },
      readJsonStatus(file: string) {
        return statuses[file] ?? { kind: 'absent' };
      },
      listDir() {
        return undefined;
      },
      realpath() {
        return undefined;
      },
    };
  }

  const okStatus = (workspaceDir: string): JsonFileReadStatus => ({
    kind: 'ok',
    value: {
      schemaVersion: 'pd.mcp-binding.v1', host: 'openclaw', workspaceDir,
      runtimeDir: '/x', serverEntry: getCanonicalMcpServerEntry('openclaw', '/x'),
      versions: {mcpServer: '0.1.0'},
    },
  });

  it('ENOENT is an honest absent — no diagnostic, no claim', () => {
    const readDiagnostics: BindingReadDiagnostic[] = [];
    const claims = collectHostWorkspaceClaims({homeDir: home, platform: 'posix', readers: statusReaders({}), readDiagnostics});
    expect(claims.filter((claim) => claim.via !== 'default')).toEqual([]);
    expect(readDiagnostics).toEqual([]);
  });

  it('EACCES/EPERM record an unreadable diagnostic — never folded into "no claim"', () => {
    for (const errno of ['EACCES', 'EPERM', 'EIO']) {
      const readDiagnostics: BindingReadDiagnostic[] = [];
      const readers = statusReaders({[ocBinding]: {kind: 'unreadable', detail: errno}});
      const claims = collectHostWorkspaceClaims({homeDir: home, platform: 'posix', readers, readDiagnostics});
      // Still no claim (fail-closed) — but the evidence is recorded, not lost.
      expect(claims.filter((claim) => claim.via === 'payload_binding')).toEqual([]);
      expect(readDiagnostics).toEqual([{file: ocBinding, status: 'unreadable', detail: errno}]);
    }
  });

  it('a JSON parse error records an invalid diagnostic', () => {
    const readDiagnostics: BindingReadDiagnostic[] = [];
    const readers = statusReaders({[ocBinding]: {kind: 'invalid', detail: 'Unexpected token'}});
    collectHostWorkspaceClaims({homeDir: home, platform: 'posix', readers, readDiagnostics});
    expect(readDiagnostics).toEqual([{file: ocBinding, status: 'invalid', detail: 'Unexpected token'}]);
  });

  it('diagnostics propagate through findForeignWorkspaceOwner and de-duplicate by file', () => {
    const readDiagnostics: BindingReadDiagnostic[] = [];
    const readers = statusReaders({[ocBinding]: {kind: 'unreadable', detail: 'EACCES'}});
    // Direct collect + a foreign-owner probe both walk the same binding —
    // the file is recorded exactly once.
    collectHostWorkspaceClaims({homeDir: home, platform: 'posix', readers, readDiagnostics});
    findForeignWorkspaceOwner('codex', path.join(home, 'ws'), {homeDir: home, platform: 'posix', readers, readDiagnostics});
    expect(readDiagnostics).toEqual([{file: ocBinding, status: 'unreadable', detail: 'EACCES'}]);
  });

  it('an unreadable declaration is degraded evidence too, not an absent declaration', () => {
    const file = path.join(home, '.openclaw', 'principles-disciple.json');
    const readDiagnostics: BindingReadDiagnostic[] = [];
    const readers = statusReaders({[file]: {kind: 'unreadable', detail: 'EACCES'}});
    collectHostWorkspaceClaims({homeDir: home, platform: 'posix', readers, readDiagnostics});
    expect(readDiagnostics).toEqual([{file, status: 'unreadable', detail: 'EACCES'}]);
  });

  it('legacy readers without readJsonStatus keep the readJson contract — no diagnostics channel', () => {
    const readDiagnostics: BindingReadDiagnostic[] = [];
    const legacy: HostClaimReaders = {
      readJson() {
        return undefined; // could be absent OR unreadable — unknowable, and not claimed as absent-by-proof
      },
      listDir() {
        return undefined;
      },
      realpath() {
        return undefined;
      },
    };
    const claims = collectHostWorkspaceClaims({homeDir: home, platform: 'posix', readers: legacy, readDiagnostics});
    expect(claims.filter((claim) => claim.via !== 'default')).toEqual([]);
    expect(readDiagnostics).toEqual([]);
  });

  it('a valid binding alongside an unreadable one still forms its claim — diagnostics are per-file', () => {
    const boundWs = path.join(home, 'bound-ws');
    const wbFile = path.join(home, '.pd', 'workbuddy-marketplace', 'principles-disciple', 'mcp-binding.json');
    const readDiagnostics: BindingReadDiagnostic[] = [];
    const readers = statusReaders({
      [ocBinding]: okStatus(boundWs),
      [wbFile]: {kind: 'unreadable', detail: 'EPERM'},
    });
    const claims = collectHostWorkspaceClaims({homeDir: home, platform: 'posix', readers, readDiagnostics});
    expect(claims.map((claim) => `${claim.host}:${claim.workspaceDir}`)).toContain(`openclaw:${boundWs}`);
    expect(readDiagnostics).toEqual([{file: wbFile, status: 'unreadable', detail: 'EPERM'}]);
  });
});

describe('codex plugins/data directory read diagnostics (§五 round 5)', () => {
  const home = path.resolve('/home/owner');
  const codexHome = path.join(home, '.codex');
  const dataRoot = path.join(codexHome, 'plugins', 'data');
  const codexBinding = path.join(dataRoot, 'principles-disciple-principles', 'mcp-binding.json');

  /** Readers whose listDirStatus reports the directory's structured outcome. */
  function dirStatusReaders(dirStatus: DirReadStatus, files: Record<string, JsonFileReadStatus> = {}): HostClaimReaders {
    return {
      readJson(file: string) {
        const status = files[file];
        return status !== undefined && status.kind === 'ok' ? status.value : undefined;
      },
      readJsonStatus(file: string) {
        return files[file] ?? { kind: 'absent' };
      },
      listDir() {
        return [];
      },
      listDirStatus(dir: string) {
        return dir === dataRoot ? dirStatus : { kind: 'absent' };
      },
      realpath() {
        return undefined;
      },
    };
  }

  const codexOk = (workspaceDir: string): JsonFileReadStatus => ({
    kind: 'ok',
    value: {
      schemaVersion: 'pd.mcp-binding.v1', host: 'codex', workspaceDir,
      runtimeDir: '/x', serverEntry: getCanonicalMcpServerEntry('codex', '/x'),
      versions: {mcpServer: '0.1.0'},
    },
  });

  it('a normal readable plugins/data directory yields claims and no diagnostic', () => {
    const boundWs = path.join(home, 'codex-bound');
    const readDiagnostics: BindingReadDiagnostic[] = [];
    const readers = dirStatusReaders(
      {kind: 'ok', entries: ['principles-disciple-principles']},
      {[codexBinding]: codexOk(boundWs)},
    );
    const claims = collectHostWorkspaceClaims({homeDir: home, codexHome, platform: 'posix', readers, readDiagnostics});
    expect(claims.map((claim) => `${claim.host}:${claim.workspaceDir}`)).toContain(`codex:${boundWs}`);
    expect(readDiagnostics).toEqual([]);
  });

  it('ENOENT/ENOTDIR are honest absence — no diagnostic, no claim', () => {
    for (const status of [{kind: 'absent'} as const]) {
      const readDiagnostics: BindingReadDiagnostic[] = [];
      const claims = collectHostWorkspaceClaims({
        homeDir: home, codexHome, platform: 'posix',
        readers: dirStatusReaders(status),
        readDiagnostics,
      });
      expect(claims.filter((claim) => claim.host === 'codex' && claim.via !== 'default')).toEqual([]);
      expect(readDiagnostics).toEqual([]);
    }
  });

  it('EACCES/EPERM/EIO record an unreadable diagnostic — never folded into "empty directory"', () => {
    for (const errno of ['EACCES', 'EPERM', 'EIO']) {
      const readDiagnostics: BindingReadDiagnostic[] = [];
      const claims = collectHostWorkspaceClaims({
        homeDir: home, codexHome, platform: 'posix',
        readers: dirStatusReaders({kind: 'unreadable', detail: errno}),
        readDiagnostics,
      });
      // No codex claim can be proven — but the degraded evidence is recorded.
      expect(claims.filter((claim) => claim.host === 'codex' && claim.via !== 'default')).toEqual([]);
      expect(readDiagnostics).toEqual([{file: dataRoot, status: 'unreadable', detail: errno}]);
    }
  });

  it('an unknown error fails closed as a diagnostic too — never silent absence', () => {
    const readDiagnostics: BindingReadDiagnostic[] = [];
    collectHostWorkspaceClaims({
      homeDir: home, codexHome, platform: 'posix',
      readers: dirStatusReaders({kind: 'unreadable', detail: 'UNKNOWN_IO'}),
      readDiagnostics,
    });
    expect(readDiagnostics).toEqual([{file: dataRoot, status: 'unreadable', detail: 'UNKNOWN_IO'}]);
  });

  it('the default reader classifies a real ENOTDIR as absent — never a diagnostic', async () => {
    const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const real = mkdtempSync(path.join(tmpdir(), 'pd-dirs-'));
    try {
      // A FILE where `plugins` must be a directory → listing `plugins/data`
      // fails ENOTDIR: honest absence, not degraded evidence.
      writeFileSync(path.join(real, 'plugins'), 'x');
      mkdirSync(path.join(real, 'plugins-alt'), { recursive: true });
      const readDiagnostics: BindingReadDiagnostic[] = [];
      // No injected readers → the real defaultHostClaimReaders classify the
      // real filesystem outcome on every platform.
      const claims = collectHostWorkspaceClaims({
        homeDir: real, codexHome: real, platform: 'posix',
        readDiagnostics,
      });
      expect(claims.filter((claim) => claim.host === 'codex' && claim.via !== 'default')).toEqual([]);
      expect(readDiagnostics).toEqual([]);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});
