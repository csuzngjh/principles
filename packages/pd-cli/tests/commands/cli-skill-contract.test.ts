/**
 * PRI-455: SKILL ↔ CLI contract test.
 *
 * Parses SKILL.md templates for `pd <command>` references and verifies
 * that each referenced command path exists in the CLI command tree.
 *
 * This prevents SKILL templates from referencing deleted or renamed commands.
 *
 * Covers ALL THREE skill hosts (SPEC-PD-PAIN-RECALL-CLI-001 §8.2):
 *   - OpenClaw plugin templates (en + zh)
 *   - Codex plugin skills (plugins/principles-disciple/skills)
 *   - WorkBuddy adapter plugin skills (packages/workbuddy-adapter/plugin/skills)
 * Fails explicitly (does not silently skip) when the expected skills directory
 * is missing — a missing directory is a real contract break.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';

/** One skill host's skills directory, resolved relative to packages/pd-cli. */
interface SkillHost {
  host: 'openclaw-en' | 'openclaw-zh' | 'codex' | 'workbuddy';
  dir: string;
}

function resolveSkillHosts(): { hosts: SkillHost[]; missing: string[] } {
  const candidates: SkillHost[] = [
    { host: 'openclaw-en', dir: resolve(process.cwd(), '..', 'openclaw-plugin', 'templates', 'langs', 'en', 'skills') },
    { host: 'openclaw-zh', dir: resolve(process.cwd(), '..', 'openclaw-plugin', 'templates', 'langs', 'zh', 'skills') },
    { host: 'codex', dir: resolve(process.cwd(), '..', '..', 'plugins', 'principles-disciple', 'skills') },
    { host: 'workbuddy', dir: resolve(process.cwd(), '..', 'workbuddy-adapter', 'plugin', 'skills') },
  ];
  const hosts: SkillHost[] = [];
  const missing: string[] = [];
  for (const candidate of candidates) {
    if (existsSync(candidate.dir)) {
      hosts.push(candidate);
    } else {
      missing.push(candidate.host);
    }
  }
  return { hosts, missing };
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

// Collect (host, skill, command) triples across all hosts.
// A missing skills directory is a real contract break — fail explicitly.
const { hosts: skillHosts, missing: missingHostDirs } = resolveSkillHosts();
const skillCommandPairs: { host: string; skill: string; command: string }[] = [];

for (const { host, dir } of skillHosts) {
  const skillDirs = readdirSync(dir).filter((sub) =>
    existsSync(join(dir, sub, 'SKILL.md')),
  );
  for (const skillDir of skillDirs) {
    const skillPath = join(dir, skillDir, 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');
    for (const cmd of extractPdCommands(content)) {
      skillCommandPairs.push({ host, skill: skillDir, command: cmd });
    }
  }
}

describe('PRI-455: SKILL ↔ CLI contract', () => {
  it('all skill host directories exist (openclaw en/zh, codex, workbuddy)', () => {
    // Explicit failure instead of silent skip — a missing directory means the
    // contract is no longer being validated for that host.
    expect(missingHostDirs, `missing skill host directories: ${missingHostDirs.join(', ')}`).toEqual([]);
  });

  it('found SKILL files that reference pd commands in every host', () => {
    expect(skillCommandPairs.length).toBeGreaterThan(0);
    for (const host of ['openclaw-en', 'openclaw-zh', 'codex', 'workbuddy'] as const) {
      const hostPairs = skillCommandPairs.filter((p) => p.host === host);
      expect(hostPairs.length, `host ${host} has no pd command references`).toBeGreaterThan(0);
    }
  });

  it('every host pd-cli-operator skill documents `pd pain recall` (SPEC-PD-PAIN-RECALL-CLI-001 §8.2)', () => {
    for (const { host, dir } of skillHosts) {
      const skillPath = join(dir, 'pd-cli-operator', 'SKILL.md');
      expect(existsSync(skillPath), `pd-cli-operator SKILL.md missing for host ${host}`).toBe(true);
      const content = readFileSync(skillPath, 'utf8');
      expect(content, `host ${host} pd-cli-operator must reference pd pain recall`).toMatch(/pd pain recall/);
    }
  });

  // Test each SKILL-referenced command exists in the CLI
  for (const { host, skill, command } of skillCommandPairs) {
    it(`[${host}] SKILL "${skill}" references valid command: pd ${command}`, () => {
      expect(commandExists(command)).toBe(true);
    });
  }
});
