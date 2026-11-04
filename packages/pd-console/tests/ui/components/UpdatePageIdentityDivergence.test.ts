/**
 * Source-contract: the Update page must not present a "version divergence"
 * between the active release product version and the plugin package version.
 * They are independent version planes (RELEASE_PROCESS.md, "The three version
 * planes"); PRI-833's note fired on every healthy installation and is retired.
 *
 * The vitest config uses the 'node' environment (no jsdom), so React
 * components cannot be mounted here. Following the established
 * source-contract pattern (see SlashCommandsCard.test.ts), this pins the
 * surface's absence in the page, the validator, and BOTH locales (ERR-106
 * family: no half-removed Owner-facing copy).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNestedRecord, parseJsonRecord } from '../i18n-test-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..', '..', 'src', 'ui');

const PAGE_SOURCE = readFileSync(join(SRC_ROOT, 'pages', 'settings', 'UpdatePage.tsx'), 'utf-8');
const VALIDATOR_SOURCE = readFileSync(join(SRC_ROOT, 'utils', 'validators.ts'), 'utf-8');

const EN = parseJsonRecord(readFileSync(join(SRC_ROOT, 'i18n', 'en.json'), 'utf-8'));
const ZH = parseJsonRecord(readFileSync(join(SRC_ROOT, 'i18n', 'zh-CN.json'), 'utf-8'));

describe('UpdatePage version-divergence note (retired)', () => {
  it('renders no cross-plane divergence note', () => {
    expect(PAGE_SOURCE).not.toContain('identityDivergence');
  });

  it('the validator declares only the active-release version source', () => {
    expect(VALIDATOR_SOURCE).not.toContain('identityDivergence');
    expect(VALIDATOR_SOURCE).toContain("versionSource?: 'active-release'");
  });

  it('the copy is gone from both locales', () => {
    const enUpdate = getNestedRecord(EN, ['pages', 'update']);
    const zhUpdate = getNestedRecord(ZH, ['pages', 'update']);
    expect(Object.hasOwn(enUpdate, 'identityDivergence')).toBe(false);
    expect(Object.hasOwn(zhUpdate, 'identityDivergence')).toBe(false);
  });
});
