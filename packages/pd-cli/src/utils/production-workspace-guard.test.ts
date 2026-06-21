import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import {
  isProductionWorkspace,
  guardUatWorkspace,
  getSafeUatWorkspacePath,
  formatGuardRefusal,
  type GuardRefusal,
} from './production-workspace-guard.js';

const PRODUCTION_PATHS = [
  'D:\\.openclaw\\workspace',
  'C:\\.openclaw\\workspace',
  'C:\\Users\\Administrator\\.openclaw\\workspace',
  path.join(os.homedir(), '.openclaw', 'workspace'),
];

const SAFE_PATHS = [
  'D:\\.openclaw\\workspace-test',
  'D:\\.openclaw\\workspace-backup',
  path.join(os.tmpdir(), 'pd-uat-workspace'),
  path.join(os.tmpdir(), 'pd-test-any'),
  'C:\\completely-unrelated\\work',
];

describe('isProductionWorkspace', () => {
  it.each(PRODUCTION_PATHS)('detects production: %s', (prodPath) => {
    expect(isProductionWorkspace(path.resolve(prodPath))).toBe(true);
  });
  it.each(SAFE_PATHS)('allows safe: %s', (safePath) => {
    expect(isProductionWorkspace(path.resolve(safePath))).toBe(false);
  });
  it('detects descendant', () => {
    // Use a platform-appropriate descendant path so the test works on both
    // Windows (where D:\... resolves as-is) and Linux CI (where D:\... is
    // treated as a relative path and resolves under cwd).
    const prodPath = path.resolve(path.join(os.homedir(), '.openclaw', 'workspace'));
    const descendantPath = path.join(prodPath, 'sub', 'child');
    expect(isProductionWorkspace(descendantPath)).toBe(true);
  });
  it('rejects sibling workspace-test (ERR-030)', () => {
    expect(isProductionWorkspace(path.resolve('D:\\.openclaw\\workspace-test'))).toBe(false);
  });
  it('rejects sibling workspace-backup (ERR-030)', () => {
    expect(isProductionWorkspace(path.resolve('D:\\.openclaw\\workspace-backup'))).toBe(false);
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
      const prodPath = path.resolve(path.join(os.homedir(), '.openclaw', 'workspace'));
      const descendantPath = path.join(prodPath, 'subdir');
      expect(guardUatWorkspace(descendantPath, 'test').refused).toBe(true);
    });
  });
  describe('allowed', () => {
    it.each(SAFE_PATHS)('allows safe: %s', (safePath) => {
      const r = guardUatWorkspace(safePath, 'test');
      expect(r.refused).toBe(false);
    });
    it.each(['D:\\.openclaw\\workspace-test', 'D:\\.openclaw\\workspace-backup'])(
      'allows sibling: %s (ERR-030)', (p) => {
        expect(guardUatWorkspace(p, 'test').refused).toBe(false);
      });
  });
});

describe('JSON output (EP-04)', () => {
  it('outputs single object with reason and nextAction', () => {
    const r = guardUatWorkspace('D:\\.openclaw\\workspace', 'test');
    const json = formatGuardRefusal(r as GuardRefusal, 'test', true);
    const parsed = JSON.parse(json);
    expect(parsed).toMatchObject({
      status: 'refused', reason: expect.any(String), nextAction: expect.any(String),
      workspace: expect.any(String), isProduction: true,
    });
    expect(Array.isArray(parsed)).toBe(false);
  });
  it('no console prefixes in JSON', () => {
    const r = guardUatWorkspace('D:\\.openclaw\\workspace', 'test');
    const json = formatGuardRefusal(r as GuardRefusal, 'test', true);
    expect(json).not.toContain('[pd-cli]');
    expect(json).not.toContain('ERROR:');
    expect(json.trim().startsWith('{')).toBe(true);
  });
});

describe('text output (EP-03)', () => {
  it('includes reason and nextAction', () => {
    const r = guardUatWorkspace('D:\\.openclaw\\workspace', 'test');
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