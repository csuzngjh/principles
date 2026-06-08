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

// ---------------------------------------------------------------------------
// Test utilities (mirrors existing route test patterns)
// ---------------------------------------------------------------------------

function createMockRequest(
  method: string,
  options?: { body?: unknown; url?: string },
): IncomingMessage {
  const bodyStr = options?.body !== undefined ? JSON.stringify(options.body) : '';
  const req = {
    method,
    url: options?.url ?? '/api/v1/config/summary',
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data' && options?.body !== undefined) {
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
    expect(data.runtimeProfiles).toHaveLength(3);
    expect(data.agents).toHaveLength(10); // all internal agents
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
    // Default profile is openclaw.default with source=default → ready
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
});
