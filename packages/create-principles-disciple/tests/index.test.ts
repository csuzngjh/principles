import { describe, it, expect } from 'vitest';
import { isLanguage } from '../src/i18n.js';
import { program } from '../src/index.js';

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