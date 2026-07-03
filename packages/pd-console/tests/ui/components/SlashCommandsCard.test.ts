/**
 * Source-contract test for SlashCommandsCard component (PRI-506).
 *
 * The vitest config uses 'node' environment (no jsdom), so we cannot mount
 * React components with @testing-library/react. Instead we verify the
 * source-code contract — mirroring the pattern in CircuitDiagram.test.ts.
 *
 * Guards against:
 *  - commands prop contract (Array<{ name, alias?, descriptionKey }>)
 *  - descriptions rendered via t(cmd.descriptionKey) (no hardcoded strings)
 *  - empty list fallback (rc-9: no silent fallback — show fallback text)
 *  - i18n key routing for the fallback string
 *  - ONBOARDING_SLASH_COMMANDS exports 7 commands with matching i18n keys
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNestedRecord, parseJsonRecord } from '../i18n-test-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui/components
// SRC_ROOT  = packages/pd-console/src/ui
const SRC_ROOT = join(__dirname, '..', '..', '..', 'src', 'ui');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

const COMPONENT_SOURCE = readSrc('components/onboarding/SlashCommandsCard.tsx');
const COMMANDS_MODULE_SOURCE = readSrc('components/onboarding/slashCommands.ts');

describe('SlashCommandsCard: prop contract', () => {
  it('accepts a commands array prop with name and descriptionKey fields', () => {
    expect(COMPONENT_SOURCE).toContain('commands');
    expect(COMPONENT_SOURCE).toContain('name');
    expect(COMPONENT_SOURCE).toContain('descriptionKey');
  });

  it('renders commands via .map() iteration', () => {
    expect(COMPONENT_SOURCE).toContain('.map(');
  });

  it('renders descriptions via t(cmd.descriptionKey) (no hardcoded description prop)', () => {
    expect(COMPONENT_SOURCE).toContain('t(cmd.descriptionKey)');
    expect(COMPONENT_SOURCE).not.toContain('cmd.description}');
  });
});

describe('SlashCommandsCard: empty list fallback (rc-9)', () => {
  it('shows a fallback message when commands array is empty (no silent blank)', () => {
    // rc-9: graceful degradation must include a reason — empty commands must
    // not render as a blank section.
    expect(COMPONENT_SOURCE).toContain('length');
    expect(COMPONENT_SOURCE).toMatch(/emptyListFallback|fallback/);
  });

  it('reads the fallback text from i18n (no hardcoded strings)', () => {
    expect(COMPONENT_SOURCE).toContain('pages.welcome.step3.emptyListFallback');
  });
});

describe('slashCommands.ts: command metadata module', () => {
  it('exports ONBOARDING_SLASH_COMMANDS array with 7 commands', () => {
    expect(COMMANDS_MODULE_SOURCE).toContain('ONBOARDING_SLASH_COMMANDS');
    // Count the 7 array entries (each has descriptionKey: 'pages.welcome...')
    const matches = COMMANDS_MODULE_SOURCE.match(/descriptionKey: 'pages\.welcome/g) ?? [];
    expect(matches.length).toBe(7);
  });

  it('each command has name and descriptionKey (no description field)', () => {
    expect(COMMANDS_MODULE_SOURCE).not.toContain('description:');
    expect(COMMANDS_MODULE_SOURCE).toContain('descriptionKey:');
  });

  it('all descriptionKeys point to pages.welcome.step3.commandDescriptions', () => {
    expect(COMMANDS_MODULE_SOURCE).toContain('pages.welcome.step3.commandDescriptions.pdInit');
    expect(COMMANDS_MODULE_SOURCE).toContain('pages.welcome.step3.commandDescriptions.pdStatus');
    expect(COMMANDS_MODULE_SOURCE).toContain('pages.welcome.step3.commandDescriptions.pdPain');
    expect(COMMANDS_MODULE_SOURCE).toContain('pages.welcome.step3.commandDescriptions.pdHelp');
    expect(COMMANDS_MODULE_SOURCE).toContain('pages.welcome.step3.commandDescriptions.pdContext');
    expect(COMMANDS_MODULE_SOURCE).toContain('pages.welcome.step3.commandDescriptions.pdEvolutionStatus');
    expect(COMMANDS_MODULE_SOURCE).toContain('pages.welcome.step3.commandDescriptions.pdFocus');
  });
});

describe('SlashCommandsCard: i18n keys exist', () => {
  it('Given i18n keys, When checked, Then step3.commandDescriptions and emptyListFallback exist in en.json and zh-CN.json', () => {
    const en = getNestedRecord(parseJsonRecord(readSrc('i18n/en.json')), ['pages', 'welcome', 'step3']);
    const zh = getNestedRecord(parseJsonRecord(readSrc('i18n/zh-CN.json')), ['pages', 'welcome', 'step3']);
    expect(en).toBeDefined();
    expect(zh).toBeDefined();
    expect(Object.hasOwn(en, 'commandDescriptions')).toBe(true);
    expect(Object.hasOwn(zh, 'commandDescriptions')).toBe(true);
    expect(en.emptyListFallback).toBeDefined();
    expect(zh.emptyListFallback).toBeDefined();
  });

  it('Given commandDescriptions in i18n, When checked, Then all 7 command descriptions exist as strings', () => {
    const enStep3 = getNestedRecord(parseJsonRecord(readSrc('i18n/en.json')), ['pages', 'welcome', 'step3']);
    const zhStep3 = getNestedRecord(parseJsonRecord(readSrc('i18n/zh-CN.json')), ['pages', 'welcome', 'step3']);
    const enCmds = getNestedRecord(enStep3, ['commandDescriptions']);
    const zhCmds = getNestedRecord(zhStep3, ['commandDescriptions']);

    const expectedKeys = ['pdInit', 'pdStatus', 'pdPain', 'pdHelp', 'pdContext', 'pdEvolutionStatus', 'pdFocus'];
    for (const key of expectedKeys) {
      expect(typeof enCmds[key]).toBe('string');
      expect(typeof zhCmds[key]).toBe('string');
    }
  });
});
