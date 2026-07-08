import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import {
  isProductionWorkspace,
  guardUatWorkspace,
  getSafeUatWorkspacePath,
  resolveWorkspacePath,
  formatGuardRefusal,
  type GuardRefusal,
} from './production-workspace-guard.js';

// Use os.homedir()-derived paths so the tests work cross-platform
// (previously hardcoded Windows paths like D:\.openclaw\workspace which on
// Linux resolve to <cwd>/D:\.openclaw\workspace — meaningless).
const HOMEDIR_WORKSPACE = path.join(os.homedir(), '.openclaw', 'workspace');

const PRODUCTION_PATHS = [
  HOMEDIR_WORKSPACE,
];

const SAFE_PATHS = [
  path.join(os.homedir(), '.openclaw', 'workspace-test'),
  path.join(os.homedir(), '.openclaw', 'workspace-backup'),
  path.join(os.tmpdir(), 'pd-uat-workspace'),
  path.join(os.tmpdir(), 'pd-test-any'),
  // A path that is clearly unrelated on every platform
  path.join(os.tmpdir(), 'completely-unrelated-work'),
];

describe('isProductionWorkspace', () => {
  it.each(PRODUCTION_PATHS)('detects production: %s', (prodPath) => {
    expect(isProductionWorkspace(path.resolve(prodPath))).toBe(true);
  });
  it.each(SAFE_PATHS)('allows safe: %s', (safePath) => {
    expect(isProductionWorkspace(path.resolve(safePath))).toBe(false);
  });
  it('detects descendant', () => {
    const prodPath = path.resolve(HOMEDIR_WORKSPACE);
    const descendantPath = path.join(prodPath, 'sub', 'child');
    expect(isProductionWorkspace(descendantPath)).toBe(true);
  });
  it('rejects sibling workspace-test (ERR-030)', () => {
    expect(isProductionWorkspace(path.resolve(path.join(os.homedir(), '.openclaw', 'workspace-test')))).toBe(false);
  });
  it('rejects sibling workspace-backup (ERR-030)', () => {
    expect(isProductionWorkspace(path.resolve(path.join(os.homedir(), '.openclaw', 'workspace-backup')))).toBe(false);
  });
});

describe('guardUatWorkspace', () => {
  describe('refused', () => {
    it.each(PRODUCTION_PATHS)('refuses production: %s', (prodPath) => {
      const r = guardUatWorkspace(prodPath, 'test');
      expect(r.refused).toBe(true);
      if (r.refused) {
        expect(r.reason).toContain('UAT/runtime test commands are not allowed');
        expect(r.nextAction).toContain('temporary workspace');
      }
    });
    it('refuses descendant', () => {
      const prodPath = path.resolve(HOMEDIR_WORKSPACE);
      const descendantPath = path.join(prodPath, 'subdir');
      expect(guardUatWorkspace(descendantPath, 'test').refused).toBe(true);
    });
  });
  describe('allowed', () => {
    it.each(SAFE_PATHS)('allows safe: %s', (safePath) => {
      const r = guardUatWorkspace(safePath, 'test');
      expect(r.refused).toBe(false);
    });
    it.each([
      path.join(os.homedir(), '.openclaw', 'workspace-test'),
      path.join(os.homedir(), '.openclaw', 'workspace-backup'),
    ])('allows sibling: %s (ERR-030)', (p) => {
        expect(guardUatWorkspace(p, 'test').refused).toBe(false);
      });
  });
});

describe('JSON output (EP-04)', () => {
  it('outputs single object with reason and nextAction', () => {
    const r = guardUatWorkspace(HOMEDIR_WORKSPACE, 'test');
    const json = formatGuardRefusal(r as GuardRefusal, 'test', true);
    const parsed = JSON.parse(json);
    expect(parsed).toMatchObject({
      status: 'refused', reason: expect.any(String), nextAction: expect.any(String),
      workspace: expect.any(String), isProduction: true,
    });
    expect(Array.isArray(parsed)).toBe(false);
  });
  it('no console prefixes in JSON', () => {
    const r = guardUatWorkspace(HOMEDIR_WORKSPACE, 'test');
    const json = formatGuardRefusal(r as GuardRefusal, 'test', true);
    expect(json).not.toContain('[pd-cli]');
    expect(json).not.toContain('ERROR:');
    expect(json.trim().startsWith('{')).toBe(true);
  });
});

describe('text output (EP-03)', () => {
  it('includes reason and nextAction', () => {
    const r = guardUatWorkspace(HOMEDIR_WORKSPACE, 'test');
    const text = formatGuardRefusal(r as GuardRefusal, 'test', false);
    expect(text).toContain('Reason:');
    expect(text).toContain('Next Action:');
  });
});

describe('getSafeUatWorkspacePath', () => {
  it('returns deterministic temp path', () => {
    const p1 = getSafeUatWorkspacePath();
    const p2 = getSafeUatWorkspacePath();
    expect(p1).toBe(p2);
    expect(p1).toContain(os.tmpdir());
    expect(p1).toContain('pd-uat-workspace');
  });
});

describe('resolveWorkspacePath', () => {
  it('resolves an absolute path as-is', () => {
    const abs = path.resolve('/tmp/my-workspace');
    expect(resolveWorkspacePath(abs)).toBe(abs);
  });

  it('resolves a relative path against cwd', () => {
    const result = resolveWorkspacePath('relative/path');
    const expected = path.resolve(process.cwd(), 'relative/path');
    expect(result).toBe(expected);
  });

  it('defaults to cwd when no input is provided', () => {
    const result = resolveWorkspacePath(undefined);
    expect(result).toBe(path.resolve(process.cwd()));
  });
});

describe('PD_PRODUCTION_WORKSPACE env var (module-load-time)', () => {
  // NOTE: PRODUCTION_WORKSPACE_PATHS is built once at module load time from
  // process.env.PD_PRODUCTION_WORKSPACE. Setting the env var after the module
  // is loaded does NOT change behavior. These tests verify that the default
  // production path (HOMEDIR_WORKSPACE) is correctly protected, which is the
  // primary regression risk.

  it('guardUatWorkspace refuses the default production workspace', () => {
    const r = guardUatWorkspace(HOMEDIR_WORKSPACE, 'test');
    expect(r.refused).toBe(true);
    if (r.refused) {
      expect(r.isProduction).toBe(true);
      expect(r.workspace).toBe(path.resolve(HOMEDIR_WORKSPACE));
    }
  });

  it('isProductionWorkspace returns true for the default production path', () => {
    expect(isProductionWorkspace(path.resolve(HOMEDIR_WORKSPACE))).toBe(true);
  });
});
