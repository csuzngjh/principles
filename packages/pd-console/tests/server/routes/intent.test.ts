import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import * as yaml from 'js-yaml';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleIntentRoute, disposeIntentModels } from '../../../src/server/routes/intent.js';

let workspaceDir: string;
let pdDir: string;
let principlesDir: string;

// ── Mock req/res helpers ────────────────────────────────────────────────────

function makeGetReq(url: string): IncomingMessage {
  const req = new EventEmitter();
  Object.assign(req, { method: 'GET', url });
  return req as unknown as IncomingMessage;
}

function makePostReq(url: string, body: unknown): IncomingMessage {
  const req = new EventEmitter();
  Object.assign(req, { method: 'POST', url });
  setImmediate(() => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    req.emit('data', Buffer.from(bodyStr, 'utf8'));
    req.emit('end');
  });
  return req as unknown as IncomingMessage;
}

function makePutReq(url: string, body: unknown): IncomingMessage {
  const req = new EventEmitter();
  Object.assign(req, { method: 'PUT', url });
  setImmediate(() => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    req.emit('data', Buffer.from(bodyStr, 'utf8'));
    req.emit('end');
  });
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

// ── Workspace setup ─────────────────────────────────────────────────────────

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

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-intent-route-'));
  pdDir = path.join(workspaceDir, '.pd');
  principlesDir = path.join(workspaceDir, '.principles');
  fs.mkdirSync(pdDir, { recursive: true });
  fs.mkdirSync(principlesDir, { recursive: true });
  writeConfig(true);
});

afterEach(() => {
  disposeIntentModels();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── GET /api/v1/intent (existing, smoke test) ───────────────────────────────

describe('Intent route — GET /api/v1/intent', () => {
  it('returns summary with flag_enabled=true', async () => {
    const res = makeRes();
    await handleIntentRoute(makeGetReq('/api/v1/intent'), res, { workspaceDir, subPath: '' });
    expect(getStatus(res)).toBe(200);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.data.flagEnabled).toBe(true);
    expect(body.data.found).toBe(false); // no INTENT.md yet
  });

  it('returns 403 when flag is disabled', async () => {
    writeConfig(false);
    const res = makeRes();
    await handleIntentRoute(makeGetReq('/api/v1/intent'), res, { workspaceDir, subPath: '' });
    expect(getStatus(res)).toBe(200); // GET returns summary with flagEnabled=false
    const body = parseBody(res);
    expect(body.data.flagEnabled).toBe(false);
    expect(body.data.reason).toBe('flag_disabled');
  });
});

// ── POST /api/v1/intent/init ────────────────────────────────────────────────

describe('Intent route — POST /api/v1/intent/init', () => {
  it('creates INTENT.md template (201)', async () => {
    const res = makeRes();
    await handleIntentRoute(makePostReq('/api/v1/intent/init', {}), res, { workspaceDir, subPath: '/init' });
    expect(getStatus(res)).toBe(201);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.data.created).toBe(true);
    expect(body.data.path).toContain('INTENT.zh-CN.md');

    // Verify file exists on disk
    const intentPath = path.join(principlesDir, 'INTENT.zh-CN.md');
    expect(fs.existsSync(intentPath)).toBe(true);
    const content = fs.readFileSync(intentPath, 'utf8');
    expect(content).toContain('# INTENT.md');
    expect(content).toContain('## 1. Why');
  });

  it('returns 200 with created=false when file already exists', async () => {
    // Pre-create the file
    fs.writeFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'existing content', 'utf8');

    const res = makeRes();
    await handleIntentRoute(makePostReq('/api/v1/intent/init', {}), res, { workspaceDir, subPath: '/init' });
    expect(getStatus(res)).toBe(200);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.data.created).toBe(false);
    expect(body.data.reason).toBe('already_exists');

    // Verify file was NOT overwritten
    const content = fs.readFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'utf8');
    expect(content).toBe('existing content');
  });

  it('overwrites existing file when force=true', async () => {
    fs.writeFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'old content', 'utf8');

    const res = makeRes();
    await handleIntentRoute(makePostReq('/api/v1/intent/init', { force: true }), res, { workspaceDir, subPath: '/init' });
    expect(getStatus(res)).toBe(201);
    const body = parseBody(res);
    expect(body.data.created).toBe(true);

    // Verify file WAS overwritten with template
    const content = fs.readFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'utf8');
    expect(content).toContain('# INTENT.md');
    expect(content).not.toContain('old content');
  });

  it('creates .principles directory if it does not exist', async () => {
    // Remove the .principles directory
    fs.rmSync(principlesDir, { recursive: true, force: true });
    expect(fs.existsSync(principlesDir)).toBe(false);

    const res = makeRes();
    await handleIntentRoute(makePostReq('/api/v1/intent/init', {}), res, { workspaceDir, subPath: '/init' });
    expect(getStatus(res)).toBe(201);

    // Directory and file should now exist
    expect(fs.existsSync(principlesDir)).toBe(true);
    expect(fs.existsSync(path.join(principlesDir, 'INTENT.zh-CN.md'))).toBe(true);
  });

  it('returns 403 when flag is disabled', async () => {
    writeConfig(false);
    const res = makeRes();
    await handleIntentRoute(makePostReq('/api/v1/intent/init', {}), res, { workspaceDir, subPath: '/init' });
    expect(getStatus(res)).toBe(403);
    const body = parseError(res);
    expect(body.reason).toBe('flag_disabled');
  });

  it('handles empty body gracefully', async () => {
    const res = makeRes();
    await handleIntentRoute(makePostReq('/api/v1/intent/init', ''), res, { workspaceDir, subPath: '/init' });
    expect(getStatus(res)).toBe(201);
  });

  it('returns 400 on invalid JSON body', async () => {
    const res = makeRes();
    await handleIntentRoute(makePostReq('/api/v1/intent/init', '{not valid'), res, { workspaceDir, subPath: '/init' });
    expect(getStatus(res)).toBe(400);
    const body = parseError(res);
    expect(body.reason).toBe('invalid_json');
  });
});

