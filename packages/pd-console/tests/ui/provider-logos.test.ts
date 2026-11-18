import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  providerLogoFile,
  providersWithLogo,
} from '../../src/ui/pages/control-center/provider-logos.js';
import {
  providerCapabilities,
  providerMonogram,
} from '../../src/ui/pages/control-center/provider-presets.js';

const assetsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/ui/assets/providers',
);

describe('provider logo assets', () => {
  it('maps every logo to a bundled same-origin file that exists', () => {
    const ids = providersWithLogo();
    expect(ids.length).toBeGreaterThan(0);
    for (const providerId of ids) {
      const file = providerLogoFile(providerId);
      if (file === undefined) {
        expect.fail(`${providerId} is listed as having a logo but has no file`);
      }
      // Never an external URL: the console must render logos offline.
      expect(file).not.toMatch(/^https?:/);
      expect(existsSync(join(assetsDir, file)), `${providerId} -> ${file}`).toBe(true);
    }
  });

  it('leaves providers without an official asset unmapped (monogram fallback)', () => {
    for (const providerId of ['zai', 'xai', 'groq', 'together', '__custom__', '']) {
      expect(providerLogoFile(providerId), providerId).toBeUndefined();
    }
  });
});

describe('providerCapabilities', () => {
  it('advertises reasoning when any catalog model supports it', () => {
    expect(
      providerCapabilities({
        models: [
          { reasoning: false, contextWindow: 32_000 },
          { reasoning: true, contextWindow: 32_000 },
        ],
      }),
    ).toEqual(['reasoning']);
  });

  it('advertises long context at 128k tokens and above', () => {
    expect(providerCapabilities({ models: [{ reasoning: false, contextWindow: 128_000 }] })).toEqual(
      ['longContext'],
    );
    expect(providerCapabilities({ models: [{ reasoning: false, contextWindow: 127_999 }] })).toEqual(
      [],
    );
  });

  it('returns both chips for a model that qualifies for both', () => {
    expect(providerCapabilities({ models: [{ reasoning: true, contextWindow: 200_000 }] })).toEqual([
      'reasoning',
      'longContext',
    ]);
  });
});

describe('providerMonogram', () => {
  it('uses the first two alphanumeric characters of the display name', () => {
    expect(providerMonogram('deepseek')).toBe('DE');
    expect(providerMonogram('moonshotai-cn')).toBe('KI');
    expect(providerMonogram('zai')).toBe('GL');
  });

  it('never returns punctuation for an id without an ASCII brand name', () => {
    expect(providerMonogram('__custom__')).toBe('CU');
    expect(providerMonogram('')).toBe('');
  });
});
