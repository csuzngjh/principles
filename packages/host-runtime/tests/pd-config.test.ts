import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { resolveNearestPdWorkspace } from '../src/pd-config.js';

// Mock node:fs so the stat/exists race the installer's atomic config rename
// creates can be simulated deterministically: existsSync reports true while
// statSync loses the file (ENOENT). resolveNearestPdWorkspace must turn that
// into a structured resolution result — never a thrown error that escapes the
// Codex hook's fail-open handling.
const statBehaviors = vi.hoisted(() => new Map<string, 'file'>());
vi.mock('node:fs', () => ({
  default: {
    // existsSync lies (the old code trusted it, then crashed in statSync).
    existsSync: () => true,
    statSync(candidate: string) {
      if (statBehaviors.has(candidate)) return { isFile: () => true };
      const error = new Error(`ENOENT: no such file or directory, statSync '${candidate}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    },
  },
}));

const root = path.parse(process.cwd()).root;
const workspaceDir = path.join(root, 'pd-race-fixture', 'ws');
const childDir = path.join(workspaceDir, 'child');
const fallbackDir = path.join(root, 'pd-race-fixture', 'legacy');
const configAt = (dir: string): string => path.join(dir, '.pd', 'config.yaml');

beforeEach(() => {
  statBehaviors.clear();
});

describe('resolveNearestPdWorkspace — stat race resilience', () => {
  it('resolves the nearest workspace whose config still stats as a file', () => {
    statBehaviors.set(configAt(workspaceDir), 'file');
    const resolution = resolveNearestPdWorkspace(childDir);
    expect(resolution).toEqual({
      ok: true,
      workspaceDir,
      configPath: configAt(workspaceDir),
      source: 'nearest',
    });
  });

  it('returns a structured config_not_found result when stat loses the race everywhere', () => {
    // existsSync=true + statSync=ENOENT on every candidate: the pre-fix code
    // threw from statSync (before the hook's fail-open try block); the fix
    // must degrade to the structured failure instead.
    const resolution = resolveNearestPdWorkspace(childDir);
    expect(resolution).toEqual({
      ok: false,
      cwd: childDir,
      reason: 'config_not_found',
      nextAction: expect.any(String),
    });
  });

  it('falls back to the legacy workspace when the nearest walk finds nothing', () => {
    statBehaviors.set(configAt(fallbackDir), 'file');
    const resolution = resolveNearestPdWorkspace(childDir, fallbackDir);
    expect(resolution).toEqual({
      ok: true,
      workspaceDir: fallbackDir,
      configPath: configAt(fallbackDir),
      source: 'legacy_fallback',
    });
  });

  it('rejects a relative cwd up front', () => {
    const resolution = resolveNearestPdWorkspace('relative/path');
    expect(resolution).toEqual({
      ok: false,
      cwd: 'relative/path',
      reason: 'cwd_not_absolute',
      nextAction: expect.any(String),
    });
  });
});
