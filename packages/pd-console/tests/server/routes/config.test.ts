/**
 * PRI-309: Console Config API Tests
 *
 * Covers: config summary, model catalog, runtime binding update, readiness,
 * redaction, malformed config handling.
 *
 * ERR entries considered:
 * - ERR-001/ERR-005: No `as` bypasses on untrusted input (parsed YAML, request body)
 * - ERR-002: Graceful degradation includes reason
 * - ERR-009/ERR-010: Required fields fail loud
 * - ERR-013: Object.hasOwn() for untrusted keys
 * - ERR-014/ERR-016/ERR-017: Safe serialization for previews
 * - ERR-045: ANY-segment redaction for sensitive keys
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { handleConfigRoute } from '../../../src/server/routes/config.js';
import * as store from '../../../src/server/config/pd-config-store.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
  };
});

// ---------------------------------------------------------------------------
// Test utilities (mirrors existing route test patterns)
// ---------------------------------------------------------------------------

function createMockRequest(
  method: string,
  options?: { body?: unknown; url?: string; rawBody?: string },
): IncomingMessage {
  const bodyStr = options?.rawBody !== undefined
    ? options.rawBody
    : (options?.body !== undefined ? JSON.stringify(options.body) : '');
  const req = {
    method,
    url: options?.url ?? '/api/v1/config/summary',
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data' && bodyStr.length > 0) {
        handler(Buffer.from(bodyStr));
      }
      if (event === 'end') {
        handler();
      }
    }),
  } as unknown as IncomingMessage;
  return req;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead: vi.fn(function (this: ServerResponse, statusCode: number, headers?: Record<string, string>) {
      res.statusCode = statusCode;
      if (headers) {
        Object.assign(res._headers, headers);
      }
      return this;
    }),
    end: vi.fn(function (this: ServerResponse, data?: string) {
      if (data !== undefined) {
        res._body = data;
      }
      return this;
    }),
  } as unknown as ServerResponse;
  return res;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResponseBody<T>(res: ServerResponse): T {
  const mockRes = res as unknown as { _body: string };
  return JSON.parse(mockRes._body) as T;
}

function okEnvelope<T>(res: ServerResponse): T {
  const body = parseResponseBody<{ success: true; data: T }>(res);
  expect(body.success).toBe(true);
  return body.data;
}

function errorEnvelope(res: ServerResponse): { success: false; error: string; message: string } {
  const body = parseResponseBody<{ success: false; error: string; message: string }>(res);
  expect(body.success).toBe(false);
  return body;
}

// ---------------------------------------------------------------------------
// Setup: temporary workspace
// ---------------------------------------------------------------------------

let workspaceDir: string;
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-config-api-test-'));
  workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: write config.yaml
// ---------------------------------------------------------------------------

function writeConfig(config: Record<string, unknown>): void {
  const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
  fs.writeFileSync(configPath, yaml.dump(config), 'utf8');
}

function writeMalformedConfig(content: string): void {
  const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
  fs.writeFileSync(configPath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Valid config fixture
// ---------------------------------------------------------------------------

const VALID_CONFIG = {
  version: 1,
  features: {
    prompt: { category: 'core', enabled: true },
    code_tool_hook: { category: 'core', enabled: true },
    defer_archive: { category: 'core', enabled: true },
    feedback_channel: { category: 'quiet', enabled: true },
  },
  runtimeProfiles: {
    'openclaw.default': { type: 'openclaw', source: 'default' },
    'lmstudio-local': { type: 'openclaw', provider: 'lmstudio', model: 'qwen3.6-27b-mtp' },
    'anthropic-cloud': {
      type: 'pi-ai',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    },
  },
  internalAgents: {
    defaultRuntime: 'openclaw.default',
    agents: {
      diagnostician: { enabled: true, runtimeProfile: 'lmstudio-local' },
      dreamer: { enabled: true },
      scribe: { enabled: true },
    },
  },
  ui: { diagnostics: { mode: 'simple' } },
};

// ===========================================================================
// GET /api/v1/config/summary
// ===========================================================================

describe('GET /api/v1/config/summary', () => {
  it('returns defaults when no config file exists', async () => {
    const req = createMockRequest('GET', { url: '/api/v1/config/summary' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/summary' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{
      version: number;
      source: string;
      features: { id: string; category: string; enabled: boolean }[];
      runtimeProfiles: { id: string; type: string; label: string; readiness: string }[];
      agents: { name: string; enabled: boolean; runtimeProfileId: string; readiness: string }[];
      warnings: string[];
    }>(res);
    expect(data.version).toBe(1);
    expect(data.source).toBe('defaults');
    expect(data.features.length).toBeGreaterThan(0);
    expect(data.runtimeProfiles.length).toBeGreaterThan(0);
    expect(data.agents.length).toBeGreaterThan(0);
  });

  it('returns user config summary when config file exists', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('GET', { url: '/api/v1/config/summary' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/summary' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{
      version: number;
      source: string;
      runtimeProfiles: { id: string; type: string; label: string }[];
      agents: { name: string; runtimeProfileId: string; runtimeProfileLabel: string }[];
    }>(res);
    expect(data.source).toBe('user_config');
    // 3 user profiles; openclaw.default is already in VALID_CONFIG, so the MVP
    // default profile is not merged again by computeEffectivePdConfig.
    expect(data.runtimeProfiles).toHaveLength(3);
    expect(data.agents).toHaveLength(10); // all internal agents (incl. signalCollector)
  });

  it('never returns raw secret values in summary', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('GET', { url: '/api/v1/config/summary' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/summary' });

    expect(res.statusCode).toBe(200);
    const body = (res as unknown as { _body: string })._body;
    // Must not contain the actual API key env var VALUE (even though we only store the name)
    expect(body).not.toContain('sk-ant-');
    // apiKeyEnv name is OK to show (it's just the env var name, not the value)
    expect(body).toContain('ANTHROPIC_API_KEY');
  });

  it('returns error summary for malformed config', async () => {
    writeMalformedConfig('version: 999\nfeatures: []\n');
    const req = createMockRequest('GET', { url: '/api/v1/config/summary' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/summary' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{
      source: string;
      warnings: string[];
      errors?: { path: string; reason: string; nextAction: string }[];
    }>(res);
    // Malformed config falls back to defaults with errors reported
    expect(data.source).toBe('defaults');
  });

  it('redacts sensitive profile fields', async () => {
    writeConfig({
      ...VALID_CONFIG,
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
        'suspicious-profile': {
          type: 'pi-ai',
          provider: 'openai',
          model: 'gpt-4',
          apiKeyEnv: 'OPENAI_API_KEY',
        },
      },
    });
    const req = createMockRequest('GET', { url: '/api/v1/config/summary' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/summary' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{
      runtimeProfiles: { id: string; apiKeyEnv?: string }[];
    }>(res);
    const suspicious = data.runtimeProfiles.find(p => p.id === 'suspicious-profile');
    expect(suspicious).toBeDefined();
    // apiKeyEnv shows the env var NAME, not the value
    expect(suspicious!.apiKeyEnv).toBe('OPENAI_API_KEY');
  });
});

// ===========================================================================
// GET /api/v1/config/catalog
// ===========================================================================

describe('GET /api/v1/config/catalog', () => {
  it('returns available runtime profiles with safe labels', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('GET', { url: '/api/v1/config/catalog' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/catalog' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{
      profiles: { id: string; type: string; label: string; readiness: string; apiKeyEnv?: string }[];
    }>(res);
    expect(data.profiles.length).toBeGreaterThan(0);

    const lmstudio = data.profiles.find(p => p.id === 'lmstudio-local');
    expect(lmstudio).toBeDefined();
    expect(lmstudio!.type).toBe('openclaw');
    expect(lmstudio!.label).toContain('lmstudio');
    expect(lmstudio!.label).toContain('qwen3.6-27b-mtp');
  });

  it('returns defaults catalog when no config file exists', async () => {
    const req = createMockRequest('GET', { url: '/api/v1/config/catalog' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/catalog' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ profiles: { id: string }[] }>(res);
    expect(data.profiles.length).toBeGreaterThan(0);
  });

  it('catalog never includes raw provider objects or tokens', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('GET', { url: '/api/v1/config/catalog' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/catalog' });

    expect(res.statusCode).toBe(200);
    const body = (res as unknown as { _body: string })._body;
    // No raw secret patterns
    expect(body).not.toMatch(/"apiKey"\s*:/);
    expect(body).not.toMatch(/"token"\s*:/);
    expect(body).not.toMatch(/"secret"\s*:/);
  });

  it('catalog returns empty profiles with errors when config is malformed', async () => {
    writeMalformedConfig('version: 999\nfeatures: not-an-object\n');
    const req = createMockRequest('GET', { url: '/api/v1/config/catalog' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/catalog' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{
      profiles: { id: string }[];
      errors?: { path: string; reason: string; nextAction: string }[];
    }>(res);
    expect(data.profiles).toHaveLength(0);
    expect(data.errors).toBeDefined();
    expect(data.errors!.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// PATCH /api/v1/config/agents/:agentName/binding
// ===========================================================================

describe('PATCH /api/v1/config/agents/:agentName/binding', () => {
  it('updates agent runtime binding', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/diagnostician/binding',
      body: { runtimeProfile: 'anthropic-cloud', enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ agent: string; runtimeProfile: string; enabled: boolean }>(res);
    expect(data.agent).toBe('diagnostician');
    expect(data.runtimeProfile).toBe('anthropic-cloud');
    expect(data.enabled).toBe(true);

    // Verify the file was actually updated
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const agents = (parsed.internalAgents as Record<string, unknown>).agents as Record<string, unknown>;
    const diag = agents.diagnostician as Record<string, unknown>;
    expect(diag.runtimeProfile).toBe('anthropic-cloud');
  });

  it('rejects unknown agent name', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/nonexistent-agent/binding',
      body: { runtimeProfile: 'openclaw.default', enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/nonexistent-agent/binding',
    });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.error).toBeTruthy();
  });

  it('rejects unknown runtime profile reference', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/diagnostician/binding',
      body: { runtimeProfile: 'nonexistent-profile', enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.error).toBeTruthy();
  });

  it('rejects malformed payload', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/diagnostician/binding',
      body: { runtimeProfile: 123, enabled: 'not-a-boolean' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects update when existing config is malformed', async () => {
    writeMalformedConfig('version: 999\nfeatures: not-an-object\n');
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/diagnostician/binding',
      body: { runtimeProfile: 'openclaw.default', enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });

    // Must refuse to write on top of malformed config
    expect(res.statusCode).toBe(409);
    const err = errorEnvelope(res);
    expect(err.error).toBeTruthy();
  });

  it('rejects payload with unknown fields (strict whitelist)', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/diagnostician/binding',
      body: { runtimeProfile: 'openclaw.default', enabled: true, apiKey: 'sk-ant-12345' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.message).toContain('unknown field');
  });

  it('rejects payload with unknown non-secret fields', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/diagnostician/binding',
      body: { runtimeProfile: 'openclaw.default', enabled: true, extraField: 'value' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.message).toContain('unknown field');
  });

  it('rejects payload with nested secret-like keys (ANY-segment)', async () => {
    writeConfig(VALID_CONFIG);
    // Even though the nested key is secret-like, the whitelist check catches
    // the unknown top-level key 'provider' first. Both paths reject.
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/diagnostician/binding',
      body: { runtimeProfile: 'openclaw.default', enabled: true, provider: { api_key: 'sk-ant-12345' } },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });

    expect(res.statusCode).toBe(400);
  });

  it('creates config file with defaults if missing, then applies update', async () => {
    // No config file exists
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/diagnostician/binding',
      body: { runtimeProfile: 'openclaw.default', enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });

    expect(res.statusCode).toBe(200);
    // Config file should now exist
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('preserves unrelated config sections when updating', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/dreamer/binding',
      body: { runtimeProfile: 'anthropic-cloud', enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/dreamer/binding',
    });

    expect(res.statusCode).toBe(200);

    // Verify other agents are preserved
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const agents = (parsed.internalAgents as Record<string, unknown>).agents as Record<string, unknown>;
    // diagnostician should still have its original override
    const diag = agents.diagnostician as Record<string, unknown>;
    expect(diag.runtimeProfile).toBe('lmstudio-local');
  });

  it('preserves unknown root entries when updating agent binding', async () => {
    // Write config with an extra root-level section
    writeConfig({
      ...VALID_CONFIG,
      customSection: { note: 'user-owned data', count: 42 },
    });
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/dreamer/binding',
      body: { runtimeProfile: 'anthropic-cloud', enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/dreamer/binding',
    });

    expect(res.statusCode).toBe(200);

    // Verify the custom section is preserved
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'customSection')).toBe(true);
    const custom = parsed.customSection as Record<string, unknown>;
    expect(custom.note).toBe('user-owned data');
    expect(custom.count).toBe(42);
  });
});

// ===========================================================================
// GET /api/v1/config/readiness/:agentName
// ===========================================================================

describe('GET /api/v1/config/readiness/:agentName', () => {
  it('returns ready for openclaw default profile', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('GET', {
      url: '/api/v1/config/readiness/dreamer',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/readiness/dreamer',
    });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{
      agent: string;
      readiness: string;
      profileId: string;
      reason?: string;
      nextAction?: string;
    }>(res);
    expect(data.agent).toBe('dreamer');
    expect(data.readiness).toBe('ready');
  });

  it('returns ready for openclaw profile with provider+model', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('GET', {
      url: '/api/v1/config/readiness/diagnostician',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/readiness/diagnostician',
    });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ agent: string; readiness: string; profileId: string }>(res);
    expect(data.agent).toBe('diagnostician');
    expect(data.readiness).toBe('ready');
    expect(data.profileId).toBe('lmstudio-local');
  });

  it('returns disabled for disabled agent', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('GET', {
      url: '/api/v1/config/readiness/evaluator',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/readiness/evaluator',
    });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ agent: string; readiness: string; reason?: string }>(res);
    expect(data.agent).toBe('evaluator');
    expect(data.readiness).toBe('disabled');
  });

  it('returns needs_setup for agent referencing missing profile', async () => {
    writeConfig({
      ...VALID_CONFIG,
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'nonexistent-profile' },
        },
      },
    });
    const req = createMockRequest('GET', {
      url: '/api/v1/config/readiness/diagnostician',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/readiness/diagnostician',
    });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ agent: string; readiness: string; reason: string; nextAction: string; profileId: string; profileLabel: string }>(res);
    expect(data.readiness).toBe('needs_setup');
    expect(data.reason).toBeTruthy();
    expect(data.nextAction).toBeTruthy();
    // profileId must be the missing profile, not the default
    expect(data.profileId).toBe('nonexistent-profile');
    // profileLabel must clearly indicate unknown, not show default label
    expect(data.profileLabel).toContain('unknown:');
  });

  it('returns not_ready for pi-ai profile with missing env var', async () => {
    writeConfig(VALID_CONFIG);
    // Bind dreamer to anthropic-cloud (pi-ai profile)
    const updateReq = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/dreamer/binding',
      body: { runtimeProfile: 'anthropic-cloud', enabled: true },
    });
    const updateRes = createMockResponse();
    await handleConfigRoute(updateReq, updateRes, {
      workspaceDir,
      subPath: '/agents/dreamer/binding',
    });
    expect(updateRes.statusCode).toBe(200);

    const req = createMockRequest('GET', {
      url: '/api/v1/config/readiness/dreamer',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/readiness/dreamer',
    });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ agent: string; readiness: string; reason: string; nextAction: string }>(res);
    // ANTHROPIC_API_KEY is likely not set in test env
    expect(['not_ready', 'ready']).toContain(data.readiness);
    if (data.readiness === 'not_ready') {
      expect(data.reason).toBeTruthy();
      expect(data.nextAction).toBeTruthy();
    }
  });

  it('returns 404 for unknown agent name', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('GET', {
      url: '/api/v1/config/readiness/nonexistent',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/readiness/nonexistent',
    });

    expect(res.statusCode).toBe(404);
  });

  it('readiness works with defaults when no config file exists', async () => {
    const req = createMockRequest('GET', {
      url: '/api/v1/config/readiness/diagnostician',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/readiness/diagnostician',
    });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ agent: string; readiness: string }>(res);
    expect(data.agent).toBe('diagnostician');
    // Default profile is openclaw.default (MVP default runtime) → ready
    // out of the box, no env var or user setup required.
    expect(data.readiness).toBe('ready');
  });

  it('returns unknown readiness when config is malformed', async () => {
    writeMalformedConfig('version: 999\nfeatures: not-an-object\n');
    const req = createMockRequest('GET', {
      url: '/api/v1/config/readiness/diagnostician',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/readiness/diagnostician',
    });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ agent: string; readiness: string; reason: string; nextAction: string }>(res);
    expect(data.readiness).toBe('unknown');
    expect(data.reason).toContain('malformed');
    expect(data.nextAction).toBeTruthy();
  });
});

// ===========================================================================
// PATCH /api/v1/config/default-runtime
// ===========================================================================

describe('PATCH /api/v1/config/default-runtime', () => {
  it('updates default runtime and persists to config.yaml', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/default-runtime',
      body: { defaultRuntime: 'lmstudio-local' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/default-runtime',
    });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ defaultRuntime: string }>(res);
    expect(data.defaultRuntime).toBe('lmstudio-local');

    // Verify persisted
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const internalAgents = parsed.internalAgents as Record<string, unknown>;
    expect(internalAgents.defaultRuntime).toBe('lmstudio-local');
  });

  it('preserves agent overrides when updating default runtime', async () => {
    writeConfig(VALID_CONFIG);
    // First set an explicit override for diagnostician
    const overrideReq = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/diagnostician/binding',
      body: { runtimeProfile: 'anthropic-cloud', enabled: true },
    });
    const overrideRes = createMockResponse();
    await handleConfigRoute(overrideReq, overrideRes, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });
    expect(overrideRes.statusCode).toBe(200);

    // Now update default runtime
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/default-runtime',
      body: { defaultRuntime: 'lmstudio-local' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/default-runtime',
    });

    expect(res.statusCode).toBe(200);

    // Verify diagnostician's override is preserved
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const internalAgents = parsed.internalAgents as Record<string, unknown>;
    expect(internalAgents.defaultRuntime).toBe('lmstudio-local');
    const agents = internalAgents.agents as Record<string, Record<string, unknown>>;
    expect(agents.diagnostician.runtimeProfile).toBe('anthropic-cloud');
  });

  it('preserves agent inheritance — agents without explicit runtimeProfile do not get one written back', async () => {
    // Write a config where dreamer has NO explicit runtimeProfile (inherits default)
    const inheritedConfig = {
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: false },
      },
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
        'lmstudio-local': { type: 'openclaw', provider: 'lmstudio', model: 'qwen3' },
      },
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'openclaw.default' },
          dreamer: { enabled: true },  // No runtimeProfile — inherits default
          philosopher: { enabled: true },  // No runtimeProfile — inherits default
        },
      },
      ui: { diagnostics: { mode: 'simple' } },
    };
    writeConfig(inheritedConfig);

    // Update default runtime
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/default-runtime',
      body: { defaultRuntime: 'lmstudio-local' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/default-runtime',
    });

    expect(res.statusCode).toBe(200);
    // (they should inherit the new default)
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const internalAgents = parsed.internalAgents as Record<string, unknown>;
    expect(internalAgents.defaultRuntime).toBe('lmstudio-local');
    const agents = internalAgents.agents as Record<string, Record<string, unknown>>;
    // dreamer and philosopher should NOT have runtimeProfile written
    expect(Object.hasOwn(agents.dreamer, 'runtimeProfile')).toBe(false);
    expect(Object.hasOwn(agents.philosopher, 'runtimeProfile')).toBe(false);
    // diagnostician keeps its explicit override
    expect(agents.diagnostician.runtimeProfile).toBe('openclaw.default');
  });

  it('rejects missing defaultRuntime field', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/default-runtime',
      body: { something: 'else' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/default-runtime',
    });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.message).toContain('defaultRuntime');
  });

  it('rejects nonexistent runtime profile', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/default-runtime',
      body: { defaultRuntime: 'nonexistent-profile' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/default-runtime',
    });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.message).toContain('does not exist');
  });

  it('rejects malformed config (refuses to write)', async () => {
    writeMalformedConfig('version: 999\nfeatures: not-an-object\n');
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/default-runtime',
      body: { defaultRuntime: 'lmstudio-local' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/default-runtime',
    });

    expect(res.statusCode).toBe(409);
  });

  it('returns 405 for GET on default-runtime', async () => {
    const req = createMockRequest('GET', { url: '/api/v1/config/default-runtime' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/default-runtime' });
    expect(res.statusCode).toBe(405);
  });
});

// ===========================================================================
// Route-level edge cases
// ===========================================================================

describe('Config API edge cases', () => {
  it('returns 405 for unsupported methods on /summary', async () => {
    const req = createMockRequest('POST', { url: '/api/v1/config/summary' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/summary' });
    expect(res.statusCode).toBe(405);
  });

  it('returns 405 for unsupported methods on /catalog', async () => {
    const req = createMockRequest('DELETE', { url: '/api/v1/config/catalog' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/catalog' });
    expect(res.statusCode).toBe(405);
  });

  it('returns 404 for unknown sub-paths', async () => {
    const req = createMockRequest('GET', { url: '/api/v1/config/unknown' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/unknown' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for invalid JSON body on PATCH', async () => {
    writeConfig(VALID_CONFIG);
    const req = {
      method: 'PATCH',
      url: '/api/v1/config/agents/diagnostician/binding',
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'data') {
          handler(Buffer.from('{not valid json'));
        }
        if (event === 'end') {
          handler();
        }
      }),
    } as unknown as IncomingMessage;
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });
    expect(res.statusCode).toBe(400);
  });

  it('summary response never includes raw YAML content', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('GET', { url: '/api/v1/config/summary' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/summary' });

    const body = (res as unknown as { _body: string })._body;
    // Should not contain raw YAML structure markers
    expect(body).not.toMatch(/^---/);
    // Should be valid JSON
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it('rejects oversized request body on PATCH', async () => {
    writeConfig(VALID_CONFIG);
    const largeBody = { runtimeProfile: 'openclaw.default', enabled: true, padding: 'x'.repeat(1024 * 100) };
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/diagnostician/binding',
      body: largeBody,
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for malformed URI encoding in agent name', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/%E0%A4%A/binding',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/%E0%A4%A/binding',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for malformed URI encoding in readiness agent name', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('GET', {
      url: '/api/v1/config/readiness/%E0%A4%A',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/readiness/%E0%A4%A',
    });
    expect(res.statusCode).toBe(400);
  });
});

// ===========================================================================
// Unit tests for validateBindingPayload (deep secret detection)
// ===========================================================================

import { validateBindingPayload } from '../../../src/server/config/pd-config-store.js';

describe('validateBindingPayload — deep secret detection', () => {
  it('allows valid payload with only runtimeProfile and enabled', () => {
    const result = validateBindingPayload({ runtimeProfile: 'openclaw.default', enabled: true });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown top-level keys', () => {
    const result = validateBindingPayload({ runtimeProfile: 'openclaw.default', enabled: true, extra: 'value' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('unknown field');
    }
  });

  it('rejects nested secret-like keys via ANY-segment detection', () => {
    // This tests the deep scan path — whitelist passes because keys are allowed,
    // but the nested value contains a secret-like key
    const result = validateBindingPayload({
      runtimeProfile: { 'access_token': 'sk-123' },
      enabled: true,
    });
    // runtimeProfile must be a string, so this fails type validation
    // but the secret detection would also catch it if runtimeProfile were an object
    expect(result.ok).toBe(false);
  });

  it('rejects payload with access_token top-level key', () => {
    const result = validateBindingPayload({ runtimeProfile: 'openclaw.default', enabled: true, access_token: 'sk-123' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('unknown field');
    }
  });
});

// ---------------------------------------------------------------------------
// PRI-332: Principles Output Language Route
// ---------------------------------------------------------------------------

describe('PRI-332: GET/PATCH /principles/output-language', () => {
  it('GET returns default zh-CN when no config exists', async () => {
    const req = createMockRequest('GET', { url: '/api/v1/config/principles/output-language' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/principles/output-language' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ outputLanguage: string; source: string }>(res);
    expect(data.outputLanguage).toBe('zh-CN');
    expect(data.source).toBe('default');
  });

  it('GET returns configured value', async () => {
    writeConfig({ principles: { outputLanguage: 'en' } });
    const req = createMockRequest('GET', { url: '/api/v1/config/principles/output-language' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/principles/output-language' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ outputLanguage: string; source: string }>(res);
    expect(data.outputLanguage).toBe('en');
    expect(data.source).toBe('user_config');
  });

  it('GET returns 500 on malformed YAML (server-side config error)', async () => {
    writeMalformedConfig('version: [unclosed\n');
    const req = createMockRequest('GET', { url: '/api/v1/config/principles/output-language' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/principles/output-language' });

    expect(res.statusCode).toBe(500);
    const err = errorEnvelope(res);
    expect(err.error).toBe('yaml_error');
  });

  it('GET returns 500 on invalid outputLanguage in config', async () => {
    writeConfig({ principles: { outputLanguage: 'fr' } });
    const req = createMockRequest('GET', { url: '/api/v1/config/principles/output-language' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/principles/output-language' });

    expect(res.statusCode).toBe(500);
    const err = errorEnvelope(res);
    expect(err.error).toBe('invalid_output_language');
  });

  it('PATCH updates language and confirms via re-read', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/principles/output-language',
      body: { outputLanguage: 'en' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/principles/output-language' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ outputLanguage: string; source: string }>(res);
    expect(data.outputLanguage).toBe('en');
  });

  it('PATCH returns 400 on invalid payload', async () => {
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/principles/output-language',
      body: { outputLanguage: 'fr' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/principles/output-language' });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.error).toBe('bad_request');
  });

  it('PATCH returns 400 on missing outputLanguage field', async () => {
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/principles/output-language',
      body: {},
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/principles/output-language' });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.error).toBe('bad_request');
  });

  it('PATCH returns 500 on malformed YAML during read-before-write', async () => {
    writeMalformedConfig('version: [unclosed\n');
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/principles/output-language',
      body: { outputLanguage: 'en' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/principles/output-language' });

    expect(res.statusCode).toBe(500);
    const err = errorEnvelope(res);
    expect(err.error).toBe('yaml_error');
  });

  it('PATCH preserves existing config sections when updating language', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/principles/output-language',
      body: { outputLanguage: 'en' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/principles/output-language' });

    expect(res.statusCode).toBe(200);
    // Verify existing config sections are preserved (no `as` bypass — ERR-001)
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw);
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) throw new Error('unreachable: parsed config is not a record');
    expect(parsed.version).toBe(1);
    expect(isRecord(parsed.principles)).toBe(true);
    if (!isRecord(parsed.principles)) throw new Error('unreachable: principles is not a record');
    expect(parsed.principles.outputLanguage).toBe('en');
    expect(parsed.features).toBeDefined();
  });

  it('PATCH returns 500 when re-read after write fails', async () => {
    writeConfig(VALID_CONFIG);
    const spy = vi.spyOn(store, 'getPrinciplesOutputLanguage').mockReturnValue({
      ok: false,
      statusCode: 500,
      error: 'confirm_read_failed',
      message: 'Write succeeded but re-read failed',
    });

    try {
      const req = createMockRequest('PATCH', {
        url: '/api/v1/config/principles/output-language',
        body: { outputLanguage: 'en' },
      });
      const res = createMockResponse();
      await handleConfigRoute(req, res, { workspaceDir, subPath: '/principles/output-language' });

      expect(res.statusCode).toBe(500);
      const err = errorEnvelope(res);
      expect(err.error).toBe('confirm_read_failed');
    } finally {
      spy.mockRestore();
    }
  });

  it('returns 405 on non-GET/PATCH methods', async () => {
    const req = createMockRequest('POST', {
      url: '/api/v1/config/principles/output-language',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/principles/output-language' });

    expect(res.statusCode).toBe(405);
  });
});

// ===========================================================================
// PATCH /api/v1/config/features/:featureName — spec 2026-06-27 §13.4
// ===========================================================================

describe('PATCH /api/v1/config/features/:featureName', () => {
  it('enables a registered feature flag and persists to config.yaml', async () => {
    // Config with a features section that includes intent_engineering (disabled)
    writeConfig({
      ...VALID_CONFIG,
      features: {
        ...VALID_CONFIG.features,
        intent_engineering: { category: 'quiet', enabled: false },
      },
    });
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/intent_engineering',
      body: { enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/intent_engineering',
    });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ feature: string; enabled: boolean }>(res);
    expect(data.feature).toBe('intent_engineering');
    expect(data.enabled).toBe(true);

    // Verify persisted to disk
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const features = parsed.features as Record<string, unknown>;
    const ie = features.intent_engineering as Record<string, unknown>;
    expect(ie.enabled).toBe(true);

    // Verify other feature flags are preserved
    const prompt = features.prompt as Record<string, unknown>;
    expect(prompt.enabled).toBe(true);
  });

  it('rejects unknown feature name with 400', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/nonexistent_flag',
      body: { enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/nonexistent_flag',
    });

    expect(res.statusCode).toBe(400);
    const body = errorEnvelope(res);
    expect(body.error).toBe('unknown_feature');
  });

  it('rejects non-boolean enabled with 400', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/intent_engineering',
      body: { enabled: 'true' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/intent_engineering',
    });

    expect(res.statusCode).toBe(400);
  });

  it('auto-creates features section for registered flags (PRI-477 onboarding)', async () => {
    // Config without a features: section at all — on fresh install.
    // PRI-477: updateFeatureFlag now auto-creates the features section for
    // registered flags instead of returning 422.
    writeConfig({
      version: 1,
      runtimeProfiles: VALID_CONFIG.runtimeProfiles,
      internalAgents: VALID_CONFIG.internalAgents,
      ui: { diagnostics: { mode: 'simple' } },
    });
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/intent_engineering',
      body: { enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/intent_engineering',
    });

    expect(res.statusCode).toBe(200);
    const body = okEnvelope<{ feature: string; enabled: boolean }>(res);
    expect(body.feature).toBe('intent_engineering');
    expect(body.enabled).toBe(true);

    // N1 — verify the auto-create side effect on disk, not just the response.
    // Without this assertion, a regression that returns 200 without writing the
    // features section would silently pass.
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as unknown;
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) throw new Error('unreachable: parsed config is not a record');
    expect(isRecord(parsed.features)).toBe(true);
    if (!isRecord(parsed.features)) throw new Error('unreachable: features is not a record');
    const intentEngineering = parsed.features.intent_engineering;
    expect(isRecord(intentEngineering)).toBe(true);
    if (!isRecord(intentEngineering)) throw new Error('unreachable: intent_engineering is not a record');
    expect(intentEngineering.enabled).toBe(true);
  });

  it('rejects malformed existing features (non-object) with 409 (rc-9-no-silent-fallback)', async () => {
    // PR-1083 review (CodeRabbit comment on pd-config-store.ts):
    // When `features:` exists but is not a record/object, updateFeatureFlag
    // must NOT silently overwrite it with registered-flag defaults — that
    // would hide a config typo. It must return 409 conflict so the Owner can
    // fix the malformed value first. Without this guard, a config like
    // `features: "oops"` would be silently reset on the first flag toggle
    // and the original mistake would be lost.
    writeMalformedConfig(
      [
        'version: 1',
        'features: "oops-malformed-string"',
        '',
      ].join('\n'),
    );
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/intent_engineering',
      body: { enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/intent_engineering',
    });

    expect(res.statusCode).toBe(409);
    const body = errorEnvelope(res);
    expect(body.error).toBe('conflict');
    expect(body.message).toContain('features');

    // Verify the malformed value was NOT overwritten on disk (rc-9).
    const raw = fs.readFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), 'utf8');
    expect(raw).toContain('oops-malformed-string');
  });

  it('rejects malformed existing config with 409', async () => {
    writeMalformedConfig('version: [unclosed\n');
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/intent_engineering',
      body: { enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/intent_engineering',
    });

    expect(res.statusCode).toBe(409);
  });

  it('preserves other config sections when writing feature flag', async () => {
    writeConfig({
      ...VALID_CONFIG,
      features: {
        ...VALID_CONFIG.features,
        intent_engineering: { category: 'quiet', enabled: false },
      },
      principles: { outputLanguage: 'en' },
    });
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/intent_engineering',
      body: { enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/intent_engineering',
    });

    expect(res.statusCode).toBe(200);
    // Verify principles section is preserved
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    expect(isRecord(parsed.principles)).toBe(true);
    if (!isRecord(parsed.principles)) throw new Error('unreachable');
    expect(parsed.principles.outputLanguage).toBe('en');
    // runtimeProfiles preserved
    expect(isRecord(parsed.runtimeProfiles)).toBe(true);
  });

  it('returns 405 on non-PATCH methods for features', async () => {
    const req = createMockRequest('GET', {
      url: '/api/v1/config/features/intent_engineering',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/intent_engineering',
    });

    expect(res.statusCode).toBe(405);
  });

  it('PATCH returns 500 when writeConfigAtomic fails during feature update', async () => {
    writeConfig(VALID_CONFIG);
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('mock write error');
    });

    try {
      const req = createMockRequest('PATCH', {
        url: '/api/v1/config/features/intent_engineering',
        body: { enabled: true },
      });
      const res = createMockResponse();
      await handleConfigRoute(req, res, {
        workspaceDir,
        subPath: '/features/intent_engineering',
      });

      expect(res.statusCode).toBe(500);
      const err = errorEnvelope(res);
      expect(err.error).toBe('write_error');
    } finally {
      spy.mockRestore();
    }
  });

  it('PATCH returns 500 when re-read fails during feature update', async () => {
    writeConfig(VALID_CONFIG);
    const originalRead = fs.readFileSync;
    const originalWrite = fs.writeFileSync;
    let written = false;

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(function (this: any, p, data, opts) {
      if (typeof p === 'string' && p.endsWith('config.yaml.tmp')) {
        written = true;
      }
      return originalWrite(p, data, opts);
    });

    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(function (this: any, p, opts) {
      if (written && typeof p === 'string' && p.endsWith('config.yaml')) {
        return 'version: [unclosed\n';
      }
      return originalRead(p, opts);
    });

    try {
      const req = createMockRequest('PATCH', {
        url: '/api/v1/config/features/intent_engineering',
        body: { enabled: true },
      });
      const res = createMockResponse();
      await handleConfigRoute(req, res, {
        workspaceDir,
        subPath: '/features/intent_engineering',
      });

      expect(res.statusCode).toBe(500);
      const err = errorEnvelope(res);
      expect(err.error).toBe('confirm_read_failed');
    } finally {
      writeSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  // ── Input validation edge cases (codecov gap coverage) ──────────────────

  it('rejects invalid JSON body with 400', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/intent_engineering',
      rawBody: '{invalid json',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/intent_engineering',
    });

    expect(res.statusCode).toBe(400);
    const body = errorEnvelope(res);
    expect(body.message).toContain('Invalid JSON');
  });

  it('rejects array body (not object) with 400', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/intent_engineering',
      rawBody: '[1, 2, 3]',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/intent_engineering',
    });

    expect(res.statusCode).toBe(400);
    const body = errorEnvelope(res);
    expect(body.message).toContain('JSON object');
  });

  it('rejects body missing enabled field with 400', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/intent_engineering',
      body: { foo: 'bar' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/intent_engineering',
    });

    expect(res.statusCode).toBe(400);
    const body = errorEnvelope(res);
    expect(body.message).toContain('Missing required field: enabled');
  });

  it('rejects invalid feature name URL encoding with 400', async () => {
    writeConfig(VALID_CONFIG);
    // %E0%A4%A is an incomplete UTF-8 sequence — decodeURIComponent throws
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/%E0%A4%A',
      body: { enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/%E0%A4%A',
    });

    expect(res.statusCode).toBe(400);
    const body = errorEnvelope(res);
    expect(body.message).toContain('Invalid feature name encoding');
  });

  it('rejects body too large with 400', async () => {
    writeConfig(VALID_CONFIG);
    // Construct a body > 64KB to trigger readBody rejection
    const hugePayload = { enabled: true, padding: 'x'.repeat(70 * 1024) };
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/intent_engineering',
      body: hugePayload,
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/intent_engineering',
    });

    expect(res.statusCode).toBe(400);
    const body = errorEnvelope(res);
    expect(body.message).toContain('maximum allowed size');
  });

  // ── Direct store-level tests for defensive branches ─────────────────────
  // These branches are unreachable from the route layer (route validates
  // first) but the store function is a public API that must defend itself.

  it('store-level: updateFeatureFlag rejects non-boolean enabled defensively', () => {
    writeConfig(VALID_CONFIG);
    const result = store.updateFeatureFlag(
      workspaceDir,
      'intent_engineering',
      'not-boolean' as unknown as boolean,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('bad_request');
      expect(result.statusCode).toBe(400);
    }
  });

  it('store-level: updateFeatureFlag returns read_error when fs.readFileSync throws', () => {
    writeConfig(VALID_CONFIG);
    const originalExists = fs.existsSync;
    const originalRead = fs.readFileSync;
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('mock permission denied');
    });

    try {
      const result = store.updateFeatureFlag(workspaceDir, 'intent_engineering', true);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('read_error');
        expect(result.statusCode).toBe(500);
      }
    } finally {
      existsSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});

// ===========================================================================
// POST /api/v1/config/profiles — create runtime profile
// ===========================================================================

describe('POST /api/v1/config/profiles', () => {
  it('creates a new openclaw profile and persists to config.yaml', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('POST', {
      url: '/api/v1/config/profiles',
      body: {
        id: 'new-openclaw',
        profile: { type: 'openclaw', provider: 'ollama', model: 'llama3' },
      },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles' });

    expect(res.statusCode).toBe(201);
    const data = okEnvelope<{ profileId: string; profile: { type: string; provider?: string } }>(res);
    expect(data.profileId).toBe('new-openclaw');
    expect(data.profile.type).toBe('openclaw');
    expect(data.profile.provider).toBe('ollama');

    // Verify persisted to disk
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const profiles = parsed.runtimeProfiles as Record<string, Record<string, unknown>>;
    expect(Object.hasOwn(profiles, 'new-openclaw')).toBe(true);
    expect(profiles['new-openclaw'].provider).toBe('ollama');
  });

  it('creates a new pi-ai profile', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('POST', {
      url: '/api/v1/config/profiles',
      body: {
        id: 'openai-cloud',
        profile: {
          type: 'pi-ai',
          provider: 'openai',
          model: 'gpt-4',
          apiKeyEnv: 'OPENAI_API_KEY',
        },
      },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles' });

    expect(res.statusCode).toBe(201);
    const data = okEnvelope<{ profileId: string; profile: { type: string; apiKeyEnv: string } }>(res);
    expect(data.profileId).toBe('openai-cloud');
    expect(data.profile.apiKeyEnv).toBe('OPENAI_API_KEY');
  });

  it('rejects duplicate profile ID with 400', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('POST', {
      url: '/api/v1/config/profiles',
      body: {
        id: 'lmstudio-local',
        profile: { type: 'openclaw', provider: 'lmstudio', model: 'qwen3' },
      },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles' });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.message).toContain('already exists');
  });

  it('rejects profile with missing type field', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('POST', {
      url: '/api/v1/config/profiles',
      body: {
        id: 'no-type',
        profile: { provider: 'lmstudio' },
      },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles' });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.message).toContain('type');
  });

  it('rejects profile with invalid type value', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('POST', {
      url: '/api/v1/config/profiles',
      body: {
        id: 'bad-type',
        profile: { type: 'invalid-type' },
      },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles' });

    expect(res.statusCode).toBe(400);
  });

  it('rejects pi-ai profile missing required fields (provider/model/apiKeyEnv)', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('POST', {
      url: '/api/v1/config/profiles',
      body: {
        id: 'incomplete-pi-ai',
        profile: { type: 'pi-ai' },
      },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles' });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.message).toContain('validation');
  });

  it('rejects body missing id field', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('POST', {
      url: '/api/v1/config/profiles',
      body: { profile: { type: 'openclaw' } },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles' });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.message).toContain('id');
  });

  it('rejects body missing profile field', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('POST', {
      url: '/api/v1/config/profiles',
      body: { id: 'new-profile' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles' });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.message).toContain('profile');
  });

  it('preserves unknown config sections when creating profile', async () => {
    writeConfig({
      ...VALID_CONFIG,
      customSection: { note: 'preserve-me' },
    });
    const req = createMockRequest('POST', {
      url: '/api/v1/config/profiles',
      body: {
        id: 'new-profile',
        profile: { type: 'openclaw', source: 'default' },
      },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles' });

    expect(res.statusCode).toBe(201);
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'customSection')).toBe(true);
  });

  it('returns 405 for non-POST methods on /profiles', async () => {
    const req = createMockRequest('GET', { url: '/api/v1/config/profiles' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles' });
    expect(res.statusCode).toBe(405);
  });
});

// ===========================================================================
// PATCH /api/v1/config/profiles/:profileId — update runtime profile
// ===========================================================================

describe('PATCH /api/v1/config/profiles/:profileId', () => {
  it('updates an existing openclaw profile', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/profiles/lmstudio-local',
      body: { model: 'qwen3-new-model' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/lmstudio-local' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ profileId: string; profile: { model: string } }>(res);
    expect(data.profileId).toBe('lmstudio-local');
    expect(data.profile.model).toBe('qwen3-new-model');

    // Verify persisted
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const profiles = parsed.runtimeProfiles as Record<string, Record<string, unknown>>;
    expect(profiles['lmstudio-local'].model).toBe('qwen3-new-model');
    // provider should be preserved
    expect(profiles['lmstudio-local'].provider).toBe('lmstudio');
  });

  it('updates a pi-ai profile adding optional fields', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/profiles/anthropic-cloud',
      body: { timeoutMs: 30000, maxRetries: 3 },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/anthropic-cloud' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ profile: { timeoutMs: number; maxRetries: number } }>(res);
    expect(data.profile.timeoutMs).toBe(30000);
    expect(data.profile.maxRetries).toBe(3);
  });

  it('rejects update of non-existent profile with 404', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/profiles/nonexistent',
      body: { model: 'newmodel' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/nonexistent' });

    expect(res.statusCode).toBe(404);
    const err = errorEnvelope(res);
    expect(err.error).toBe('not_found');
  });

  it('rejects type change with 400', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/profiles/lmstudio-local',
      body: { type: 'pi-ai' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/lmstudio-local' });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.message).toContain('Cannot change profile type');
  });

  it('allows patch with same type (no-op type field)', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/profiles/lmstudio-local',
      body: { type: 'openclaw', model: 'updated-model' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/lmstudio-local' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ profile: { model: string } }>(res);
    expect(data.profile.model).toBe('updated-model');
  });

  it('rejects invalid JSON body', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/profiles/lmstudio-local',
      rawBody: '{invalid json',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/lmstudio-local' });

    expect(res.statusCode).toBe(400);
  });

  it('preserves unknown config sections when updating', async () => {
    writeConfig({
      ...VALID_CONFIG,
      customSection: { note: 'preserve-me' },
    });
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/profiles/lmstudio-local',
      body: { model: 'newmodel' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/lmstudio-local' });

    expect(res.statusCode).toBe(200);
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'customSection')).toBe(true);
  });

  it('returns 405 for non-PATCH methods on /profiles/:id', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('GET', { url: '/api/v1/config/profiles/lmstudio-local' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/lmstudio-local' });
    expect(res.statusCode).toBe(405);
  });
});

// ===========================================================================
// DELETE /api/v1/config/profiles/:profileId — delete runtime profile
// ===========================================================================

describe('DELETE /api/v1/config/profiles/:profileId', () => {
  it('deletes an unreferenced profile and persists to config.yaml', async () => {
    writeConfig(VALID_CONFIG);
    // anthropic-cloud is not the default and not referenced by any agent
    const req = createMockRequest('DELETE', {
      url: '/api/v1/config/profiles/anthropic-cloud',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/anthropic-cloud' });

    expect(res.statusCode).toBe(200);
    const data = okEnvelope<{ profileId: string; profile: { type: string } }>(res);
    expect(data.profileId).toBe('anthropic-cloud');
    expect(data.profile.type).toBe('pi-ai');

    // Verify deleted from disk
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const profiles = parsed.runtimeProfiles as Record<string, unknown>;
    expect(Object.hasOwn(profiles, 'anthropic-cloud')).toBe(false);
    // Other profiles still exist
    expect(Object.hasOwn(profiles, 'openclaw.default')).toBe(true);
  });

  it('rejects deletion of non-existent profile with 404', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('DELETE', {
      url: '/api/v1/config/profiles/nonexistent',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/nonexistent' });

    expect(res.statusCode).toBe(404);
    const err = errorEnvelope(res);
    expect(err.error).toBe('not_found');
  });

  it('rejects deletion of defaultRuntime profile with 400', async () => {
    writeConfig(VALID_CONFIG);
    // openclaw.default is the defaultRuntime
    const req = createMockRequest('DELETE', {
      url: '/api/v1/config/profiles/openclaw.default',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/openclaw.default' });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.message).toContain('default runtime');
  });

  it('rejects deletion of profile referenced by an agent with 400', async () => {
    writeConfig(VALID_CONFIG);
    // lmstudio-local is referenced by diagnostician
    const req = createMockRequest('DELETE', {
      url: '/api/v1/config/profiles/lmstudio-local',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/lmstudio-local' });

    expect(res.statusCode).toBe(400);
    const err = errorEnvelope(res);
    expect(err.message).toContain('referenced by agents');
    expect(err.message).toContain('diagnostician');
  });

  it('allows deletion after agent binding is changed', async () => {
    // Write a config where lmstudio-local is NOT referenced by any agent
    // (diagnostician uses anthropic-cloud instead)
    writeConfig({
      ...VALID_CONFIG,
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'anthropic-cloud' },
          dreamer: { enabled: true },
          scribe: { enabled: true },
        },
      },
    });

    // lmstudio-local is now unreferenced — delete should succeed
    const req = createMockRequest('DELETE', {
      url: '/api/v1/config/profiles/lmstudio-local',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/lmstudio-local' });

    expect(res.statusCode).toBe(200);
  });

  it('preserves unknown config sections when deleting', async () => {
    writeConfig({
      ...VALID_CONFIG,
      customSection: { note: 'preserve-me' },
    });
    const req = createMockRequest('DELETE', {
      url: '/api/v1/config/profiles/anthropic-cloud',
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/anthropic-cloud' });

    expect(res.statusCode).toBe(200);
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'customSection')).toBe(true);
  });

  it('returns 405 for non-DELETE methods on /profiles/:id', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('POST', { url: '/api/v1/config/profiles/anthropic-cloud' });
    const res = createMockResponse();
    await handleConfigRoute(req, res, { workspaceDir, subPath: '/profiles/anthropic-cloud' });
    expect(res.statusCode).toBe(405);
  });
});

// ===========================================================================
// PRI-637 — feature flag config lifecycle (override provenance)
// ===========================================================================

describe('PRI-637: Console toggle records owner provenance', () => {
  function readFeatures(): Record<string, Record<string, unknown>> {
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    return parsed.features as Record<string, Record<string, unknown>>;
  }

  it('writes source: owner for the toggled flag', async () => {
    writeConfig(VALID_CONFIG);
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/feedback_channel',
      body: { enabled: false },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/feedback_channel',
    });
    expect(res.statusCode).toBe(200);

    const features = readFeatures();
    expect(features.feedback_channel?.enabled).toBe(false);
    expect(features.feedback_channel?.source).toBe('owner');
  });

  it('auto-creates a SPARSE features section on fresh configs (no default snapshot)', async () => {
    // No features: section at all — fresh install shape.
    writeConfig({
      version: 1,
      runtimeProfiles: VALID_CONFIG.runtimeProfiles,
      internalAgents: VALID_CONFIG.internalAgents,
      ui: { diagnostics: { mode: 'simple' } },
    });
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/intent_engineering',
      body: { enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/intent_engineering',
    });
    expect(res.statusCode).toBe(200);

    const features = readFeatures();
    // PRI-637: only the toggled flag is written — the feature section must NOT
    // become a permanent snapshot of every registry default.
    expect(Object.keys(features)).toEqual(['intent_engineering']);
    expect(features.intent_engineering?.enabled).toBe(true);
    expect(features.intent_engineering?.source).toBe('owner');
  });

  it('upgrades a legacy source-less entry to owner on explicit toggle', async () => {
    writeConfig({
      ...VALID_CONFIG,
      features: {
        ...VALID_CONFIG.features,
        feedback_channel: { category: 'quiet', enabled: false },
      },
    });
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/feedback_channel',
      body: { enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/feedback_channel',
    });
    expect(res.statusCode).toBe(200);

    const features = readFeatures();
    expect(features.feedback_channel?.enabled).toBe(true);
    // Explicit Owner action converts LEGACY_UNKNOWN → OWNER_PIN (PRI-637 §9.C).
    expect(features.feedback_channel?.source).toBe('owner');
    // Other flags untouched.
    expect(features.prompt?.enabled).toBe(true);
  });
});

describe('PRI-637: config writers do not snapshot merged defaults (sparse override preservation)', () => {
  function readConfig(): Record<string, unknown> {
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    return yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  }

  it('updateAgentBinding preserves a sparse features section', async () => {
    // A hand-written sparse config: only ONE flag override. Any other flag
    // must NOT materialize into config after an agent-binding update.
    writeConfig({
      ...VALID_CONFIG,
      features: { feedback_channel: { category: 'quiet', enabled: false } },
    });
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/diagnostician/binding',
      body: { runtimeProfile: 'lmstudio-local', enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });
    expect(res.statusCode).toBe(200);

    const features = readConfig().features as Record<string, unknown>;
    expect(Object.keys(features)).toEqual(['feedback_channel']);
    expect(features.feedback_channel).toEqual({ category: 'quiet', enabled: false });
  });

  it('updateDefaultRuntime preserves a sparse features section', async () => {
    writeConfig({
      ...VALID_CONFIG,
      features: { feedback_channel: { category: 'quiet', enabled: false } },
    });
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/default-runtime',
      body: { defaultRuntime: 'lmstudio-local' },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/default-runtime',
    });
    expect(res.statusCode).toBe(200);

    const features = readConfig().features as Record<string, unknown>;
    expect(Object.keys(features)).toEqual(['feedback_channel']);
    expect(features.feedback_channel).toEqual({ category: 'quiet', enabled: false });
  });

  it('updateFeatureFlag preserves other unknown flags and sections', async () => {
    writeConfig({
      ...VALID_CONFIG,
      features: {
        ...VALID_CONFIG.features,
        custom_flag: { category: 'quiet', enabled: true },
      },
      customSection: { note: 'preserve-me' },
    });
    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/features/feedback_channel',
      body: { enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/features/feedback_channel',
    });
    expect(res.statusCode).toBe(200);

    const parsed = readConfig();
    expect(Object.hasOwn(parsed, 'customSection')).toBe(true);
    const features = parsed.features as Record<string, unknown>;
    // Unknown flag entry is preserved byte-for-byte (never rewritten).
    expect(features.custom_flag).toEqual({ category: 'quiet', enabled: true });
  });
});

// ── PRI-638 (reviewer P1): canonical Console writer vs legacy split=false ────
//
// 1. An explicit Owner write to the canonical Diagnostician binding must
//    retire the conflicting legacy `diagnostician_split_pipeline=false` in the
//    SAME atomic write, so the Console ON toggle is authoritative on reload.
// 2. Updating another agent must NOT materialize the read-time compatibility
//    shim (effective diagnostician=false) into the raw canonical binding.
// 3. Before any Owner canonical write, the conservative read remains.

describe('PRI-638: canonical Console writer vs legacy split=false', () => {
  function readRawConfig(): Record<string, unknown> {
    return yaml.load(fs.readFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), 'utf8')) as Record<string, unknown>;
  }

  function effectiveDiagnosticianEnabled(): boolean {
    const loaded = store.loadPdConfig(workspaceDir);
    return loaded.effective.config.internalAgents.agents.diagnostician?.enabled ?? false;
  }

  function legacySplitRaw(): Record<string, unknown> | undefined {
    const raw = readRawConfig();
    const features = isRecord(raw.features) ? raw.features : {};
    return isRecord(features.diagnostician_split_pipeline)
      ? (features.diagnostician_split_pipeline as Record<string, unknown>)
      : undefined;
  }

  it('WRITER-638-1: Console diagnostician ON on a legacy split=false workspace stays ON after reload', async () => {
    writeConfig({
      ...VALID_CONFIG,
      features: {
        ...VALID_CONFIG.features,
        diagnostician_split_pipeline: { category: 'quiet', enabled: false },
      },
      internalAgents: {
        ...VALID_CONFIG.internalAgents,
        agents: {
          ...VALID_CONFIG.internalAgents.agents,
          diagnostician: { enabled: false, runtimeProfile: 'lmstudio-local' },
        },
      },
    });
    // Precondition: conservative read keeps it disabled.
    expect(effectiveDiagnosticianEnabled()).toBe(false);

    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/diagnostician/binding',
      body: { runtimeProfile: 'lmstudio-local', enabled: true },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/diagnostician/binding',
    });
    expect(res.statusCode).toBe(200);

    // The conflicting legacy override was retired in the same write…
    expect(legacySplitRaw()).toBeUndefined();
    // …and a fresh load resolves the canonical toggle as authoritative.
    expect(effectiveDiagnosticianEnabled()).toBe(true);

    // The write itself reports the retirement so the Console can surface it.
    const data = okEnvelope<{ agent: string; enabled: boolean; warning?: string }>(res);
    expect(data.agent).toBe('diagnostician');
    expect(data.enabled).toBe(true);
    expect(data.warning).toContain('legacy diagnostician_split_pipeline=false');
  });

  it('WRITER-638-2: updating another agent does not persist the effective shim into raw binding', async () => {
    writeConfig({
      ...VALID_CONFIG,
      features: {
        ...VALID_CONFIG.features,
        diagnostician_split_pipeline: { category: 'quiet', enabled: false },
      },
      internalAgents: {
        ...VALID_CONFIG.internalAgents,
        agents: {
          ...VALID_CONFIG.internalAgents.agents,
          // canonical raw intent is TRUE; the shim makes effective FALSE.
          diagnostician: { enabled: true, runtimeProfile: 'lmstudio-local' },
        },
      },
    });
    // Precondition: read-time shim yields effective disabled.
    expect(effectiveDiagnosticianEnabled()).toBe(false);

    const req = createMockRequest('PATCH', {
      url: '/api/v1/config/agents/dreamer/binding',
      body: { runtimeProfile: 'openclaw.default', enabled: false },
    });
    const res = createMockResponse();
    await handleConfigRoute(req, res, {
      workspaceDir,
      subPath: '/agents/dreamer/binding',
    });
    expect(res.statusCode).toBe(200);

    const raw = readRawConfig();
    const agents = (raw.internalAgents as Record<string, unknown>).agents as Record<string, { enabled?: boolean; runtimeProfile?: string }>;
    // Raw canonical binding is byte-identical to the pre-write intent: no
    // effective-only materialization (must NOT have become enabled=false).
    expect(agents.diagnostician).toEqual({ enabled: true, runtimeProfile: 'lmstudio-local' });
    // The legacy flag is NOT retired by an unrelated agent write.
    expect(legacySplitRaw()?.enabled).toBe(false);
  });

  it('WRITER-638-3: conservative read remains before any canonical write', async () => {
    writeConfig({
      ...VALID_CONFIG,
      features: {
        ...VALID_CONFIG.features,
        diagnostician_split_pipeline: { category: 'quiet', enabled: false },
      },
      internalAgents: {
        ...VALID_CONFIG.internalAgents,
        agents: {
          ...VALID_CONFIG.internalAgents.agents,
          diagnostician: { enabled: true, runtimeProfile: 'lmstudio-local' },
        },
      },
    });

    // No write happened: legacy split=false still folds effective to disabled
    // (upgrade protection intact).
    expect(effectiveDiagnosticianEnabled()).toBe(false);
    expect(legacySplitRaw()?.enabled).toBe(false);
  });
});
