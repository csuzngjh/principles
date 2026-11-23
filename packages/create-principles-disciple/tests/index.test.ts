import { describe, it, expect } from 'vitest';
import { isLanguage } from '../src/i18n.js';
import { program, resolvePrePromptInstallMode } from '../src/index.js';
import { shouldProvisionOnInstall } from '../src/installer.js';

describe('isLanguage type guard', () => {
  it('returns true for valid languages', () => {
    expect(isLanguage('zh')).toBe(true);
    expect(isLanguage('en')).toBe(true);
  });

  it('returns false for invalid languages', () => {
    expect(isLanguage('zh-CN')).toBe(false);
    expect(isLanguage('english')).toBe(false);
    expect(isLanguage('chinese')).toBe(false);
    expect(isLanguage('ja')).toBe(false);
    expect(isLanguage('ko')).toBe(false);
    expect(isLanguage('fr')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isLanguage(null)).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
    expect(isLanguage(42)).toBe(false);
    expect(isLanguage({})).toBe(false);
    expect(isLanguage([])).toBe(false);
    expect(isLanguage(true)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isLanguage('')).toBe(false);
  });
});

describe('Language validation edge cases', () => {
  it('rejects case variations', () => {
    expect(isLanguage('ZH')).toBe(false);
    expect(isLanguage('EN')).toBe(false);
    expect(isLanguage('Zh')).toBe(false);
    expect(isLanguage('En')).toBe(false);
  });

  it('rejects whitespace-padded values', () => {
    expect(isLanguage(' zh')).toBe(false);
    expect(isLanguage('zh ')).toBe(false);
    expect(isLanguage(' zh ')).toBe(false);
  });
});

// cli-7: inspect the REAL option registration on the production program so the
// test fails if --stop-gateway is removed, renamed, or its default changes in
// src/index.ts. We inspect .options rather than calling .parse() because parse
// would fire the install command's action (runInstall) and run the installer.
describe('--stop-gateway flag registration (cli-7, real program)', () => {
  const installCmd = program.commands.find((c) => c.name() === 'install');

  it('is registered on the install command', () => {
    expect(installCmd).toBeDefined();
    const opt = installCmd!.options.find((o) => o.long === '--stop-gateway');
    expect(opt).toBeDefined();
  });

  it('defaults to false', () => {
    const opt = installCmd!.options.find((o) => o.long === '--stop-gateway');
    expect(opt?.defaultValue).toBe(false);
  });

  it('is a boolean toggle (no value placeholder) so presence parses to true', () => {
    const opt = installCmd!.options.find((o) => o.long === '--stop-gateway');
    // flags has no <value>/[value] suffix => Commander sets opts.stopGateway
    // (camelCase) to true when present, defaultValue when absent.
    expect(opt?.flags).toBe('--stop-gateway');
  });
});

describe('resolvePrePromptInstallMode — interactive mode is resolved AFTER host/workspace', () => {
  it('interactive without flags never pre-fills force (a chosen workspace with files must stay smart)', () => {
    expect(resolvePrePromptInstallMode({
      force: false, smart: false, nonInteractive: false, workspaceInfo: { isFirstInstall: true },
    })).toBeUndefined();
    expect(resolvePrePromptInstallMode({
      force: false, smart: false, nonInteractive: false, workspaceInfo: { isFirstInstall: false },
    })).toBeUndefined();
  });

  it('explicit flags win in every mode', () => {
    expect(resolvePrePromptInstallMode({
      force: true, smart: false, nonInteractive: false, workspaceInfo: { isFirstInstall: false },
    })).toBe('force');
    expect(resolvePrePromptInstallMode({
      force: false, smart: true, nonInteractive: true, workspaceInfo: { isFirstInstall: true },
    })).toBe('smart');
  });

  it('non-interactive still resolves a default', () => {
    expect(resolvePrePromptInstallMode({
      force: false, smart: false, nonInteractive: true, workspaceInfo: { isFirstInstall: true },
    })).toBe('force');
    expect(resolvePrePromptInstallMode({
      force: false, smart: false, nonInteractive: true, workspaceInfo: { isFirstInstall: false },
    })).toBe('smart');
  });
});

describe('shouldProvisionOnInstall — deferred provisioning never weakens upgrades', () => {
  const base = {
    freshInstall: false,
    consentIntent: 'enable',
    consentSource: 'explicit_flag',
    schedulerState: 'enabled',
    hasPendingMarker: true,
  };

  it('a fresh install always records the attempt', () => {
    expect(shouldProvisionOnInstall({ ...base, freshInstall: true, hasPendingMarker: false })).toBe(true);
  });

  it('an existing install resumes ONLY with explicit enable + a matching pending marker', () => {
    expect(shouldProvisionOnInstall(base)).toBe(true);
    expect(shouldProvisionOnInstall({ ...base, hasPendingMarker: false })).toBe(false);
    expect(shouldProvisionOnInstall({ ...base, consentSource: 'recommended_default' })).toBe(false);
    expect(shouldProvisionOnInstall({ ...base, consentIntent: 'refresh_if_registered' })).toBe(false);
    expect(shouldProvisionOnInstall({ ...base, schedulerState: 'registered_disabled' })).toBe(false);
  });
});

// PRI-1278 Phase 5: host integration and the background life cycle are two
// independent dimensions. `--host` must NOT silently default to OpenClaw, and
// the scheduler must expose an explicit opt-out plus the consent flags.
describe('PRI-1278 Phase 5 install flag registration (cli-7, real program)', () => {
  const installCmd = program.commands.find((c) => c.name() === 'install');

  it('--host has NO default (omitting it must never install OpenClaw)', () => {
    const opt = installCmd!.options.find((o) => o.long === '--host');
    expect(opt).toBeDefined();
    expect(opt?.defaultValue).toBeUndefined();
  });

  it('exposes the explicit scheduler opt-out', () => {
    const opt = installCmd!.options.find((o) => o.long === '--no-service-host');
    expect(opt).toBeDefined();
  });

  it('keeps the explicit register/enable consent flags', () => {
    const register = installCmd!.options.find((o) => o.long === '--register-service-host');
    const enable = installCmd!.options.find((o) => o.long === '--enable-service-host');
    expect(register?.defaultValue).toBe(false);
    expect(enable?.defaultValue).toBe(false);
  });
});