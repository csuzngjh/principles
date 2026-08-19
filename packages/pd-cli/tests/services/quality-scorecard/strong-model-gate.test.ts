/**
 * Tests for strong-model-gate URL validation (PRI-361 / PRI-547).
 *
 * Threat model: OPENAI_BASE_URL is operator configuration (trusted), so
 * local/private OpenAI-compatible endpoints must work. What stays blocked:
 * non-http(s) schemes, malformed URLs, embedded credentials.
 *
 * Covers:
 * - Public HTTPS endpoint allowed
 * - Explicit local HTTP endpoint allowed (localhost / 127.0.0.1 / private LAN)
 * - Non-http(s) schemes rejected (file:, javascript:, data:)
 * - Malformed URL rejected
 * - Embedded credentials rejected
 * - Endpoint derivation appends /chat/completions correctly
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertSafeLlmBaseUrl } from '../../../src/services/quality-scorecard/strong-model-gate.js';

// ── assertSafeLlmBaseUrl ────────────────────────────────────────────────────

describe('assertSafeLlmBaseUrl — operator-configured provider URLs', () => {
  it('allows public HTTPS endpoint', () => {
    const url = assertSafeLlmBaseUrl('https://api.openai.com/v1');
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('api.openai.com');
  });

  it('allows public HTTP endpoint (operator choice)', () => {
    const url = assertSafeLlmBaseUrl('http://model.example.com/v1');
    expect(url.protocol).toBe('http:');
  });

  it('allows localhost local LLM endpoint (llama.cpp / LM Studio)', () => {
    const url = assertSafeLlmBaseUrl('http://localhost:1234/v1');
    expect(url.hostname).toBe('localhost');
    expect(url.port).toBe('1234');
  });

  it('allows 127.0.0.1 loopback local LLM endpoint', () => {
    const url = assertSafeLlmBaseUrl('http://127.0.0.1:8080/v1');
    expect(url.hostname).toBe('127.0.0.1');
  });

  it('allows private LAN OpenAI-compatible endpoint', () => {
    const url = assertSafeLlmBaseUrl('http://192.168.1.50:8000/v1');
    expect(url.hostname).toBe('192.168.1.50');
  });

  it('allows 10.x private endpoint', () => {
    const url = assertSafeLlmBaseUrl('http://10.0.0.5:9000/v1');
    expect(url.hostname).toBe('10.0.0.5');
  });

  it('rejects file: scheme', () => {
    expect(() => assertSafeLlmBaseUrl('file:///tmp/foo')).toThrow(/protocol must be http or https/);
  });

  it('rejects javascript: scheme', () => {
    expect(() => assertSafeLlmBaseUrl('javascript:alert(1)')).toThrow(/protocol must be http or https/);
  });

  it('rejects data: scheme', () => {
    expect(() => assertSafeLlmBaseUrl('data:text/plain,hello')).toThrow(/protocol must be http or https/);
  });

  it('rejects malformed URL', () => {
    expect(() => assertSafeLlmBaseUrl('not a url at all')).toThrow(/not a valid URL/);
    expect(() => assertSafeLlmBaseUrl('http://')).toThrow(/not a valid URL/);
  });

  it('rejects embedded credentials in URL', () => {
    expect(() => assertSafeLlmBaseUrl('https://user:pass@api.openai.com/v1')).toThrow(
      /credentials must not be embedded/,
    );
  });

  it('rejects empty string', () => {
    expect(() => assertSafeLlmBaseUrl('')).toThrow(/not a valid URL/);
  });
});

// ── Endpoint derivation (integration via adjudicate) ────────────────────────

describe('strong-model-gate adjudicate endpoint derivation', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.unstubAllGlobals();
  });

  it('derives /chat/completions from a local base URL with trailing slash', async () => {
    process.env.OPENAI_BASE_URL = 'http://localhost:1234/v1/';
    process.env.OPENAI_API_KEY = 'test-key';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"scores":{"G1":2,"G2":2,"G3":2,"G4":2,"G5":2,"G6":2,"G7":2},"rationale":"ok","verdict":"pass"}' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { adjudicate } = await import('../../../src/services/quality-scorecard/strong-model-gate.js');
    const result = await adjudicate(
      {
        episodeId: 'ep-1',
        source: 'tool_failure',
        score: 80,
        severity: 'high',
        summary: 'test episode',
        evolutionTaskResolution: null,
        linkedPrinciples: [],
      } as any,
      {
        model: 'local',
        dimensionScores: { G1: 2, G2: 2, G3: 2, G4: 2, G5: 2, G6: 2, G7: 2 },
        dimensionRationales: {},
        flags: [],
      } as any,
      { modelId: 'gpt-test', log: () => {} },
    );

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://localhost:1234/v1/chat/completions');
    expect(result.adjudicationStatus).toBe('pass');
  });
});