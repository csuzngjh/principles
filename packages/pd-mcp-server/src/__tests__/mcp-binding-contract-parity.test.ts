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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  buildMcpBindingFixture,
  getCanonicalMcpServerEntry,
  isSameMcpBindingPath,
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

        const verdict = validateMcpBinding(binding, host, process.platform);
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

  /**
   * The `fail(...)` calls in the shipped launcher, with the FIRST argument
   * isolated (that is where the reason lives). Scanning only literals inside
   * `fail(...)` let `fail(declared.reason, ...)` hide every reason the
   * declaration resolver computes.
   */
  function failCalls(): {call: string; firstArgument: string}[] {
    const calls: {call: string; firstArgument: string}[] = [];
    // The negative lookbehind drops the `function fail(reason, nextAction)`
    // declaration; only call sites carry a reason to enumerate.
    for (const match of source.matchAll(/(?<!function )\bfail\(/g)) {
      const start = (match.index ?? 0) + 'fail('.length;
      let depth = 0;
      let quote: string | null = null;
      let firstComma = -1;
      let close = source.length;
      for (let i = start; i < source.length; i += 1) {
        const ch = source[i] as string;
        if (quote !== null) {
          if (ch === '\\') i += 1;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
          quote = ch;
          continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') {
          depth += 1;
        } else if (ch === ')' || ch === ']' || ch === '}') {
          if (ch === ')' && depth === 0) {
            close = i;
            break;
          }
          depth -= 1;
        } else if (ch === ',' && depth === 0 && firstComma === -1) {
          firstComma = i;
        }
      }
      calls.push({
        call: source.slice(start, close),
        firstArgument: source.slice(start, firstComma === -1 ? close : firstComma),
      });
    }
    return calls;
  }

  /**
   * Reasons built by the launcher's own resolvers (`reason: ...`) — e.g. the
   * workspace declaration resolver emitted through `fail(declared.reason, ...)`.
   */
  function reasonResolverExpressions(): string[] {
    return [...source.matchAll(/\breason\s*:\s*([^,\n}]+)/g)].map((match) => match[1] as string);
  }

  function reasonCodes(text: string): Set<string> {
    const codes = new Set<string>();
    for (const literal of text.matchAll(/(['"`])([a-z][a-z0-9]*_[a-z0-9_]*)(?::|['"`])/g)) {
      codes.add(literal[2] as string);
    }
    return codes;
  }

  /** Every reason the launcher can actually emit: literal or resolver value. */
  function launcherReasonCodes(): Set<string> {
    const codes = new Set<string>();
    for (const {firstArgument} of failCalls()) {
      for (const code of reasonCodes(firstArgument)) codes.add(code);
    }
    for (const expression of reasonResolverExpressions()) {
      for (const code of reasonCodes(expression)) codes.add(code);
    }
    return codes;
  }

  it('every failure reason is enumerable (no unscanned dynamic pass-through)', () => {
    const unscanned = failCalls()
      .filter(({firstArgument}) => reasonCodes(firstArgument).size === 0)
      // A dynamic reason is allowed ONLY through `<resolver>.reason`, whose
      // literals the `reason:` scan above enumerates. Anything else could
      // introduce a code neither the table nor this suite would ever see.
      .filter(({firstArgument}) => !/^[A-Za-z_$][\w$]*\.reason$/.test(firstArgument.trim()))
      .map(({call}) => 'fail(' + call.trim() + ')');
    expect(unscanned, 'teach the vocabulary scan about this reason source').toEqual([]);
  });

  it('every launcher failure code is declared (shape or explicit exemption)', () => {
    const declared = new Set<string>([...MCP_BINDING_SHAPE_CODES, ...MCP_BINDING_LAUNCHER_ONLY_REASONS.map((r) => r.code)]);
    const undeclared = [...launcherReasonCodes()].filter((code) => !declared.has(code));
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
          process.platform,
        );
        if (!verdict.ok) produced.add(verdict.code);
      }
    }
    expect([...MCP_BINDING_SHAPE_CODES].filter((code) => !produced.has(code))).toEqual([]);
  });

  it('every launcher-only exemption is actually produced by the launcher', () => {
    const produced = launcherReasonCodes();
    const stale = MCP_BINDING_LAUNCHER_ONLY_REASONS.map((entry) => entry.code).filter((code) => !produced.has(code));
    expect(stale, 'an exemption for a code the launcher never emits is stale').toEqual([]);
  });

  it('every exemption is justified', () => {
    for (const entry of MCP_BINDING_LAUNCHER_ONLY_REASONS) {
      expect(entry.why.length, `${entry.code} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('no code is declared as both shared shape and launcher-only', () => {
    const shape = new Set<string>(MCP_BINDING_SHAPE_CODES);
    expect(MCP_BINDING_LAUNCHER_ONLY_REASONS.filter((r) => shape.has(r.code))).toEqual([]);
  });
});

describe('MCP binding path rule — launcher vs shared declaration', () => {
  const launcherSource = fs.readFileSync(LAUNCHER, 'utf8');

  /**
   * Load the shipped `samePath` function with an injected platform. The
   * launcher cannot be imported, and CI runs only on ubuntu — where the real
   * `process.platform` never reaches the win32 branch. Running the extracted
   * function with a stubbed platform pins BOTH sides of the rule on Linux.
   */
  function launcherSamePathFor(platform: string): (left: string, right: string) => boolean {
    const match = /function samePath\([\s\S]*?\n\}/.exec(launcherSource);
    expect(match, 'launcher.cjs no longer declares function samePath(left, right)').not.toBeNull();
    const harness = path.join(tempDir('pd-binding-samepath-'), 'same-path.cjs');
    fs.writeFileSync(
      harness,
      [
        "'use strict';",
        'module.exports = function (process, path) {',
        (match as RegExpMatchArray)[0],
        '  return samePath;',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );
    const factory = createRequire(import.meta.url)(harness) as (
      processStub: {platform: string},
      pathModule: typeof path,
    ) => (left: string, right: string) => boolean;
    return factory({platform}, path);
  }

  it('agrees with the shared declaration on the win32 case rule', () => {
    const upper = path.join(path.sep, 'Runtime', 'CaseSensitive', 'index.js');
    const lower = upper.toLowerCase();
    expect(upper).not.toBe(lower);

    expect(launcherSamePathFor('win32')(upper, lower)).toBe(true);
    expect(launcherSamePathFor('linux')(upper, lower)).toBe(false);
    // The shared declaration (and the installer mirror using it) must agree
    // with the shipped launcher, not merely with itself.
    expect(isSameMcpBindingPath(upper, lower, 'win32')).toBe(true);
    expect(isSameMcpBindingPath(upper, lower, 'posix')).toBe(false);
  });
});
