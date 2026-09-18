/**
 * Source-contract test for the PR-C identity-divergence note on UpdatePage.
 *
 * The vitest config uses the 'node' environment (no jsdom), so React
 * components cannot be mounted here. Following the established
 * source-contract pattern (see SlashCommandsCard.test.ts), this pins:
 *  - UpdatePage renders the divergence note from the validated
 *    identityDivergence field (never from raw response data);
 *  - the note routes through i18n (`pages.update.identityDivergence`) with
 *    the active/plugin interpolations — no hardcoded Owner-facing strings;
 *  - the key exists in BOTH locales (zh-CN and en) with the same
 *    interpolation slots (ERR-106 family: no silently untranslated surface).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNestedString, parseJsonRecord } from '../i18n-test-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..', '..', 'src', 'ui');

const PAGE_SOURCE = readFileSync(join(SRC_ROOT, 'pages', 'settings', 'UpdatePage.tsx'), 'utf-8');
const VALIDATOR_SOURCE = readFileSync(join(SRC_ROOT, 'utils', 'validators.ts'), 'utf-8');

const EN = parseJsonRecord(readFileSync(join(SRC_ROOT, 'i18n', 'en.json'), 'utf-8'));
const ZH = parseJsonRecord(readFileSync(join(SRC_ROOT, 'i18n', 'zh-CN.json'), 'utf-8'));

const DIVERGENCE_PATH = ['pages', 'update', 'identityDivergence'] as const;

describe('UpdatePage identity divergence note (PR-C)', () => {
  it('renders the note from the validated identityDivergence field only', () => {
    expect(PAGE_SOURCE).toContain('statusData?.identityDivergence');
    expect(PAGE_SOURCE).toContain('identityDivergence.activeVersion');
    expect(PAGE_SOURCE).toContain('identityDivergence.pluginVersion');
  });

  it('routes the copy through i18n with active/plugin interpolations', () => {
    expect(PAGE_SOURCE).toContain('pages.update.identityDivergence');
    expect(PAGE_SOURCE).toContain('active: statusData.identityDivergence.activeVersion,');
    expect(PAGE_SOURCE).toContain('plugin: statusData.identityDivergence.pluginVersion,');
  });

  it('the validator exposes the additive fields the note consumes', () => {
    expect(VALIDATOR_SOURCE).toContain("versionSource?: 'active-release' | 'plugin-package'");
    expect(VALIDATOR_SOURCE).toContain('identityDivergence?:');
  });

  it('the divergence copy exists in both locales with matching interpolation slots', () => {
    const en = getNestedString(EN, [...DIVERGENCE_PATH]);
    const zh = getNestedString(ZH, [...DIVERGENCE_PATH]);
    expect(en).toContain('{{active}}');
    expect(en).toContain('{{plugin}}');
    expect(zh).toContain('{{active}}');
    expect(zh).toContain('{{plugin}}');
  });
});
