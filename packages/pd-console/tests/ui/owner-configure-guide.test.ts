import { describe, expect, it } from 'vitest';
import {
  deriveOwnerConfigureGuide,
  OWNER_CONFIGURE_COMMANDS,
  OWNER_CONFIGURE_DOC_URL,
} from '../../src/ui/pages/focus/FocusPage.js';
import en from '../../src/ui/i18n/en.json' with { type: 'json' };
import zhCN from '../../src/ui/i18n/zh-CN.json' with { type: 'json' };

const resolveKey = (locale: unknown, keyPath: string): unknown =>
  keyPath.split('.').reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === 'object' && Object.hasOwn(node as Record<string, unknown>, segment)) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, locale);

describe('PRI-578 PR-3-B: Owner identity configure guide (guidance only, no persistence)', () => {
  it('shows the guide when the snapshot reports the owner identity as missing', () => {
    const guide = deriveOwnerConfigureGuide('missing');
    expect(guide).not.toBeNull();
    expect(guide!.commands.length).toBeGreaterThanOrEqual(1);
    expect(guide!.docUrl).toContain('owner-identity-configuration.md');
  });

  it('hides the guide when the owner identity is configured or unknown', () => {
    expect(deriveOwnerConfigureGuide('configured')).toBeNull();
    expect(deriveOwnerConfigureGuide(undefined)).toBeNull();
  });

  it('every command variant sets both PD_OWNER_ID and PD_OWNER_CREDENTIAL_ID', () => {
    expect(OWNER_CONFIGURE_COMMANDS.length).toBeGreaterThanOrEqual(1);
    for (const cmd of OWNER_CONFIGURE_COMMANDS) {
      expect(cmd.command).toContain('PD_OWNER_ID');
      expect(cmd.command).toContain('PD_OWNER_CREDENTIAL_ID');
    }
    const byLabel = (labelKey: string) => OWNER_CONFIGURE_COMMANDS.find(c => c.labelKey === labelKey);
    expect(byLabel('pages.focus.experience.ownerGuide.cmdPowerShell')?.command).toContain(
      '[Environment]::SetEnvironmentVariable',
    );
    expect(byLabel('pages.focus.experience.ownerGuide.cmdBash')?.command).toContain('~/.bashrc');
  });

  it('docUrl points at the documented target file', () => {
    expect(OWNER_CONFIGURE_DOC_URL).toBe(
      'https://github.com/csuzngjh/principles/blob/main/docs/runbooks/ops/owner-identity-configuration.md',
    );
  });

  it('every ownerGuide i18n key resolves in BOTH locales', () => {
    const keys = [
      'pages.focus.experience.ownerGuide.title',
      'pages.focus.experience.ownerGuide.intro',
      'pages.focus.experience.ownerGuide.cmdPowerShell',
      'pages.focus.experience.ownerGuide.cmdBash',
      'pages.focus.experience.ownerGuide.copy',
      'pages.focus.experience.ownerGuide.copied',
      'pages.focus.experience.ownerGuide.docLink',
    ];
    for (const key of keys) {
      expect(resolveKey(en, key), `en.json missing ${key}`).toEqual(expect.any(String));
      expect(resolveKey(zhCN, key), `zh-CN.json missing ${key}`).toEqual(expect.any(String));
    }
    for (const cmd of OWNER_CONFIGURE_COMMANDS) {
      expect(resolveKey(en, cmd.labelKey), `en.json missing ${cmd.labelKey}`).toEqual(expect.any(String));
      expect(resolveKey(zhCN, cmd.labelKey), `zh-CN.json missing ${cmd.labelKey}`).toEqual(expect.any(String));
    }
  });
});
