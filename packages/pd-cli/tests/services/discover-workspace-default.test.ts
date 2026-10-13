/**
 * PRI-957: real coverage for discoverWorkspaceDefault().
 *
 * Before this file the function was only ever mocked (resolve-workspace.test.ts
 * stubs it), so the documented CONFIGURATION_ARCHITECTURE.md §11.2 "search the
 * current directory" step could be missing without any test failing — which is
 * exactly how a multi-host install ended up silently querying the other host's
 * .pd/state.db and reporting "no candidates".
 *
 * Every case controls the three inputs the function reads: cwd, os.homedir()
 * and PD_WORKSPACE_DIR, so no real installed workspace is ever consulted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// os.homedir() is not configurable on the ESM namespace, so the fake home is
// injected through the module factory instead of vi.spyOn.
const { homeRef } = vi.hoisted(() => ({ homeRef: { value: '' } }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, homedir: () => homeRef.value };
});

import { discoverWorkspaceDefault } from '../../src/services/pd-config-loader.js';
import { canonicalPath } from '../../src/utils/path-security.js';

const ORIGINAL_ENV = process.env.PD_WORKSPACE_DIR;

let workRoot: string;
let fakeHome: string;

/** Create `<workRoot>/<name>/.pd/config.yaml` with the given body. */
function makeWorkspace(name: string, configBody: string): string {
  const dir = path.join(workRoot, name);
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pd', 'config.yaml'), configBody, 'utf8');
  return dir;
}

function configWithDefault(workspaceDir: string): string {
  return `version: 1\nworkspace:\n  default: ${JSON.stringify(workspaceDir)}\n`;
}

/** Point cwd and homedir at fixtures, and clear the user-level env override. */
function stubEnvironment(cwdDir: string): void {
  vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
  homeRef.value = fakeHome;
  delete process.env.PD_WORKSPACE_DIR;
}

beforeEach(() => {
  workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-957-')));
  fakeHome = path.join(workRoot, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_ENV !== undefined) {
    process.env.PD_WORKSPACE_DIR = ORIGINAL_ENV;
  }
  fs.rmSync(workRoot, { recursive: true, force: true });
});

describe('discoverWorkspaceDefault — cwd discovery (PRI-957)', () => {
  it('discovers the workspace the operator is standing in', () => {
    const ws = makeWorkspace('codex-ws', configWithDefault(path.join(workRoot, 'declared-default')));
    stubEnvironment(ws);

    const result = discoverWorkspaceDefault();

    expect(result).not.toBeNull();
    expect(result!.source).toBe('cwd');
    expect(result!.configPath).toBe(path.resolve(ws, '.pd', 'config.yaml'));
    expect(result!.workspaceDefault).toBe(canonicalPath(path.join(workRoot, 'declared-default')));
  });

  it('walks up from a nested directory to the nearest .pd/config.yaml', () => {
    const ws = makeWorkspace('repo', configWithDefault(path.join(workRoot, 'declared-default')));
    const nested = path.join(ws, 'packages', 'pd-cli', 'src');
    fs.mkdirSync(nested, { recursive: true });
    stubEnvironment(nested);

    const result = discoverWorkspaceDefault();

    expect(result!.source).toBe('cwd');
  });

  it('treats the hit directory itself as the workspace when its config declares no workspace.default', () => {
    // The dev repo's own .pd/config.yaml is exactly this shape: features and
    // agents but no workspace.default — and it must still count as "I am
    // standing in a workspace".
    const ws = makeWorkspace('no-default', 'version: 1\nfeatures: {}\n');
    stubEnvironment(ws);

    const result = discoverWorkspaceDefault();

    expect(result!.source).toBe('cwd');
    expect(result!.workspaceDefault).toBe(canonicalPath(ws));
  });

  it('cwd hit wins over the env-var candidate as the discovered default', () => {
    // Precedence for the resolved ROOT is unchanged (PD_WORKSPACE_DIR still
    // beats the discovered default in resolveWorkspaceDir); this ordering is
    // what makes a user-level PD_WORKSPACE_DIR emit the "differs from config
    // default" warning instead of silently pinning another host's library.
    const ws = makeWorkspace('standing-here', configWithDefault(path.join(workRoot, 'declared')));
    stubEnvironment(ws);
    process.env.PD_WORKSPACE_DIR = makeWorkspace('env-pinned', configWithDefault(path.join(workRoot, 'env-default')));

    const result = discoverWorkspaceDefault();

    expect(result!.source).toBe('cwd');
  });

  it('rejects a relative workspace.default and falls back to the containing directory', () => {
    const ws = makeWorkspace('relative', 'version: 1\nworkspace:\n  default: ./somewhere\n');
    stubEnvironment(ws);

    const result = discoverWorkspaceDefault();

    expect(result!.source).toBe('cwd');
    expect(result!.workspaceDefault).toBe(canonicalPath(ws));
  });

  it('falls through to the OpenClaw default when cwd holds no .pd/config.yaml', () => {
    const openclawWs = path.join(fakeHome, '.openclaw', 'workspace');
    fs.mkdirSync(path.join(openclawWs, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(openclawWs, '.pd', 'config.yaml'), configWithDefault(openclawWs), 'utf8');
    const notAWorkspace = path.join(workRoot, 'plain-dir');
    fs.mkdirSync(notAWorkspace, { recursive: true });
    stubEnvironment(notAWorkspace);

    const result = discoverWorkspaceDefault();

    expect(result!.source).toBe('openclaw_default');
    expect(result!.workspaceDefault).toBe(canonicalPath(openclawWs));
  });

  it('keeps requiring workspace.default for the non-cwd candidates', () => {
    // Characterization: only the cwd hit may resolve to its containing
    // directory; an env/openclaw pointer without a declared default is not a
    // workspace claim.
    const envDir = makeWorkspace('env-dir', 'version: 1\nfeatures: {}\n');
    const ws = path.join(workRoot, 'plain');
    fs.mkdirSync(ws, { recursive: true });
    stubEnvironment(ws);
    process.env.PD_WORKSPACE_DIR = envDir;

    expect(discoverWorkspaceDefault()).toBeNull();
  });

  it('returns null when nothing resolves', () => {
    const ws = path.join(workRoot, 'plain');
    fs.mkdirSync(ws, { recursive: true });
    stubEnvironment(ws);

    expect(discoverWorkspaceDefault()).toBeNull();
  });
});
