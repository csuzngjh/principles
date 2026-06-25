import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleIntentRoute, disposeIntentModels } from '../../../src/server/routes/intent.js';

let workspaceDir: string;
let pdDir: string;
let principlesDir: string;

// Mock helpers that store state on the mock object itself (not closures)
// to avoid destructuring-copy issues.

function makeReq(method: string): IncomingMessage {
  return { method, url: '/api/v1/intent' } as unknown as IncomingMessage;
}

function makeRes(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _body: '',
    writeHead: vi.fn(function (this: ServerResponse, code: number) {
      (res as { statusCode: number }).statusCode = code;
      return this;
    }),
    end: vi.fn(function (this: ServerResponse, data?: string) {
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

function writeConfig(intentEnabled: boolean): void {
  const config = {
    version: 1,
    features: { intent_engineering: { category: 'quiet', enabled: intentEnabled } },
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

function writeIntent(content: string): void {
  fs.writeFileSync(path.join(principlesDir, 'INTENT.md'), content, 'utf8');
}

const VALID_INTENT = `# INTENT.md

## 1. Why

This project validates pain from repeatedly correcting Agents.

## 2. Desired Outcome

A new user understands PD within five minutes.

## 3. Non-negotiables

- Do not make PD a heavy Agent platform.
- Do not increase Owner attention burden.

## 4. Stop / Escalation

If a change expands PD into orchestration, stop and ask Owner.

## 5. Current Strategic Focus

Validate the smallest loop: Pain to Principle to Delta.
`;

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-intent-route-'));
  pdDir = path.join(workspaceDir, '.pd');
  principlesDir = path.join(workspaceDir, '.principles');
  fs.mkdirSync(pdDir, { recursive: true });
  fs.mkdirSync(principlesDir, { recursive: true });
});

afterEach(() => {
  disposeIntentModels();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Intent route — method guard', () => {
  it('POST returns 405', async () => {
    const res = makeRes();
    await handleIntentRoute(makeReq('POST'), res, workspaceDir);
    expect(getStatus(res)).toBe(405);
  });

  it('DELETE returns 405', async () => {
    const res = makeRes();
    await handleIntentRoute(makeReq('DELETE'), res, workspaceDir);
    expect(getStatus(res)).toBe(405);
  });
});

describe('Intent route — flag-disabled', () => {
  it('returns flag_disabled when no config file exists (defaults)', async () => {
    const res = makeRes();
    await handleIntentRoute(makeReq('GET'), res, workspaceDir);
    const parsed = parseBody(res);
    expect(parsed.success).toBe(true);
    expect(parsed.data.ok).toBe(false);
    expect(parsed.data.reason).toBe('flag_disabled');
  });

  it('returns flag_disabled when config explicitly disables flag', async () => {
    writeConfig(false);
    const res = makeRes();
    await handleIntentRoute(makeReq('GET'), res, workspaceDir);
    const parsed = parseBody(res);
    expect(parsed.data.reason).toBe('flag_disabled');
  });
});

describe('Intent route — flag-on', () => {
  it('returns not_found when INTENT.md is missing', async () => {
    writeConfig(true);
    const res = makeRes();
    await handleIntentRoute(makeReq('GET'), res, workspaceDir);
    const parsed = parseBody(res);
    expect(parsed.data.ok).toBe(false);
    expect(parsed.data.reason).toBe('not_found');
  });

  it('returns oversized for file > 32KB', async () => {
    writeConfig(true);
    writeIntent('# INTENT.md\n\n## 1. Why\n\n' + 'x'.repeat(33 * 1024) + '\n');
    const res = makeRes();
    await handleIntentRoute(makeReq('GET'), res, workspaceDir);
    const parsed = parseBody(res);
    expect(parsed.data.reason).toBe('oversized');
  });

  it('returns parsed sections for valid INTENT.md', async () => {
    writeConfig(true);
    writeIntent(VALID_INTENT);
    const res = makeRes();
    await handleIntentRoute(makeReq('GET'), res, workspaceDir);
    const parsed = parseBody(res);
    expect(parsed.data.ok).toBe(true);
    expect(parsed.data.found).toBe(true);
    expect(parsed.data.flagEnabled).toBe(true);
    expect(parsed.data.contentHash).toMatch(/^sha256:/);
    expect(parsed.data.sections).toBeDefined();
    const sections = parsed.data.sections as Record<string, string>;
    expect(sections.why).toContain('correcting Agents');
    expect(parsed.data.warnings).toEqual([]);
  });

  it('returns missing_section warnings for partial INTENT.md', async () => {
    writeConfig(true);
    writeIntent(`# INTENT.md\n\n## 1. Why\n\nJust the why.\n`);
    const res = makeRes();
    await handleIntentRoute(makeReq('GET'), res, workspaceDir);
    const parsed = parseBody(res);
    expect(parsed.data.ok).toBe(true);
    const warnings = parsed.data.warnings as unknown[];
    expect(warnings.length).toBe(4);
  });
});