// ── GET /api/v1/intent/content ──────────────────────────────────────────────

describe('Intent route — GET /api/v1/intent/content', () => {
  it('returns raw content when file exists', async () => {
    fs.writeFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), '# My Intent\n\ntest content', 'utf8');

    const res = makeRes();
    await handleIntentRoute(makeGetReq('/api/v1/intent/content'), res, { workspaceDir, subPath: '/content' });
    expect(getStatus(res)).toBe(200);
    const body = parseBody(res);
    expect(body.data.content).toContain('# My Intent');
    expect(body.data.content).toContain('test content');
    expect(body.data.path).toContain('INTENT.zh-CN.md');
  });

  it('returns 404 when file does not exist', async () => {
    const res = makeRes();
    await handleIntentRoute(makeGetReq('/api/v1/intent/content'), res, { workspaceDir, subPath: '/content' });
    expect(getStatus(res)).toBe(404);
    const body = parseError(res);
    expect(body.reason).toBe('not_found');
  });

  it('returns 403 when flag is disabled', async () => {
    writeConfig(false);
    const res = makeRes();
    await handleIntentRoute(makeGetReq('/api/v1/intent/content'), res, { workspaceDir, subPath: '/content' });
    expect(getStatus(res)).toBe(403);
    expect(parseError(res).reason).toBe('flag_disabled');
  });

  it('returns 413 oversized when INTENT.md exceeds 32KB (rc-9-no-silent-fallback)', async () => {
    // PR-1083 review (CodeRabbit comment ~133-145):
    // getRawContent no longer collapses missing / oversized / read-error into a
    // bare null. An oversized file now yields a structured `oversized` reason
    // and is rejected at stat-time BEFORE readFileSync — keeping this path
    // consistent with getSummary() which also returns reason='oversized' when
    // the file > INTENT_MAX_BYTES. Without this guard the editor would silently
    // load a > 32 KiB document while the read-only summary page rejects it.
    fs.writeFileSync(
      path.join(principlesDir, 'INTENT.zh-CN.md'),
      '# INTENT.md\n\n## 1. Why\n\n' + 'x'.repeat(33 * 1024) + '\n',
      'utf8',
    );

    const res = makeRes();
    await handleIntentRoute(makeGetReq('/api/v1/intent/content'), res, { workspaceDir, subPath: '/content' });
    expect(getStatus(res)).toBe(413);
    const body = parseError(res);
    expect(body.reason).toBe('oversized');
  });
});

