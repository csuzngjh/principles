/**
 * MCP binding contract parity — the launcher and the shared declaration must
 * never disagree about the same mcp-binding.json.
 *
 * The launcher ships as a dependency-free .cjs payload (it runs before any PD
 * package exists), so it cannot import @principles/install-layout. Parity is
 * therefore enforced by RUNNING the real shipped launcher over the shared
 * fixture table for every host, and by enumerating reason codes in both
 * directions: a new code on either side without a fixture/exemption is red.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMcpBindingFixture,
  getCanonicalMcpServerEntry,
  MCP_BINDING_FIXTURES,
  MCP_BINDING_HOSTS,
  MCP_BINDING_LAUNCHER_ONLY_REASONS,
  MCP_BINDING_SHAPE_CODES,
  validateMcpBinding,
  type McpBindingHost,
} from '@principles/install-layout';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.join(PKG_ROOT, '..', '..');
const LAUNCHER = path.join(REPO_ROOT, 'plugins', 'principles-disciple', 'mcp', 'launcher.cjs');
const PIN = '0.1.0';

const MARKERS: Record<McpBindingHost, string> = {
  codex: path.join('.codex-plugin', 'plugin.json'),
  openclaw: 'openclaw.plugin.json',
  workbuddy: path.join('.codebuddy-plugin', 'plugin.json'),
};

const FAKE_SERVER = [
  "'use strict';",
  'exports.main = async () => 0;',
  '',
].join('\n');

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

interface Payload {
  root: string;
  runtimeDir: string;
  workspaceDir: string;
  foreignServerEntry: string;
}

function makePayload(host: McpBindingHost): Payload {
  const root = tempDir(`pd-binding-parity-${host}-`);
  fs.mkdirSync(path.join(root, 'mcp'), {recursive: true});
  fs.copyFileSync(LAUNCHER, path.join(root, 'mcp', 'launcher.cjs'));
  const marker = path.join(root, MARKERS[host]);
  fs.mkdirSync(path.dirname(marker), {recursive: true});
  fs.writeFileSync(marker, JSON.stringify({name: 'principles-disciple'}), 'utf8');

  const runtimeDir = path.join(root, 'runtime');
  const serverEntry = getCanonicalMcpServerEntry(host, runtimeDir);
  fs.mkdirSync(path.dirname(serverEntry), {recursive: true});
  fs.writeFileSync(serverEntry, FAKE_SERVER, 'utf8');
  fs.writeFileSync(
    path.join(path.dirname(path.dirname(serverEntry)), 'package.json'),
    JSON.stringify({name: '@principles/pd-mcp-server', version: PIN}),
    'utf8',
  );
  if (host === 'codex') {
    fs.writeFileSync(path.join(root, 'runtime-version.json'), JSON.stringify({mcpServer: PIN, core: '1.0.0'}), 'utf8');
  }

  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, {recursive: true});
  return {root, runtimeDir, workspaceDir, foreignServerEntry: path.join(runtimeDir, 'elsewhere.js')};
}

function runLauncher(payload: Payload, workspaceDeclaration: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [path.join(payload.root, 'mcp', 'launcher.cjs')], {
    cwd: payload.root,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      HOME: payload.root,
      USERPROFILE: payload.root,
      PD_WORKSPACE_DIR: workspaceDeclaration,
      OPENCLAW_WORKSPACE: '',
      PD_MCP_WORKSPACE_DIR: '',
      PD_MCP_HOST: '',
    },
  });
}

function launcherReason(result: ReturnType<typeof spawnSync>): string | null {
  if (result.status === 0) return null;
  const lines = String(result.stderr).trim().split('\n');
  expect(lines).toHaveLength(1);
  const payload = JSON.parse(lines[0] as string) as {status?: string; reason?: string};
  expect(payload.status).toBe('failed');
  return payload.reason ?? null;
}

describe('MCP binding contract parity — real launcher vs shared declaration', () => {
  for (const host of MCP_BINDING_HOSTS) {
    for (const fixture of MCP_BINDING_FIXTURES) {
      it(`${host} / ${fixture.id}: ${fixture.description}`, () => {
        const payload = makePayload(host);
        const binding = buildMcpBindingFixture(fixture.id, {
          host,
          runtimeDir: payload.runtimeDir,
          workspaceDir: payload.workspaceDir,
          foreignServerEntry: payload.foreignServerEntry,
          versions: {mcpServer: PIN},
        });
        fs.writeFileSync(path.join(payload.root, 'mcp-binding.json'), JSON.stringify(binding), 'utf8');

        const verdict = validateMcpBinding(binding, host);
        const reason = launcherReason(runLauncher(payload, payload.workspaceDir));

        if (fixture.expectedReasonPrefix === null) {
          expect(verdict.ok, 'shared declaration must accept the fixture').toBe(true);
          expect(reason, 'launcher must accept the same fixture').toBeNull();
          return;
        }
        expect(verdict.ok).toBe(false);
        if (verdict.ok) return;
        expect(verdict.reason.startsWith(fixture.expectedReasonPrefix)).toBe(true);
        expect(reason).not.toBeNull();
        expect(reason?.startsWith(fixture.expectedReasonPrefix)).toBe(true);
        // The strongest form: identical code string, not just the same family.
        expect(reason).toBe(verdict.reason);
      });
    }
  }
});

describe('MCP binding reason vocabulary', () => {
  const source = fs.readFileSync(LAUNCHER, 'utf8');

  /** Every literal reason passed to fail(...) in the launcher, including ternaries. */
  function launcherReasonLiterals(): Set<string> {
    const codes = new Set<string>();
    for (const match of source.matchAll(/fail\(/g)) {
      const start = (match.index ?? 0) + 'fail('.length;
      let depth = 1;
      let end = start;
      for (; end < source.length && depth > 0; end += 1) {
        const ch = source[end];
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
      }
      const call = source.slice(start, end);
      // Reason codes are snake_case; other literals inside a fail(...) call
      // (field names, message fragments) are not part of the vocabulary.
      for (const literal of call.matchAll(/(['"`])([a-z][a-z0-9]*_[a-z0-9_]*)(?::|['"`])/g)) {
        codes.add(literal[2] as string);
      }
    }
    return codes;
  }

  it('every launcher failure code is declared (shape or explicit exemption)', () => {
    const declared = new Set<string>([...MCP_BINDING_SHAPE_CODES, ...MCP_BINDING_LAUNCHER_ONLY_REASONS.map((r) => r.code)]);
    const undeclared = [...launcherReasonLiterals()].filter((code) => !declared.has(code));
    expect(undeclared, 'add the new code to the contract module (with a reason) before shipping it').toEqual([]);
  });

  it('every shape code has a fixture that produces it', () => {
    const produced = new Set<string>();
    for (const host of MCP_BINDING_HOSTS) {
      for (const fixture of MCP_BINDING_FIXTURES) {
        const verdict = validateMcpBinding(
          buildMcpBindingFixture(fixture.id, {
            host,
            runtimeDir: path.resolve('/pd/runtime'),
            workspaceDir: path.resolve('/pd/workspace'),
            foreignServerEntry: path.resolve('/pd/elsewhere.js'),
            versions: {mcpServer: PIN},
          }),
          host,
        );
        if (!verdict.ok) produced.add(verdict.code);
      }
    }
    expect([...MCP_BINDING_SHAPE_CODES].filter((code) => !produced.has(code))).toEqual([]);
  });

  it('every exemption is justified and still exists in the launcher', () => {
    for (const entry of MCP_BINDING_LAUNCHER_ONLY_REASONS) {
      expect(entry.why.length, `${entry.code} needs a reason`).toBeGreaterThan(20);
      if (entry.code.startsWith('workspace_declaration_')) continue; // dynamic: declared.reason
      expect(source.includes(entry.code), `${entry.code} is exempt but absent from the launcher`).toBe(true);
    }
  });

  it('no code is declared as both shared shape and launcher-only', () => {
    const shape = new Set<string>(MCP_BINDING_SHAPE_CODES);
    expect(MCP_BINDING_LAUNCHER_ONLY_REASONS.filter((r) => shape.has(r.code))).toEqual([]);
  });
});
