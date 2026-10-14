/**
 * Round-5 S3: the interactive runtime-profile collection must express the
 * custom-endpoint input in BOTH install modes (the non-interactive --base-url
 * flag and this interactive prompt). The @inquirer layer is scripted; the
 * validation logic itself is the ONE shared isValidHttpBaseUrl (unit-covered
 * in mvp-config.test.ts) — here we pin what the prompt COLLECTS into the
 * profile that the governance write boundary consumes.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const inputMock = vi.fn();
const selectMock = vi.fn();
const confirmMock = vi.fn();

vi.mock('@inquirer/prompts', () => ({
  input: (...args: unknown[]) => inputMock(...args),
  select: (...args: unknown[]) => selectMock(...args),
  confirm: (...args: unknown[]) => confirmMock(...args),
}));

const { promptRuntimeProfile } = await import('../src/prompts.js');

describe('round-5 S3: interactive runtime profile collects the custom endpoint', () => {
  beforeEach(() => {
    inputMock.mockReset();
    selectMock.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    selectMock.mockResolvedValue('openai');
  });

  it('a valid custom endpoint lands in the returned profile', async () => {
    inputMock.mockResolvedValueOnce('OPENAI_API_KEY'); // api key env
    inputMock.mockResolvedValueOnce('https://llm.example.com/v1'); // base url
    const profile = await promptRuntimeProfile();
    expect(profile).toBeDefined();
    expect(profile?.baseUrl).toBe('https://llm.example.com/v1');
    expect(profile?.provider).toBe('openai');
    expect(profile?.apiKeyEnv).toBe('OPENAI_API_KEY');
  });

  it('a blank endpoint is omitted (provider default — no empty baseUrl in the profile)', async () => {
    inputMock.mockResolvedValueOnce('OPENAI_API_KEY');
    inputMock.mockResolvedValueOnce('   ');
    const profile = await promptRuntimeProfile();
    expect(profile).toBeDefined();
    expect(profile?.baseUrl).toBeUndefined();
    expect(Object.keys(profile ?? {})).not.toContain('baseUrl');
  });

  it('the endpoint validator rejects a hostname-less URL and accepts a real endpoint (the shared validation)', async () => {
    inputMock.mockResolvedValueOnce('OPENAI_API_KEY');
    inputMock.mockResolvedValueOnce('https://llm.example.com/v1');
    await promptRuntimeProfile();
    const options = inputMock.mock.calls[1]?.[0] as { message: string; validate: (v: string) => string | boolean };
    expect(typeof options?.validate).toBe('function');
    expect(options.validate('https://')).toMatch(/valid http\(s\) URL/);
    expect(options.validate('not-a-url')).toMatch(/valid http\(s\) URL/);
    expect(options.validate('  ')).toBe(true);
    expect(options.validate('https://llm.example.com/v1')).toBe(true);
  });

  it('declining profile configuration still returns undefined (no baseUrl regression)', async () => {
    confirmMock.mockResolvedValue(false);
    const profile = await promptRuntimeProfile();
    expect(profile).toBeUndefined();
  });
});
