import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { handleContextCommand } from '../../src/commands/context';
import type { PluginCommandContext, OpenClawPluginApi } from '../../src/openclaw-sdk';

/**
 * Principle Context retirement of the /pd-context focus control surface
 * (SPEC v1.1 §9.2, OD-C): the legacy projectFocus setter is a deprecated
 * notice only — it must never write the config file, never modify the
 * projectFocus value, and never touch adaptiveActivation.sendPrincipleContext.
 * The legacy config value itself stays loadable (compatibility).
 *
 * ISOLATION (mandatory): the workspace resolver prefers PD explicit sources;
 * PD_WORKSPACE_DIR is pinned to the fixture so no test can ever touch the
 * real OpenClaw workspace.
 */

const priorPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;
const priorOpenclawWorkspace = process.env.OPENCLAW_WORKSPACE;
const priorDecisionKey = process.env.DECISION_KEY;

const fakeApi = {} as OpenClawPluginApi;

function makeCtx(workspaceDir: string, args: string[]): PluginCommandContext {
  return {
    workspaceDir,
    commandBody: '/pd-context',
    channel: 'cli',
    isAuthorizedSender: true,
    args,
    sessionId: undefined,
    config: { language: 'zh', workspaceDir } as PluginCommandContext['config'],
  } as unknown as PluginCommandContext;
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

describe('/pd-context focus retirement (Principle Context)', () => {
  let workspaceDir: string;
  let configPath: string;

  beforeAll(() => {
    process.env.DECISION_KEY = 'test-decision-key';
  });
  afterAll(() => {
    if (priorDecisionKey === undefined) delete process.env.DECISION_KEY;
    else process.env.DECISION_KEY = priorDecisionKey;
  });

  beforeEach(() => {
    delete process.env.OPENCLAW_WORKSPACE;
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ctx-retire-'));
    process.env.PD_WORKSPACE_DIR = workspaceDir;
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    fs.writeFileSync(configPath, [
      'version: 1',
      'features: {}',
      'runtimeProfiles:',
      '  default:',
      '    type: openclaw',
      '    source: default',
      'internalAgents:',
      '  defaultRuntime: default',
      '  agents: {}',
      'contextInjection:',
      '  thinkingOs: true',
      '  projectFocus: full',
      '',
    ].join('\n'), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    if (priorPdWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR;
    else process.env.PD_WORKSPACE_DIR = priorPdWorkspaceDir;
    if (priorOpenclawWorkspace === undefined) delete process.env.OPENCLAW_WORKSPACE;
    else process.env.OPENCLAW_WORKSPACE = priorOpenclawWorkspace;
  });

  it('legacy projectFocus config still loads (compatibility is preserved)', () => {
    const result = handleContextCommand(makeCtx(workspaceDir, ['status']), fakeApi);
    expect(result.text).toContain('项目上下文');
    expect(result.text).toContain('完整'); // the legacy 'full' value is still displayed
    expect(result.text).toContain('已弃用');
  });

  it.each(['full', 'summary', 'off'])('focus %s returns a deprecated notice and does NOT modify the config file', (mode) => {
    const before = sha256(fs.readFileSync(configPath));
    const result = handleContextCommand(makeCtx(workspaceDir, ['focus', mode]), fakeApi);
    expect(result.text).toContain('已弃用');
    expect(result.text).toContain('配置未修改');
    expect(result.text).not.toContain('✅');
    expect(sha256(fs.readFileSync(configPath))).toBe(before);
    // The legacy value survives byte-for-byte on disk.
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('projectFocus: full');
  });

  it('focus with no argument also refuses without writing', () => {
    const before = sha256(fs.readFileSync(configPath));
    const result = handleContextCommand(makeCtx(workspaceDir, ['focus']), fakeApi);
    expect(result.text).toContain('已弃用');
    expect(sha256(fs.readFileSync(configPath))).toBe(before);
  });

  it('focus never touches adaptiveActivation.sendPrincipleContext (egress stays unauthorized)', () => {
    handleContextCommand(makeCtx(workspaceDir, ['focus', 'full']), fakeApi);
    const yaml = fs.readFileSync(configPath, 'utf-8');
    expect(yaml).not.toContain('sendPrincipleContext');
    expect(yaml).not.toContain('adaptiveActivation');
  });

  it('status no longer advertises the focus control hint', () => {
    const result = handleContextCommand(makeCtx(workspaceDir, ['status']), fakeApi);
    expect(result.text).not.toContain('/pd-context focus full/summary/off');
    expect(result.text).toContain('无注入效果');
  });

  it.each(['minimal', 'standard', 'full'])('preset %s preserves the projectFocus value and changes only thinkingOs', (preset) => {
    const result = handleContextCommand(makeCtx(workspaceDir, [preset]), fakeApi);
    expect(result.text).toContain('已应用预设');
    expect(result.text).toContain('预设不再修改它');
    const yaml = fs.readFileSync(configPath, 'utf-8');
    // projectFocus untouched.
    expect(yaml).toContain('projectFocus: full');
    // Egress authorization untouched.
    expect(yaml).not.toContain('sendPrincipleContext');
    // thinkingOs did change for minimal/standard (true → false).
    if (preset !== 'full') {
      expect(yaml).toContain('thinkingOs: false');
    }
  });

  it('help no longer documents focus as a working control', () => {
    const result = handleContextCommand(makeCtx(workspaceDir, ['help']), fakeApi);
    expect(result.text).not.toContain('/pd-context focus full/summary/off');
    expect(result.text).toContain('已弃用');
  });

  it('an invalid focus value is still refused (no config write)', () => {
    const before = sha256(fs.readFileSync(configPath));
    const result = handleContextCommand(makeCtx(workspaceDir, ['focus', 'on']), fakeApi);
    expect(result.text).toContain('无效值');
    expect(sha256(fs.readFileSync(configPath))).toBe(before);
  });
});
