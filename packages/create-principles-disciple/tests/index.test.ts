import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { isLanguage } from '../src/i18n.js';

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

// cli-7: exercise the actual --stop-gateway flag registration contract.
// Mirrors the option declared on the `install` command in src/index.ts.
describe('--stop-gateway flag parsing (cli-7)', () => {
  function buildInstallCommand(): Command {
    const program = new Command();
    program
      .command('install', { isDefault: true, hidden: true })
      .option('--stop-gateway', 'Stop the OpenClaw gateway before install if running, restart after', false);
    return program;
  }

  it('defaults stopGateway to false when the flag is absent', () => {
    const program = buildInstallCommand();
    program.parse(['node', 'create-principles-disciple']);
    const installCommand = program.commands.find((c) => c.name() === 'install');
    expect(installCommand?.opts().stopGateway).toBe(false);
  });

  it('sets stopGateway to true when --stop-gateway is passed', () => {
    const program = buildInstallCommand();
    program.parse(['node', 'create-principles-disciple', '--stop-gateway']);
    const installCommand = program.commands.find((c) => c.name() === 'install');
    expect(installCommand?.opts().stopGateway).toBe(true);
  });
});