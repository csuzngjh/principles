import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleInitStrategy } from '../../src/commands/strategy';
import type { PluginCommandContext } from '../../src/openclaw-sdk';

/**
 * /pd-init contract (SPEC v1.1 §8.4, Batch 3 NOT authorized): interview +
 * three-section draft ONLY. It must not create/modify any file and must NOT
 * advertise `pd runtime init` — the Principle Context template placement is
 * future Batch 3 work and does not exist in this build.
 *
 * ISOLATION: PD_WORKSPACE_DIR is pinned to the fixture; the resolver prefers
 * PD explicit sources, so nothing here can reach the real OpenClaw workspace.
 */

const priorPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;
const priorOpenclawWorkspace = process.env.OPENCLAW_WORKSPACE;

describe('/pd-init (Principle Context interview)', () => {
  let workspaceDir: string;

  beforeEach(() => {
    delete process.env.OPENCLAW_WORKSPACE;
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-init-cmd-'));
    process.env.PD_WORKSPACE_DIR = workspaceDir;
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    if (priorPdWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR;
    else process.env.PD_WORKSPACE_DIR = priorPdWorkspaceDir;
    if (priorOpenclawWorkspace === undefined) delete process.env.OPENCLAW_WORKSPACE;
    else process.env.OPENCLAW_WORKSPACE = priorOpenclawWorkspace;
  });

  function makeCtx(): PluginCommandContext {
    return {
      workspaceDir,
      commandBody: '/pd-init',
      channel: 'cli',
      isAuthorizedSender: true,
      args: [],
      config: { language: 'zh', workspaceDir } as PluginCommandContext['config'],
    } as unknown as PluginCommandContext;
  }

  it('outputs the interview outline and the three draft sections', () => {
    const result = handleInitStrategy(makeCtx());
    expect(result.text).toContain('Principle Context 初始化访谈');
    expect(result.text).toContain('Long-term Background');
    expect(result.text).toContain('Important Constraints');
    expect(result.text).toContain('Current Direction');
    // Forbids agent-side writes; the Owner does the editing.
    expect(result.text).toContain('禁止');
    expect(result.text).not.toContain('Generate CURRENT_FOCUS');
  });

  it('names the real target path and does NOT advertise the unimplemented runtime-init placement', () => {
    const result = handleInitStrategy(makeCtx());
    expect(result.text).toContain('memory/okr/CURRENT_FOCUS.md');
    // Batch 3 does not exist in this build — pointing Owners at it is a lie.
    expect(result.text).not.toContain('pd runtime init');
    expect(result.text).toContain('手动创建');
  });

  it('never creates or modifies CURRENT_FOCUS.md', () => {
    const beforeListing = JSON.stringify(listTree(workspaceDir));
    handleInitStrategy(makeCtx());
    expect(JSON.stringify(listTree(workspaceDir))).toBe(beforeListing);
    expect(fs.existsSync(path.join(workspaceDir, 'memory', 'okr', 'CURRENT_FOCUS.md'))).toBe(false);
  });

  it('never modifies an EXISTING CURRENT_FOCUS.md', () => {
    const okrDir = path.join(workspaceDir, 'memory', 'okr');
    fs.mkdirSync(okrDir, { recursive: true });
    const focusPath = path.join(okrDir, 'CURRENT_FOCUS.md');
    fs.writeFileSync(focusPath, '# Principle Context\nOwner 原文', 'utf-8');
    const before = fs.readFileSync(focusPath, 'utf-8');

    handleInitStrategy(makeCtx());

    expect(fs.readFileSync(focusPath, 'utf-8')).toBe(before);
  });
});

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      out.push(full.slice(root.length));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}
