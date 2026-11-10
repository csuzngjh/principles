/**
 * Gate 4 architecture guards — SPEC-PD-MCP-GATE4-001 §3.2/§9.2 (Gate 4-B
 * deliverable: "必须新增适当的架构守卫，不能把尚未存在的守卫描述为已有能力").
 *
 * Pins, mechanically:
 *   G4-1  Core never depends on any MCP SDK package (§9.2: SDK 只属于 MCP
 *         Server 相关包；Core 不得直接依赖或运行时导入 MCP SDK);
 *   G4-2  this package imports @principles/core ONLY via the public
 *         capability subpath `@principles/core/runtime/pain-recall-capability`
 *         (§3.2 dependency direction; no read-model private imports, no
 *         second query implementation);
 *   G4-3  this package spawns no CLI subprocess for business queries (§8.3);
 *   G4-4  pd-cli does not depend on / import this package (CLI contract
 *         unchanged, no parallel surface);
 *   G4-5  the MCP SDK is exact-pinned (no ranges, no latest) and zod is
 *         exact-pinned;
 *   G4-6  SERVER_VERSION equals package.json version (release manifest
 *         integrity, §9.3).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_VERSION } from '../version.js';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.join(PKG_ROOT, '..', '..');

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
}

function listSourceFiles(dir: string, skipTests = false): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' && skipTests) continue;
      out.push(...listSourceFiles(full, skipTests));
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('G4-1: Core never depends on an MCP SDK', () => {
  it('principles-core package.json has no @modelcontextprotocol dependency in any dependency group', () => {
    const corePkg = readJson(path.join(REPO_ROOT, 'packages', 'principles-core', 'package.json'));
    for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = (corePkg[group] ?? {}) as Record<string, string>;
      for (const name of Object.keys(deps)) {
        expect(name.startsWith('@modelcontextprotocol/')).toBe(false);
      }
    }
  });

  it('principles-core production sources never import an MCP SDK module', () => {
    const coreSrc = path.join(REPO_ROOT, 'packages', 'principles-core', 'src');
    for (const file of listSourceFiles(coreSrc, true)) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text.includes('@modelcontextprotocol/'), `${file} imports an MCP SDK package`).toBe(false);
    }
  });
});

describe('G4-2: pd-mcp-server reaches business data only via the capability subpaths', () => {
  // The only public business subpaths this adapter may import: the read
  // capability, and (OG-4 gated) the write capability. Anything else — read
  // model, stores, CLI internals, broad `@principles/core/runtime` — is out.
  const ALLOWED_CORE_SUBPATHS = new Set([
    '@principles/core/runtime/pain-recall-capability',
    '@principles/core/runtime/pain-submit-capability',
  ]);

  it('every @principles/core import uses an allowed capability subpath', () => {
    const files = listSourceFiles(path.join(PKG_ROOT, 'src'), true);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const importMatches = [...text.matchAll(/from\s+'(@principles\/core[^']*)'/g)];
      for (const match of importMatches) {
        expect(ALLOWED_CORE_SUBPATHS.has(match[1]), `${file} imports ${match[1]}`).toBe(true);
      }
    }
  });

  it('no read-model / CLI / internal core subpath is imported anywhere in src', () => {
    // Production sources only — this test file itself necessarily contains
    // the forbidden literals it asserts against.
    for (const file of listSourceFiles(path.join(PKG_ROOT, 'src'), true)) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text.includes('@principles/core/runtime/pain-recall"')).toBe(false);
      expect(text.includes('@principles/core/runtime/pain-recall-read-model')).toBe(false);
      expect(text.includes('@principles/pd-cli')).toBe(false);
    }
  });
});

describe('G4-3: no CLI subprocess queries', () => {
  it('production sources never spawn a process for business queries', () => {
    for (const file of listSourceFiles(path.join(PKG_ROOT, 'src'), true)) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text.includes('child_process'), `${file} uses child_process`).toBe(false);
    }
  });
});

describe('G4-4: pd-cli stays independent of the MCP server', () => {
  it('pd-cli package.json does not depend on @principles/pd-mcp-server', () => {
    const cliPkg = readJson(path.join(REPO_ROOT, 'packages', 'pd-cli', 'package.json'));
    for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = (cliPkg[group] ?? {}) as Record<string, string>;
      expect(deps['@principles/pd-mcp-server']).toBeUndefined();
    }
  });

  it('pd-cli sources never import the MCP server package', () => {
    const cliSrc = path.join(REPO_ROOT, 'packages', 'pd-cli', 'src');
    if (!fs.existsSync(cliSrc)) return;
    for (const file of listSourceFiles(cliSrc, true)) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text.includes('@principles/pd-mcp-server'), `${file} imports the MCP server`).toBe(false);
    }
  });
});

describe('G4-5: SDK exact pinning (§9.2)', () => {
  it('@modelcontextprotocol/server and zod are exact versions (no ^ ~ latest ranges)', () => {
    const pkg = readJson(path.join(PKG_ROOT, 'package.json'));
    const deps = pkg.dependencies as Record<string, string>;
    expect(deps['@modelcontextprotocol/server']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(deps.zod).toMatch(/^\d+\.\d+\.\d+$/);
    const devDeps = pkg.devDependencies as Record<string, string>;
    expect(devDeps['@modelcontextprotocol/client']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('G4-6: release manifest integrity', () => {
  it('SERVER_VERSION equals package.json version', () => {
    const pkg = readJson(path.join(PKG_ROOT, 'package.json'));
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});

describe('G4-7: one launcher, three payloads (SPEC §3.3)', () => {
  const CANONICAL = path.join(REPO_ROOT, 'plugins', 'principles-disciple', 'mcp', 'launcher.cjs');
  const COPIES = [
    path.join(REPO_ROOT, 'packages', 'workbuddy-adapter', 'plugin', 'mcp', 'launcher.cjs'),
    path.join(REPO_ROOT, 'packages', 'openclaw-plugin', 'mcp', 'launcher.cjs'),
  ];

  it('the canonical launcher ships in the Codex plugin payload', () => {
    expect(fs.existsSync(CANONICAL)).toBe(true);
  });

  it('every host payload carries a byte-identical launcher copy', () => {
    const canonical = fs.readFileSync(CANONICAL, 'utf8');
    for (const copy of COPIES) {
      expect(fs.existsSync(copy), `${copy} must exist`).toBe(true);
      expect(fs.readFileSync(copy, 'utf8'), `${copy} must be byte-identical to the canonical launcher`).toBe(canonical);
    }
  });

  it('the Codex plugin declares its .mcp.json via the manifest mcpServers path form', () => {
    const manifest = readJson(path.join(REPO_ROOT, 'plugins', 'principles-disciple', '.codex-plugin', 'plugin.json'));
    expect(manifest.mcpServers).toBe('./.mcp.json');
    const mcpJson = readJson(path.join(REPO_ROOT, 'plugins', 'principles-disciple', '.mcp.json'));
    const server = (mcpJson.mcpServers as Record<string, { command: string; args: string[]; cwd: string }>)['pd-recall'];
    expect(server?.command).toBe('node');
    expect(server?.args).toEqual(['./mcp/launcher.cjs']);
    expect(server?.cwd).toBe('.');
  });

  it('the launcher contains no machine-specific absolute paths (static payload)', () => {
    const canonical = fs.readFileSync(CANONICAL, 'utf8');
    expect(canonical).not.toMatch(/[A-Z]:\\\\/);
    expect(canonical).not.toContain('USERPROFILE');
    expect(canonical).not.toContain('process.cwd()');
  });
});
