import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import * as yaml from 'js-yaml';
import type { IncomingMessage, ServerResponse } from 'node:http';

// -- Mock child_process.spawn -- we never want to actually run pd in tests --
// EP-06 (Source of Truth): the route must spawn `pd demo story-a`, not write
// SQLite directly. We mock spawn so we can assert argv without touching the DB.
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import {
  handleOnboardingRoute,
  disposeOnboardingModels,
} from '../../../src/server/routes/onboarding.js';

// -- Workspace fixtures --

let workspaceDir: string;
let pdDir: string;

function writeConfig(onboardingEnabled: boolean): void {
  const config = {
    version: 1,
    features: {
      new_user_onboarding: { category: 'quiet', enabled: onboardingEnabled },
    },
    runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'openclaw.default' },
        dreamer: { enabled: true },
        scribe: { enabled: true },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  };
  fs.writeFileSync(path.join(pdDir, 'config.yaml'), yaml.dump(config), 'utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-onboard-route-'));
  pdDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  writeConfig(true);
});

afterEach(() => {
  disposeOnboardingModels();
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// -- Mock req/res helpers (mirror intent.test.ts pattern) --

function makePostReq(url: string): IncomingMessage {
  const req = new EventEmitter();
  Object.assign(req, { method: 'POST', url });
  return req as unknown as IncomingMessage;
}

function makeGetReq(url: string): IncomingMessage {
  const req = new EventEmitter();
  Object.assign(req, { method: 'GET', url });
  return req as unknown as IncomingMessage;
}

function makeRes(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _body: '',
    writeHead: vi.fn(function (this: unknown, code: number) {
      (res as { statusCode: number }).statusCode = code;
      (res as { headersSent: boolean }).headersSent = true;
      return this;
    }),
    end: vi.fn(function (this: unknown, data?: string) {
      if (data !== undefined) {
        (res as { _body: string })._body = data;
      }
      return this;
    }),
  } as unknown as ServerResponse;
  return res;
}

function getBody(res: ServerResponse): string {
  return (res as unknown as { _body: string })._body;
}

function getStatus(res: ServerResponse): number {
  return (res as unknown as { statusCode: number }).statusCode;
}

function parseBody(res: ServerResponse): { success: boolean; data: Record<string, unknown> } {
  return JSON.parse(getBody(res)) as { success: boolean; data: Record<string, unknown> };
}

function parseError(res: ServerResponse): {
  success: boolean;
  error: string;
  message: string;
  reason?: string;
  nextAction?: string;
} {
  return JSON.parse(getBody(res)) as {
    success: boolean;
    error: string;
    message: string;
    reason?: string;
    nextAction?: string;
  };
}
/**
 * Build a mock ChildProcess that emits stdout data (the demo JSON) and then
 * fires the 'close' event with exit code 0 on the next tick, so the awaiting
 * Promise in handleRunDemo can resolve and return 200 with the demo result.
 */
function makeMockChildEmitSuccess(demoJson: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const child = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(cb);
      return child;
    }),
    stdout: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'data') {
          cb(Buffer.from(JSON.stringify(demoJson)));
        }
        return child;
      }),
    },
    stderr: {
      on: vi.fn(() => child),
    },
    kill: vi.fn(() => true),
  };
  // Schedule 'close' event emission on next tick so the Promise can attach listeners
  setTimeout(() => {
    handlers.close?.forEach(cb => cb(0));
  }, 0);
  return child as never;
}

// -- Tests --