// ── PUT /api/v1/intent/content ──────────────────────────────────────────────

describe('Intent route — PUT /api/v1/intent/content', () => {
  it('saves content and returns updated metadata', async () => {
    const res = makeRes();
    await handleIntentRoute(
      makePutReq('/api/v1/intent/content', { content: '# My Intent\n\nnew content' }),
      res,
      { workspaceDir, subPath: '/content' },
    );
    expect(getStatus(res)).toBe(200);
    const body = parseBody(res);
    expect(body.data.saved).toBe(true);
    expect(body.data.contentHash).toBeTruthy();
    expect(body.data.lastEditedAt).toBeTruthy();

    // Verify file was written
    const content = fs.readFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'utf8');
    expect(content).toBe('# My Intent\n\nnew content');
  });

  it('overwrites existing file', async () => {
    fs.writeFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'old content', 'utf8');

    const res = makeRes();
    await handleIntentRoute(
      makePutReq('/api/v1/intent/content', { content: 'new content' }),
      res,
      { workspaceDir, subPath: '/content' },
    );
    expect(getStatus(res)).toBe(200);

    const content = fs.readFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'utf8');
    expect(content).toBe('new content');
  });

  it('returns 400 when content is missing', async () => {
    const res = makeRes();
    await handleIntentRoute(
      makePutReq('/api/v1/intent/content', { other: 'field' }),
      res,
      { workspaceDir, subPath: '/content' },
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).reason).toBe('missing_content');
  });

  it('returns 400 when content is empty string', async () => {
    const res = makeRes();
    await handleIntentRoute(
      makePutReq('/api/v1/intent/content', { content: '' }),
      res,
      { workspaceDir, subPath: '/content' },
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).reason).toBe('empty_content');
  });

  it('returns 400 when content is not a string', async () => {
    const res = makeRes();
    await handleIntentRoute(
      makePutReq('/api/v1/intent/content', { content: 123 }),
      res,
      { workspaceDir, subPath: '/content' },
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).reason).toBe('invalid_content');
  });

  it('returns 400 when content exceeds 32KB', async () => {
    const hugeContent = 'x'.repeat(33 * 1024);
    const res = makeRes();
    await handleIntentRoute(
      makePutReq('/api/v1/intent/content', { content: hugeContent }),
      res,
      { workspaceDir, subPath: '/content' },
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).reason).toBe('oversized');
  });

  it('returns 403 when flag is disabled', async () => {
    writeConfig(false);
    const res = makeRes();
    await handleIntentRoute(
      makePutReq('/api/v1/intent/content', { content: 'test' }),
      res,
      { workspaceDir, subPath: '/content' },
    );
    expect(getStatus(res)).toBe(403);
    expect(parseError(res).reason).toBe('flag_disabled');
  });

  it('returns 400 on invalid JSON body', async () => {
    const res = makeRes();
    await handleIntentRoute(
      makePutReq('/api/v1/intent/content', '{not valid'),
      res,
      { workspaceDir, subPath: '/content' },
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).reason).toBe('invalid_json');
  });
});

// ── Unknown sub-paths ────────────────────────────────────────────────────────

describe('Intent route — unknown sub-paths', () => {
  it('returns 404 for unknown GET sub-path', async () => {
    const res = makeRes();
    await handleIntentRoute(makeGetReq('/api/v1/intent/unknown'), res, { workspaceDir, subPath: '/unknown' });
    expect(getStatus(res)).toBe(404);
  });

  it('returns 404 for unknown POST sub-path', async () => {
    const res = makeRes();
    await handleIntentRoute(makePostReq('/api/v1/intent/unknown', {}), res, { workspaceDir, subPath: '/unknown' });
    expect(getStatus(res)).toBe(404);
  });
});
