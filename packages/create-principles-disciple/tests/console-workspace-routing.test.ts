/**
 * P1 regression (remediation review 2026-10-13 §4): the WorkBuddy install's
 * auto-launched Console, canary and manual-open instructions MUST manage the
 * WorkBuddy governance workspace (the directory hook/worker read), not the
 * project directory. projectDir stays the task project path; the governance
 * workspace is the console's workspace for this host (SPEC §4.1).
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getWorkbuddyWorkspaceDir } from '@principles/install-layout';
import { resolveConsoleWorkspaceDir } from '../src/installer.js';

const tempDirs: string[] = [];
function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-console-route-'));
  tempDirs.push(home);
  return home;
}
afterAll(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('Console workspace routing for the WorkBuddy host (P1)', () => {
  it('routes the console to the governance workspace for host workbuddy', () => {
    const home = makeHome();
    const projectDir = path.join(home, 'project-a');
    fs.mkdirSync(projectDir, { recursive: true });
    expect(resolveConsoleWorkspaceDir('workbuddy', projectDir, home)).toBe(
      getWorkbuddyWorkspaceDir(home),
    );
  });

  it('keeps the project workspace for openclaw and codex hosts', () => {
    const home = makeHome();
    const projectDir = path.join(home, 'project-b');
    fs.mkdirSync(projectDir, { recursive: true });
    expect(resolveConsoleWorkspaceDir('openclaw', projectDir, home)).toBe(projectDir);
    expect(resolveConsoleWorkspaceDir('codex', projectDir, home)).toBe(projectDir);
  });
});
