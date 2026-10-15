/**
 * WorkBuddy engine path resolution — G1 multi-drive probing (2026-10-15).
 *
 * Defect: resolveWorkbuddyEnginePath() only probed the SystemDrive's Program
 * Files, so a Desktop install at D:\Program Files\WorkBuddy (the machine the
 * gap was proven on) resolved to "engine not found" — install skipped its
 * engine verification and detect() reported an absent engine on a real
 * installation. The S2 real-engine isolation test also silently skipped on
 * such machines.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  workbuddyEngineCandidateRoots,
  resolveWorkbuddyEnginePath,
  WORKBUDDY_ENGINE_RELATIVE,
} from '../src/installers/workbuddy-host-installer.js';

const TMP = fs.realpathSync(os.tmpdir());
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...names: string[]): void {
  for (const name of names) savedEnv[name] = process.env[name];
}

function restoreEnv(): void {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
}

describe('WorkBuddy engine path resolution (G1 multi-drive)', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('candidate roots: env Program Files first, then SystemDrive, then every fixed drive (win32 only)', () => {
    const roots = workbuddyEngineCandidateRoots({
      ProgramFiles: 'X:\\PF',
      'ProgramFiles(x86)': 'X:\\PF86',
      SystemDrive: 'C:',
    });
    expect(roots[0]).toBe('X:\\PF');
    expect(roots[1]).toBe('X:\\PF86');
    expect(roots[2]).toBe(path.join('C:', 'Program Files'));
    if (process.platform === 'win32') {
      // Non-SystemDrive letters appear in BOTH standard variants…
      expect(roots).toContain('D:\\Program Files');
      expect(roots).toContain('D:\\Program Files (x86)');
      // …and the SystemDrive is not rescanned by the letter loop.
      expect(roots.filter((root) => root === path.join('C:', 'Program Files'))).toHaveLength(1);
      expect(roots).not.toContain('C:\\Program Files (x86)');
    } else {
      expect(roots).toHaveLength(3);
    }
  });

  it('candidate roots tolerate a missing SystemDrive and dedupe repeated values', () => {
    const roots = workbuddyEngineCandidateRoots({
      ProgramFiles: 'X:\\PF',
      'ProgramFiles(x86)': 'X:\\PF',
    });
    // No SystemDrive: nothing is skipped, and the repeated ProgramFiles
    // variant collapses into one entry.
    expect(roots[0]).toBe('X:\\PF');
    expect(new Set(roots).size).toBe(roots.length);
    if (process.platform !== 'win32') {
      expect(roots).toEqual(['X:\\PF']);
    }
  });

  it('resolves an engine placed under an env-declared Program Files root', () => {
    const sandbox = fs.mkdtempSync(path.join(TMP, 'pd-wb-engine-g1-'));
    // The engine relative path is a frozen contract constant; the boundary
    // assertion proves it can never escape the fixture sandbox.
    const fakeEngine = path.join(sandbox, 'WorkBuddy', ...WORKBUDDY_ENGINE_RELATIVE);
    if (!fakeEngine.startsWith(sandbox + path.sep)) {
      throw new Error(`fixture path escaped sandbox: ${fakeEngine}`);
    }
    fs.mkdirSync(path.dirname(fakeEngine), { recursive: true });
    fs.writeFileSync(fakeEngine, '');
    saveEnv('ProgramFiles', 'PD_WORKBUDDY_ENGINE', 'WB_ENGINE');
    delete process.env.PD_WORKBUDDY_ENGINE;
    delete process.env.WB_ENGINE;
    process.env.ProgramFiles = sandbox;
    try {
      expect(resolveWorkbuddyEnginePath()).toBe(fakeEngine);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
