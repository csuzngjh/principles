/**
 * PRI-455: SKILL ↔ CLI contract test.
 *
 * Parses SKILL.md templates for `pd <command>` references and verifies
 * that each referenced command path exists in the CLI command tree.
 *
 * This prevents SKILL templates from referencing deleted or renamed commands.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';

const PLUGIN_SKILLS_DIR = resolve(
  process.cwd(),
  '..',
  'openclaw-plugin',
  'templates',
  'langs',
  'en',
  'skills',
);

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

// Skip if openclaw-plugin skills directory doesn't exist (e.g. running in isolation)
const skipSkillTests = !existsSync(PLUGIN_SKILLS_DIR);

describe.skipIf(skipSkillTests)('PRI-455: SKILL ↔ CLI contract', () => {
  // Find all SKILL.md files that reference pd commands
  const skillDirs = skipSkillTests
    ? []
    : readdirSync(PLUGIN_SKILLS_DIR).filter((dir) =>
        existsSync(join(PLUGIN_SKILLS_DIR, dir, 'SKILL.md')),
      );

  // Collect all (skill, command) pairs
  const skillCommandPairs: { skill: string; command: string }[] = [];
  for (const dir of skillDirs) {
    const skillPath = join(PLUGIN_SKILLS_DIR, dir, 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');
    const commands = extractPdCommands(content);
    for (const cmd of commands) {
      skillCommandPairs.push({ skill: dir, command: cmd });
    }
  }

  it('found SKILL files that reference pd commands', () => {
    expect(skillCommandPairs.length).toBeGreaterThan(0);
  });

  // Test each SKILL-referenced command exists in the CLI
  for (const { skill, command } of skillCommandPairs) {
    it(`SKILL "${skill}" references valid command: pd ${command}`, () => {
      expect(commandExists(command)).toBe(true);
    });
  }
});
