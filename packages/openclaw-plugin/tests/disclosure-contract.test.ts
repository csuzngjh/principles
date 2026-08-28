/**
 * Privacy & network disclosure contract (ClawHub security-audit remediation,
 * 2026-08).
 *
 * ClawHub's audit of the published plugin surfaced a disclosure mismatch:
 * the artifact carried an opt-in telemetry exporter while the shipped README
 * still claimed the plugin "does not send product telemetry" / "performs no
 * network I/O except through provider SDKs". This test keeps every
 * user-facing disclosure surface aligned with the shipped code:
 *
 * - the npm-published plugin README (auto-included in every tarball, read by
 *   ClawHub's audit) must carry the full telemetry contract;
 * - the GitHub-facing root READMEs (EN/ZH) must not make absolute
 *   local-only claims without disclosing the optional outbound channel;
 * - the pd-mentor skill's declared trigger scope must cover the options its
 *   own interaction flow offers (SkillSpector "Intent-Code Divergence").
 *
 * The telemetry code itself is default-off + consent-gated; its transport
 * boundaries are proven by packages/host-runtime/tests/product-telemetry-service.test.ts.
 * This file only locks the DISCLOSURE, not the behavior.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');
const repoRoot = resolve(packageRoot, '..', '..');

const pluginReadme = readFileSync(join(packageRoot, 'README.md'), 'utf-8');
const rootReadmeEn = readFileSync(join(repoRoot, 'README.md'), 'utf-8');
const rootReadmeZh = readFileSync(join(repoRoot, 'README_ZH.md'), 'utf-8');

/** Markers the published plugin README must carry (mirrors scripts/verify-build.mjs). */
const REQUIRED_PLUGIN_README_MARKERS = [
  'https://principles-website.pages.dev/api/product-telemetry/snapshot',
  'pd telemetry enable --confirm',
  'pd telemetry disable --confirm',
  'pd telemetry preview',
  'PD_TELEMETRY_DISABLED',
  'Default: **OFF**',
] as const;

/** Absolute claims the shipped opt-in telemetry code contradicts. */
const STALE_ABSOLUTE_CLAIMS = [
  'does not send product telemetry',
  'performs no network I/O except',
  'does not send product-usage telemetry',
] as const;

describe('plugin README — telemetry disclosure contract (ClawHub audit surface)', () => {
  it('discloses the endpoint, default-OFF state, consent gate, and every control command', () => {
    const missing = REQUIRED_PLUGIN_README_MARKERS.filter((marker) => !pluginReadme.includes(marker));
    expect(missing, `plugin README missing disclosure markers: ${missing.join(' | ')}`).toEqual([]);
  });

  it('documents the exact snapshot payload (8 top-level fields, booleans-only milestones)', () => {
    for (const field of ['dailyTelemetryId', 'bucketDate', 'pdVersion', 'hostKind', 'milestones', 'reliability', 'schemaVersion', 'consentVersion']) {
      expect(pluginReadme, `payload table must enumerate '${field}'`).toContain(field);
    }
    expect(pluginReadme).toContain('Never sent');
  });

  it('carries no absolute claim that contradicts the shipped opt-in telemetry code', () => {
    const stale = STALE_ABSOLUTE_CLAIMS.filter((claim) => pluginReadme.includes(claim));
    expect(stale, `plugin README contains stale absolute claims: ${stale.join(' | ')}`).toEqual([]);
  });
});

describe('root READMEs — local-first framing must disclose the optional outbound channel', () => {
  it('README.md mentions the telemetry endpoint, default-off state, and consent command', () => {
    expect(rootReadmeEn).toContain('https://principles-website.pages.dev/api/product-telemetry/snapshot');
    expect(rootReadmeEn).toContain('off by default');
    expect(rootReadmeEn).toContain('pd telemetry enable --confirm');
    expect(rootReadmeEn).toContain('pd telemetry disable --confirm');
  });

  it('README_ZH.md mentions the telemetry endpoint, default-off state, and consent command', () => {
    expect(rootReadmeZh).toContain('https://principles-website.pages.dev/api/product-telemetry/snapshot');
    expect(rootReadmeZh).toContain('默认关闭');
    expect(rootReadmeZh).toContain('pd telemetry enable --confirm');
    expect(rootReadmeZh).toContain('pd telemetry disable --confirm');
  });

  it('neither root README claims unconditional local-only storage', () => {
    // The absolute sentence previously read "State is stored locally." with no
    // qualifier — it must now be paired with the privacy pointer.
    expect(rootReadmeEn).not.toMatch(/^State is stored locally\.$/m);
    expect(rootReadmeZh).not.toMatch(/^状态数据保存在本地。$/m);
  });
});

describe('pd-mentor skill — declared scope covers the options its flow offers', () => {
  const cases = [
    { lang: 'zh', scopeMarker: '工作区清理' },
    { lang: 'en', scopeMarker: 'workspace cleaning' },
  ] as const;

  for (const { lang, scopeMarker } of cases) {
    it(`${lang} frontmatter declares the workspace-cleaning scenario the menu offers`, () => {
      const skill = readFileSync(join(packageRoot, 'templates', 'langs', lang, 'skills', 'pd-mentor', 'SKILL.md'), 'utf-8');
      const frontmatter = skill.split('---')[1] ?? '';
      expect(frontmatter, `${lang} description must cover the workspace-cleaning flow option`).toContain(scopeMarker);
    });
  }
});
