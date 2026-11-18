import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
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

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

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
      expect(['.png', '.svg']).toContain(extname(file));
      expect(existsSync(join(assetsDir, file)), `${providerId} -> ${file}`).toBe(true);
    }
  });

  it('keeps every raster logo square, at least 32px, and within the 2x budget', () => {
    for (const providerId of providersWithLogo()) {
      const file = providerLogoFile(providerId);
      if (file === undefined || extname(file) !== '.png') continue;
      const { width, height } = pngSize(readFileSync(join(assetsDir, file)));
      expect(width, providerId).toBe(height);
      expect(width, providerId).toBeGreaterThanOrEqual(32);
      // 128px covers a 44px tile at 2x; larger files only bloat the console.
      expect(width, providerId).toBeLessThanOrEqual(128);
    }
  });

  it('ships only static, script-free SVG marks', () => {
    for (const providerId of providersWithLogo()) {
      const file = providerLogoFile(providerId);
      if (file === undefined || extname(file) !== '.svg') continue;
      const svg = readFileSync(join(assetsDir, file), 'utf8');
      expect(svg, providerId).not.toMatch(/<script/i);
      expect(svg, providerId).not.toMatch(/<image/i);
      expect(svg, providerId).not.toMatch(/href\s*=\s*["']https?:/i);
    }
  });

  it('keeps the whole logo bundle under a 200 KB ceiling', () => {
    const total = providersWithLogo().reduce((sum, providerId) => {
      const file = providerLogoFile(providerId);
      if (file === undefined) return sum;
      return sum + readFileSync(join(assetsDir, file)).byteLength;
    }, 0);
    expect(total).toBeLessThan(200 * 1024);
  });

  it('leaves providers without a usable official asset on the monogram fallback', () => {
    // Licensing or availability decisions documented in assets/providers/NOTICE.md.
    for (const providerId of [
      'openai',
      'xai',
      'groq',
      'nvidia',
      '__custom__',
      '',
    ]) {
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
