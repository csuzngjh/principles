import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { guardWorkspaceLeak, isMockLeakPath } from '../store/workspace-leak-guard.js';

describe('workspace-leak-guard', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevVitest = process.env.VITEST;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.VITEST = '1';
  });

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = prevVitest;
  });

  describe('isMockLeakPath', () => {
    it('detects Unix-style /fake/ paths', () => {
      expect(isMockLeakPath('/fake/workspace')).toBe(true);
      expect(isMockLeakPath('/fake/state')).toBe(true);
    });

    it('detects Unix-style /mock/ paths', () => {
      expect(isMockLeakPath('/mock/workspace')).toBe(true);
      expect(isMockLeakPath('/mock/state')).toBe(true);
    });

    it('detects Windows-resolved D:\\fake\\ paths (forward-backward slash agnostic)', () => {
      expect(isMockLeakPath('D:\\fake\\workspace')).toBe(true);
      expect(isMockLeakPath('C:\\fake\\workspace')).toBe(true);
      expect(isMockLeakPath('D:\\mock\\workspace')).toBe(true);
    });

    it('detects /tmp/fake- prefix paths', () => {
      expect(isMockLeakPath('/tmp/fake-workspace-abc')).toBe(true);
    });

    it('returns false for legitimate workspace paths', () => {
      expect(isMockLeakPath('/home/user/project')).toBe(false);
      expect(isMockLeakPath('C:\\Users\\dev\\project')).toBe(false);
      expect(isMockLeakPath('/tmp/pd-test-abc123')).toBe(false);
      expect(isMockLeakPath(path.join(os.tmpdir(), 'pd-test-xyz'))).toBe(false);
    });

    it('returns false for empty input', () => {
      expect(isMockLeakPath('')).toBe(false);
    });
  });

  describe('guardWorkspaceLeak', () => {
    it('redirects /fake/workspace to os.tmpdir()/.pd-test-quarantine/', () => {
      const result = guardWorkspaceLeak('/fake/workspace');
      expect(result).toContain('.pd-test-quarantine');
      expect(result.startsWith(os.tmpdir())).toBe(true);
    });

    it('redirects /mock/workspace to os.tmpdir()/.pd-test-quarantine/', () => {
      const result = guardWorkspaceLeak('/mock/workspace');
      expect(result).toContain('.pd-test-quarantine');
      expect(result.startsWith(os.tmpdir())).toBe(true);
    });

    it('is deterministic — same input maps to same output', () => {
      const a = guardWorkspaceLeak('/fake/workspace');
      const b = guardWorkspaceLeak('/fake/workspace');
      expect(a).toBe(b);
    });

    it('produces a valid single directory name (no path separators in basename)', () => {
      const result = guardWorkspaceLeak('/fake/workspace');
      const parent = path.dirname(result);
      const base = path.basename(result);
      expect(parent).toBe(path.join(os.tmpdir(), '.pd-test-quarantine'));
      // basename should not contain path separators or drive colons
      expect(base).not.toMatch(/[/\\:]/);
    });

    it('returns input unchanged for legitimate paths', () => {
      const legit = '/home/user/project';
      expect(guardWorkspaceLeak(legit)).toBe(legit);
    });

    it('returns input unchanged for empty input', () => {
      expect(guardWorkspaceLeak('')).toBe('');
    });

    it('is a no-op in production (NODE_ENV !== test and no VITEST)', () => {
      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      const leak = '/fake/workspace';
      expect(guardWorkspaceLeak(leak)).toBe(leak);
    });

    it('is a no-op in production (NODE_ENV=production)', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.VITEST;
      const leak = '/fake/workspace';
      expect(guardWorkspaceLeak(leak)).toBe(leak);
    });
  });

  describe('filesystem pollution prevention', () => {
    // These tests confirm the guard actually prevents writes to filesystem root.
    // On Windows, '/fake/workspace' would resolve to '<current-drive>:\\fake\\workspace'.
    // The guard must redirect it under os.tmpdir() so no D:\\fake or C:\\fake dir is created.
    it('mkdir of guarded /fake/workspace does not create <drive>:\\fake', () => {
      const guarded = guardWorkspaceLeak('/fake/workspace');
      fs.mkdirSync(guarded, { recursive: true });
      // The guarded path should exist under tmpdir
      expect(fs.existsSync(guarded)).toBe(true);
      // The leaked path at filesystem root should NOT exist
      // (we can't easily compute the Windows-resolved form from here, but we
      // can assert that the guarded path is strictly under tmpdir)
      expect(guarded.startsWith(os.tmpdir())).toBe(true);
    });
  });
});