describe('POST /api/v1/onboarding/run-demo', () => {
  it('Given flag enabled, When POST run-demo, Then spawns pd demo story-a and returns 200 with demo result', async () => {
    const demoResult = {
      status: 'passed',
      generatedAt: '2026-07-01T00:00:00Z',
      narrative: 'Demo narrative',
      storyDescription: 'Demo story',
      stages: [{ name: 'evidence_seed', status: 'passed' }],
      channelOutcomes: [],
      isRuntimeV2Exclusive: true,
    };
    vi.mocked(spawn).mockReturnValue(makeMockChildEmitSuccess(demoResult) as never);

    const res = makeRes();
    await handleOnboardingRoute(makePostReq('/api/v1/onboarding/run-demo'), res, {
      workspaceDir,
      subPath: '/run-demo',
    });

    // EP-06: spawn pd demo story-a --workspace <path> --json (not direct DB write)
    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin, argv, options] = vi.mocked(spawn).mock.calls[0]!;
    // P1-A: cmd is process.execPath (Node) when pd-cli's dist/index.js is
    // resolvable, or 'pd' as a PATH-based fallback. Accept either — the
    // behavioral contract is the argv, not the binary name.
    expect(bin).toBe(process.execPath);
    expect(argv[0]).toMatch(/[\\/]pd-cli[\\/]dist[\\/]index\.js$/);
    expect(argv).toEqual(expect.arrayContaining(['demo', 'story-a', '--json']));
    // P1-1: demo must run in a TEMP workspace, not the user's real workspaceDir,
    // to avoid polluting {workspace}/.pd/state.db with simulated demo data.
    const wsIndex = argv.indexOf('--workspace');
    expect(wsIndex).toBeGreaterThan(-1);
    const demoWorkspace = argv[wsIndex + 1];
    expect(demoWorkspace).not.toBe(workspaceDir);
    expect(demoWorkspace.startsWith(os.tmpdir())).toBe(true);
    expect(demoWorkspace).toContain('pd-onboarding-demo-');
    // P1-2: no shell:true — argv passed directly to OS to avoid command injection
    expect(options).toEqual(expect.not.objectContaining({ shell: true }));

    // 200 OK with validated demo result
    expect(getStatus(res)).toBe(200);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.data.simulated).toBe(true);
    expect(body.data.demo).toBeDefined();
    expect((body.data.demo as Record<string, unknown>).status).toBe('passed');
  });

  it('Given malformed stage elements, When POST run-demo, Then rejects the whole demo result', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockChildEmitSuccess({
      status: 'passed', generatedAt: '2026-07-01T00:00:00Z', narrative: 'Demo',
      stages: [{ name: 'valid', status: 'passed' }, null],
    }) as never);
    const res = makeRes();
    await handleOnboardingRoute(makePostReq('/api/v1/onboarding/run-demo'), res, {
      workspaceDir, subPath: '/run-demo',
    });
    expect(getStatus(res)).toBe(500);
    expect(parseError(res).error).toBe('demo_invalid_stdout');
  });
  it('Given flag disabled, When POST run-demo, Then returns 403 with reason and nextAction', async () => {
    writeConfig(false);

    const res = makeRes();
    await handleOnboardingRoute(makePostReq('/api/v1/onboarding/run-demo'), res, {
      workspaceDir,
      subPath: '/run-demo',
    });

    // EP-03: fail loud, observable degradation - must include reason + nextAction
    expect(spawn).not.toHaveBeenCalled();
    expect(getStatus(res)).toBe(403);
    const body = parseError(res);
    expect(body.success).toBe(false);
    expect(body.reason).toContain('disabled');
    expect(body.nextAction).toBeTruthy();
  });

  it('Given spawn throws synchronously, When POST run-demo, Then returns 500 with reason and nextAction (EP-03)', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('ENOENT: pd binary not found');
    });

    const res = makeRes();
    await handleOnboardingRoute(makePostReq('/api/v1/onboarding/run-demo'), res, {
      workspaceDir,
      subPath: '/run-demo',
    });

    expect(getStatus(res)).toBe(500);
    const body = parseError(res);
    expect(body.success).toBe(false);
    expect(body.reason).toContain('spawn');
    expect(body.nextAction).toBeTruthy();
  });

  it('Given GET method on /run-demo, When called, Then returns 405 method_not_allowed', async () => {
    const res = makeRes();
    await handleOnboardingRoute(makeGetReq('/api/v1/onboarding/run-demo'), res, {
      workspaceDir,
      subPath: '/run-demo',
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(getStatus(res)).toBe(405);
    const body = parseError(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain('method');
  });

  it('Given unknown subPath, When POST, Then returns 404 not_found', async () => {
    const res = makeRes();
    await handleOnboardingRoute(makePostReq('/api/v1/onboarding/unknown'), res, {
      workspaceDir,
      subPath: '/unknown',
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(getStatus(res)).toBe(404);
    const body = parseError(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain('not_found');
  });
});
