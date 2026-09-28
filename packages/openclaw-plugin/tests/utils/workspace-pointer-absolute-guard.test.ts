import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// PRI-931: a workspace pointer that is not already absolute must never be
// resolved. "D:.openclawworkspace" is what "D:\.openclaw\workspace" becomes
// when its backslashes are lost in transit; path.resolve() turns that into a
// plausible path that depends on the process CWD, aiming governance state
// (.pd/state.db, .state/trajectory.db) at a different directory.
//
// os.homedir() cannot be redirected through env on every platform, so the
// module boundary is mocked instead — the real ~/.openclaw config of a dev
// machine must never leak into these assertions.
const homedir = vi.hoisted(() => ({ current: null as string | null }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: actual,
    homedir: () => homedir.current ?? actual.homedir(),
  };
});

const { resolveCanonicalWorkspaceDir, resolveCommandWorkspaceDir, resolveHookWorkspaceDir } = await import(
  '../../src/utils/workspace-resolver.js'
);

describe('non-absolute workspace pointers are rejected, not resolved', () => {
  const originalEnv = { ...process.env };
  let sandboxHome: string;
  let sessionWorkspace: string;

  const writePdConfig = (workspace: string): void => {
    fs.writeFileSync(
      path.join(sandboxHome, '.openclaw', 'principles-disciple.json'),
      JSON.stringify({ workspace, channels: ['prompt'], mvpFirst: true }),
      'utf8',
    );
  };

  const hostApi = () => ({
    runtime: { agent: { resolveAgentWorkspaceDir: vi.fn() } },
    config: {},
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  });

  beforeEach(() => {
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ws-pointer-home-'));
    sessionWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ws-pointer-session-'));
    homedir.current = sandboxHome;
    process.env = { ...originalEnv };
    delete process.env.PD_WORKSPACE_DIR;
    delete process.env.OPENCLAW_WORKSPACE;
    fs.mkdirSync(path.join(sandboxHome, '.openclaw'), { recursive: true });
  });

  afterEach(() => {
    homedir.current = null;
    process.env = { ...originalEnv };
    fs.rmSync(sandboxHome, { recursive: true, force: true });
    fs.rmSync(sessionWorkspace, { recursive: true, force: true });
  });

  it('ignores a drive-relative workspace in principles-disciple.json', () => {
    writePdConfig('D:.openclawworkspace');
    const result = resolveCanonicalWorkspaceDir();
    expect(result?.source).toBe('pd_default');
    expect(result?.workspaceDir).not.toContain('.openclawworkspace');
  });

  it('ignores a relative workspace in principles-disciple.json', () => {
    writePdConfig('relative/workspace');
    expect(resolveCanonicalWorkspaceDir()?.source).toBe('pd_default');
  });

  // path.isAbsolute accepts these on Windows, but path.resolve anchors them to
  // the calling process's drive — the same silent swap as a relative value.
  it('ignores a root-relative workspace in principles-disciple.json', () => {
    writePdConfig('\\workspace');
    const result = resolveCanonicalWorkspaceDir();
    expect(result?.source).toBe('pd_default');
    expect(result?.workspaceDir).not.toBe('\\workspace');
  });

  it('ignores a root-relative PD_WORKSPACE_DIR', () => {
    process.env.PD_WORKSPACE_DIR = '\\workspace';
    process.env.OPENCLAW_WORKSPACE = sessionWorkspace;
    expect(resolveCanonicalWorkspaceDir()?.source).toBe('openclaw_env');
  });

  // One bad config file must not disqualify a good pointer in the next one.
  it('keeps scanning config files after an unusable pointer', () => {
    writePdConfig('D:.openclawworkspace');
    const fallbackConfigDir = path.join(sandboxHome, '.principles');
    fs.mkdirSync(fallbackConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(fallbackConfigDir, 'principles-disciple.json'),
      JSON.stringify({ workspace: sessionWorkspace, mvpFirst: true }),
      'utf8',
    );

    expect(resolveCanonicalWorkspaceDir()).toEqual({
      workspaceDir: path.resolve(sessionWorkspace),
      source: 'pd_config',
    });
  });

  it('still honors an absolute workspace in principles-disciple.json', () => {
    writePdConfig(sessionWorkspace);
    expect(resolveCanonicalWorkspaceDir()).toEqual({
      workspaceDir: path.resolve(sessionWorkspace),
      source: 'pd_config',
    });
  });

  it('ignores a non-absolute PD_WORKSPACE_DIR and falls through to the next source', () => {
    process.env.PD_WORKSPACE_DIR = 'D:.openclawworkspace';
    process.env.OPENCLAW_WORKSPACE = sessionWorkspace;
    expect(resolveCanonicalWorkspaceDir()).toEqual({
      workspaceDir: path.resolve(sessionWorkspace),
      source: 'openclaw_env',
    });
  });

  // A refused pointer must never take the system down with it: the next
  // declared source still wins, and the order env > config > default holds.
  it('keeps source priority when the config pointer is refused but PD_WORKSPACE_DIR is valid', () => {
    writePdConfig('D:.openclawworkspace');
    process.env.PD_WORKSPACE_DIR = sessionWorkspace;
    expect(resolveCanonicalWorkspaceDir()).toEqual({
      workspaceDir: path.resolve(sessionWorkspace),
      source: 'pd_env',
    });
  });

  it('uses the live session workspace when the config pointer is not absolute', () => {
    writePdConfig('D:.openclawworkspace');
    const result = resolveHookWorkspaceDir({ workspaceDir: sessionWorkspace }, hostApi() as never, 'test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspaceDir).toBe(sessionWorkspace);
      expect(result.source).toBe('openclaw_context');
    }
  });

  // A silent fallback that changes which directory owns governance state is
  // the failure this guard prevents, so the refusal has to be reportable.
  it('reports the refused pointer, its reason and where resolution landed', () => {
    writePdConfig('D:.openclawworkspace');
    const result = resolveHookWorkspaceDir({ workspaceDir: sessionWorkspace }, hostApi() as never, 'test');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consistencyWarning).toContain('Workspace pointer rejected');
    expect(result.consistencyWarning).toContain('pd_config');
    expect(result.consistencyWarning).toContain('reason=not_absolute');
    expect(result.consistencyWarning).toContain('D:.openclawworkspace');
    expect(result.consistencyWarning).toContain('falling back to openclaw_context');
  });

  it('reports no warning when every declared source is usable', () => {
    writePdConfig(sessionWorkspace);
    const result = resolveHookWorkspaceDir({ workspaceDir: sessionWorkspace }, hostApi() as never, 'test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.consistencyWarning).toBeUndefined();
    }
  });

  it('logs the refused pointer on the command path too', () => {
    writePdConfig('D:.openclawworkspace');
    const api = hostApi();

    const resolved = resolveCommandWorkspaceDir(api as never, { workspaceDir: sessionWorkspace });

    expect(resolved).toBe(sessionWorkspace);
    const warned = api.logger.warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).toContain('Workspace pointer rejected');
    expect(warned).toContain('reason=not_absolute');
    expect(warned).toContain('falling back to openclaw_context');
  });
});
