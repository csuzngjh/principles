/**
 * Tests for workspace-dir validation utilities.
 *
 * Coverage gaps targeted:
 *  - validateWorkspaceDir rejects empty / undefined input
 *  - validateWorkspaceDir rejects home directory / filesystem root
 *  - validateWorkspaceDir accepts normal project directories
 *  - WorkspaceResolutionContext type shape (presence of fields)
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  validateWorkspaceDir,
  type WorkspaceResolutionContext,
} from '../../src/core/workspace-dir-validation.js';

describe('validateWorkspaceDir', () => {
  it('returns an error string for undefined input', () => {
    expect(validateWorkspaceDir(undefined)).toBeTypeOf('string');
    expect(validateWorkspaceDir(undefined)).toMatch(/undefined/);
  });

  it('returns an error string for empty string input', () => {
    expect(validateWorkspaceDir('')).toBeTypeOf('string');
  });

  it('returns an error for the filesystem root', () => {
    const res = validateWorkspaceDir('/');
    expect(res).toBeTypeOf('string');
    expect(res).toMatch(/root/);
  });

  it('returns an error for the home directory', () => {
    const res = validateWorkspaceDir(os.homedir());
    expect(res).toBeTypeOf('string');
    expect(res).toMatch(/home/);
  });

  it('returns null for a normal nested project directory', () => {
    const candidate = path.join(os.homedir(), 'projects', 'principles-workspace');
    expect(validateWorkspaceDir(candidate)).toBeNull();
  });

  it('returns null for /tmp subdirectories (distinct from root)', () => {
    expect(validateWorkspaceDir('/tmp/pd-test-workspace')).toBeNull();
  });
});

describe('validateWorkspaceDir — edge cases (regression)', () => {
  it('returns an error for null input', () => {
    // null is falsy, same branch as undefined/empty
    const res = validateWorkspaceDir(null as unknown as string);
    expect(res).toBeTypeOf('string');
    expect(res).toMatch(/undefined/);
  });

  it('returns an error for a Windows-style drive root (raw input)', () => {
    // Line 21-23 in workspace-dir-validation.ts: raw input before resolve
    // e.g. "C:\" or "D:\" should be caught by the regex /^[A-Za-z]:\\?$/
    const res = validateWorkspaceDir('C:\\');
    expect(res).toBeTypeOf('string');
    expect(res).toMatch(/drive root/i);
  });

  it('returns an error for a resolved Windows-style drive root', () => {
    // Line 36-38: after path.resolve, a drive root should still be caught
    // On Linux, path.resolve("C:\\") turns it into "<cwd>/C:\\" which
    // won't match the drive root regex. This test verifies the raw-input
    // path is checked separately.
    const res = validateWorkspaceDir('D:\\');
    expect(res).toBeTypeOf('string');
  });

  it('returns null for a path inside the home directory (not home itself)', () => {
    // Important: must accept paths UNDER the home directory,
    // only the exact home directory should be rejected (ERR-030)
    const nested = path.join(os.homedir(), 'projects', 'my-workspace');
    expect(validateWorkspaceDir(nested)).toBeNull();
  });

  it('does not reject a path that merely starts with the home directory prefix', () => {
    // A directory like /home/userx (where homedir is /home/user) should
    // NOT be rejected — substring matching without separator is a bug
    const homeDir = os.homedir();
    const sibling = homeDir + 'x';
    // Only reject if exact match or has separator after prefix
    if (sibling !== homeDir) {
      // On some systems homeDir might be /root, so /rootx is a sibling
      expect(validateWorkspaceDir(sibling)).toBeNull();
    }
  });
});

describe('WorkspaceResolutionContext', () => {
  it('accepts contexts with workspaceDir and optional agentId', () => {
    const c1: WorkspaceResolutionContext = { workspaceDir: '/tmp/pd-ws' };
    const c2: WorkspaceResolutionContext = { workspaceDir: '/tmp/pd-ws', agentId: 'main' };
    const c3: WorkspaceResolutionContext = {};
    expect(c1.workspaceDir).toBe('/tmp/pd-ws');
    expect(c2.agentId).toBe('main');
    expect(c3.workspaceDir).toBeUndefined();
  });
});
