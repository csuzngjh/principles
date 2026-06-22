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
