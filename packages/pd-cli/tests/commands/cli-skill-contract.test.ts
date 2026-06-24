/**
 * PRI-455: SKILL ↔ CLI contract test.
 *
 * Parses SKILL.md templates for `pd <command>` references and verifies
 * that each referenced command path exists in the CLI command tree.
 *
 * This prevents SKILL templates from referencing deleted or renamed commands.
 *
 * Covers BOTH `en` and `zh` skill directories so bilingual template updates
 * are validated. Fails explicitly (does not silently skip) when the expected
 * skills directory is missing — a missing directory is a real contract break.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';

/**
 * Resolve the skills directory for a given language.
 * Tests run from packages/pd-cli, so the plugin templates live one level up.
 */
function resolveSkillsDir(lang: 'en' | 'zh'): string {
  return resolve(
    process.cwd(),
    '..',
    'openclaw-plugin',
    'templates',
    'langs',
    lang,
    'skills',
  );
}

/**
 * Extract `pd <command> [subcommand] ...` patterns from SKILL.md content.
 * Matches lines like:
 *   pd pain record --reason ...
 *   pd runtime probe --json
 *   pd candidate list --workspace ...
 * Returns full command paths (e.g. "pain record", "runtime probe").
 */
function extractPdCommands(markdown: string): string[] {
  const commands: string[] = [];
  // Match `pd <words>` in code blocks and inline code
  const pdPattern = /`pd\s+([\w-]+(?:\s+[\w-]+)*)/g;
  let match: RegExpExecArray | null;
  while ((match = pdPattern.exec(markdown)) !== null) {
    // Take up to 3 path segments (e.g. "runtime internalization queue")
    const parts = match[1].split(/\s+/).slice(0, 3);
    // Filter out flags and options
    const cleanParts = parts.filter((p) => !p.startsWith('--') && !p.startsWith('<'));
    if (cleanParts.length > 0) {
      commands.push(cleanParts.join(' '));
    }
  }
  return [...new Set(commands)];
}

/**
 * Check if a command path exists by running `pd <path> --help`.
 * Returns true if the command is registered (exit code 0 or help output contains "Usage:").
 */
function commandExists(commandPath: string): boolean {
  const args = commandPath.split(' ');
  try {
    const output = execFileSync('node', [getBuiltPdCliPath(), ...args, '--help'], {
      encoding: 'utf8',
      cwd: process.cwd(),
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.includes('Usage:') || output.includes('Options:');
  } catch {
    return false;
  }
}

// Collect (lang, skill, command) triples across both en and zh.
// A missing skills directory is a real contract break — fail explicitly.
const LANGS = ['en', 'zh'] as const;
const skillCommandPairs: { lang: string; skill: string; command: string }[] = [];
const missingLangDirs: string[] = [];

for (const lang of LANGS) {
  const skillsDir = resolveSkillsDir(lang);
  if (!existsSync(skillsDir)) {
    missingLangDirs.push(lang);
    continue;
  }
  const skillDirs = readdirSync(skillsDir).filter((dir) =>
    existsSync(join(skillsDir, dir, 'SKILL.md')),
  );
  for (const dir of skillDirs) {
    const skillPath = join(skillsDir, dir, 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');
    const commands = extractPdCommands(content);
    for (const cmd of commands) {
      skillCommandPairs.push({ lang, skill: dir, command: cmd });
    }
  }
}

describe('PRI-455: SKILL ↔ CLI contract', () => {
  it('both en and zh skills directories exist', () => {
    // Explicit failure instead of silent skip — a missing directory means
    // the contract is no longer being validated for that language.
    expect(missingLangDirs, `missing skills directories: ${missingLangDirs.join(', ')}`).toEqual([]);
  });

  it('found SKILL files that reference pd commands', () => {
    expect(skillCommandPairs.length).toBeGreaterThan(0);
  });

  // Test each SKILL-referenced command exists in the CLI
  for (const { lang, skill, command } of skillCommandPairs) {
    it(`[${lang}] SKILL "${skill}" references valid command: pd ${command}`, () => {
      expect(commandExists(command)).toBe(true);
    });
  }
});
