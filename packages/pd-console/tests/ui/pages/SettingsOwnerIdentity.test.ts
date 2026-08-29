/**
 * ADR-0022 (PRI-578 PR-3-A review): SettingsPage Owner identity section —
 * registration vs governance readiness separation.
 *
 * Source-contract test (same pattern as SettingsOnboardingFlag.test.ts):
 * verifies the page renders REGISTRATION (where the identity comes from) and
 * GOVERNANCE READINESS (whether Owner actions can execute) as two separate,
 * independently-colored states, and that readiness is derived ONLY from the
 * canonical governance snapshot delivered by /api/v1/owner-identity — never
 * re-derived from the registration source in the UI.
 *
 * EP-09 (Test Reality): contract assertions reflect the real implementation.
 * EP-11 (i18n): all user-visible strings come from i18n keys with en/zh parity.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNestedRecord, parseJsonRecord } from '../i18n-test-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui/pages
// SRC_ROOT  = packages/pd-console/src
const SRC_ROOT = join(__dirname, '..', '..', '..', 'src');

const settingsSource = readFileSync(
  join(SRC_ROOT, 'ui', 'pages', 'settings', 'SettingsPage.tsx'),
  'utf8',
);
const apiSource = readFileSync(join(SRC_ROOT, 'ui', 'api.ts'), 'utf8');
const enJson = parseJsonRecord(
  readFileSync(join(SRC_ROOT, 'ui', 'i18n', 'en.json'), 'utf8'),
);
const zhJson = parseJsonRecord(
  readFileSync(join(SRC_ROOT, 'ui', 'i18n', 'zh-CN.json'), 'utf8'),
);

const OWNER_I18N_KEYS = [
  'statusConfigured',
  'statusMissing',
  'statusInvalid',
  'sourceEnv',
  'sourceFile',
  'sourceInvalid',
  'sourceNone',
  'governanceReady',
  'governanceNotReady',
  'governanceReasonTokenAuth',
  'governanceReasonIdentity',
  'governanceNextActionTokenAuth',
  'invalidEnvHint',
] as const;

describe('SettingsPage owner identity: registration vs governance readiness', () => {
  it('renders a dedicated governance readiness indicator from the canonical snapshot', () => {
    expect(settingsSource).toContain('data-testid="owner-governance-readiness"');
    // Readiness keys off the canonical snapshot fields, not the source.
    expect(settingsSource).toContain('ownerIdentity.governance.ownerIdentityConfiguration');
    expect(settingsSource).toContain('ownerIdentity.governance.authenticationMode');
  });

  it('state 1+3 (file/env registration + token auth on): readiness maps configured → Governance: Ready', () => {
    expect(settingsSource).toContain('pages.settings.ownerIdentity.governanceReady');
  });

  it('state 2 (file registration + token auth off): not-ready reason names Console token authentication', () => {
    expect(settingsSource).toContain('pages.settings.ownerIdentity.governanceNotReady');
    expect(settingsSource).toContain('pages.settings.ownerIdentity.governanceReasonTokenAuth');
    expect(settingsSource).toContain('pages.settings.ownerIdentity.governanceNextActionTokenAuth');
  });

  it('state 4 (partial env): invalid registration badge + fail-closed hint, file owner never shown as active', () => {
    expect(settingsSource).toContain('pages.settings.ownerIdentity.statusInvalid');
    expect(settingsSource).toContain('pages.settings.ownerIdentity.sourceInvalid');
    expect(settingsSource).toContain('pages.settings.ownerIdentity.invalidEnvHint');
    // The file record is displayed only when resolution actually came from
    // the file — never under an invalid env override.
    expect(settingsSource).toContain('resolved.source === "file" && ownerIdentity.fileRecord !== null');
  });

  it('state 5 (none): not registered and governance not ready are separate states', () => {
    expect(settingsSource).toContain('pages.settings.ownerIdentity.statusMissing');
    expect(settingsSource).toContain('pages.settings.ownerIdentity.governanceNotReady');
  });

  it('state 6 (file read error): resolved error is surfaced visibly, not rendered as not registered', () => {
    expect(settingsSource).toContain('data-testid="owner-identity-error"');
    expect(settingsSource).toContain('ownerIdentity.resolved.error !== undefined');
  });

  it('registration badge itself never claims governance readiness', () => {
    // The registration badge block maps source → status keys only; the words
    // governance appear only in the readiness block below it.
    const badgeBlock = settingsSource.split('data-testid="owner-identity-status"')[1]?.split('</div>')[0] ?? '';
    expect(badgeBlock).not.toContain('governance');
  });

  it('POST success toast reports registration, not governance readiness', () => {
    expect(settingsSource).toContain('pages.settings.ownerIdentity.registered');
  });

  it('consumes the API through the validated fetchOwnerIdentity wrapper', () => {
    expect(apiSource).toContain('fetchOwnerIdentity');
    expect(apiSource).toContain('validateOwnerIdentityView');
  });
});

describe('owner identity i18n: en/zh-CN parity', () => {
  it('ownerIdentity block has identical key sets in both locales (EP-11)', () => {
    const enBlock = getNestedRecord(enJson, ['pages', 'settings', 'ownerIdentity']);
    const zhBlock = getNestedRecord(zhJson, ['pages', 'settings', 'ownerIdentity']);
    expect(Object.keys(enBlock).sort()).toEqual(Object.keys(zhBlock).sort());
  });

  it.each(OWNER_I18N_KEYS)('key pages.settings.ownerIdentity.%s exists and is non-empty in both locales', (key) => {
    const enBlock = getNestedRecord(enJson, ['pages', 'settings', 'ownerIdentity']);
    const zhBlock = getNestedRecord(zhJson, ['pages', 'settings', 'ownerIdentity']);
    for (const block of [enBlock, zhBlock]) {
      expect(Object.hasOwn(block, key), `missing key: ${key}`).toBe(true);
      expect(typeof Reflect.get(block, key)).toBe('string');
      expect((Reflect.get(block, key) as string).length).toBeGreaterThan(0);
    }
  });
});
