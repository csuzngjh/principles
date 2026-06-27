/**
 * PRI-466 + PRI-477: Intent API client tests.
 *
 * Covers fetchIntentSummary, fetchIntentContent, createIntentTemplate,
 * saveIntentContent in ui/api.ts.
 * Mocks fetch + sessionStorage since the vitest environment is 'node'.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  fetchIntentSummary,
  fetchIntentContent,
  createIntentTemplate,
  saveIntentContent,
} from '../../src/ui/api.js';

// Mock sessionStorage (browser API not available in Node env)
const sessionStore: Record<string, string> = {};
vi.stubGlobal('sessionStorage', {
  getItem: vi.fn((key: string) => sessionStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { sessionStore[key] = value; }),
  removeItem: vi.fn((key: string) => { delete sessionStore[key]; }),
  clear: vi.fn(() => { for (const k of Object.keys(sessionStore)) delete sessionStore[k]; }),
  key: vi.fn((index: number) => Object.keys(sessionStore)[index] ?? null),
  get length() { return Object.keys(sessionStore).length; },
});

// Mock fetch
vi.stubGlobal('fetch', vi.fn());

describe('fetchIntentSummary', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
    for (const k of Object.keys(sessionStore)) delete sessionStore[k];
  });

  it('returns validated summary on successful response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          ok: true,
          found: true,
          flagEnabled: true,
          warnings: [],
        },
      }),
    } as Response);

    const result = await fetchIntentSummary();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.found).toBe(true);
      expect(result.data.flagEnabled).toBe(true);
      expect(result.data.warnings).toEqual([]);
    }
  });

  it('returns validation failure for malformed response data', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { unexpected: 'shape' },
      }),
    } as Response);

    const result = await fetchIntentSummary();
    expect(result.success).toBe(false);
  });
});

// ── fetchIntentContent (PRI-477) ─────────────────────────────────────────────

describe('fetchIntentContent', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it('returns validated raw content on successful response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          content: '# INTENT.md\n\ntest content',
          path: '/workspace/.principles/INTENT.md',
        },
      }),
    } as Response);

    const result = await fetchIntentContent();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toBe('# INTENT.md\n\ntest content');
      expect(result.data.path).toBe('/workspace/.principles/INTENT.md');
    }
  });

  it('returns validation failure for malformed response data', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { unexpected: 'shape' },
      }),
    } as Response);

    const result = await fetchIntentContent();
    expect(result.success).toBe(false);
  });

  it('returns error on 404 (file not found)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        success: false,
        error: 'not_found',
        reason: 'not_found',
        nextAction: 'Create it first.',
      }),
    } as Response);

    const result = await fetchIntentContent();
    expect(result.success).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('returns error on 403 (flag disabled)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        error: 'flag_disabled',
        reason: 'flag_disabled',
        nextAction: 'Enable the flag first.',
      }),
    } as Response);

    const result = await fetchIntentContent();
    expect(result.success).toBe(false);
    expect(result.reason).toBe('flag_disabled');
  });
});

// ── createIntentTemplate (PRI-477) ───────────────────────────────────────────

describe('createIntentTemplate', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it('returns validated init result on successful create (201)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        success: true,
        data: {
          ok: true,
          created: true,
          path: '/workspace/.principles/INTENT.md',
        },
      }),
    } as Response);

    const result = await createIntentTemplate(false);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.created).toBe(true);
      expect(result.data.path).toBe('/workspace/.principles/INTENT.md');
    }
  });

  it('returns validated result when file already exists (200)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          ok: true,
          created: false,
          reason: 'already_exists',
          nextAction: 'Edit instead.',
        },
      }),
    } as Response);

    const result = await createIntentTemplate(false);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.created).toBe(false);
      expect(result.data.reason).toBe('already_exists');
    }
  });

  it('sends force=true when called with force=true', async () => {
    let capturedBody: string | undefined;
    vi.mocked(fetch).mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return {
        ok: true,
        status: 201,
        json: async () => ({
          success: true,
          data: { ok: true, created: true, path: '/foo' },
        }),
      } as Response;
    });

    await createIntentTemplate(true);
    expect(capturedBody).toBeDefined();
    expect(JSON.parse(capturedBody!)).toEqual({ force: true });
  });

  it('returns validation failure for malformed response data', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        success: true,
        data: { unexpected: 'shape' },
      }),
    } as Response);

    const result = await createIntentTemplate(false);
    expect(result.success).toBe(false);
  });

  it('returns error on 403 (flag disabled)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        error: 'flag_disabled',
        reason: 'flag_disabled',
        nextAction: 'Enable the flag first.',
      }),
    } as Response);

    const result = await createIntentTemplate(false);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('flag_disabled');
  });
});

// ── saveIntentContent (PRI-477) ──────────────────────────────────────────────

describe('saveIntentContent', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it('returns validated save result on successful save', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          ok: true,
          saved: true,
          path: '/workspace/.principles/INTENT.md',
          contentHash: 'sha256:abc123',
          lastEditedAt: '2026-06-25T10:00:00Z',
          warnings: [],
        },
      }),
    } as Response);

    const result = await saveIntentContent('# INTENT.md\n\nnew content');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.saved).toBe(true);
      expect(result.data.contentHash).toBe('sha256:abc123');
      expect(result.data.lastEditedAt).toBe('2026-06-25T10:00:00Z');
    }
  });

  it('sends content in request body', async () => {
    let capturedBody: string | undefined;
    vi.mocked(fetch).mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { ok: true, saved: true },
        }),
      } as Response;
    });

    await saveIntentContent('my content');
    expect(capturedBody).toBeDefined();
    expect(JSON.parse(capturedBody!)).toEqual({ content: 'my content' });
  });

  it('returns validation failure for malformed response data', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { unexpected: 'shape' },
      }),
    } as Response);

    const result = await saveIntentContent('content');
    expect(result.success).toBe(false);
  });

  it('returns error on 400 (empty content)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: 'intent_save_error',
        reason: 'empty_content',
        nextAction: 'Content cannot be empty.',
      }),
    } as Response);

    const result = await saveIntentContent('');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('empty_content');
  });

  it('returns error on 400 (oversized)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: 'intent_save_error',
        reason: 'oversized',
        nextAction: 'Reduce content.',
      }),
    } as Response);

    const result = await saveIntentContent('x'.repeat(33000));
    expect(result.success).toBe(false);
    expect(result.reason).toBe('oversized');
  });
});
