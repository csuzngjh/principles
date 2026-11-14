/**
 * PRI-455: SKILL ↔ CLI contract test.
 *
 * Every `pd ...` command written in a shipped skill document must resolve to a
 * real path in the CLI command tree. This prevents skills from instructing an
 * agent (or the Owner) to run a command that was renamed, deleted, or never
 * existed.
 *
 * Why this rewrite (2026-11-14 CLI usage audit):
 *   - the previous version probed `node dist/index.js <path> --help` in a child
 *     process. It therefore depended on a built tree AND on the whole dependency
 *     chain resolving, so an unbuilt checkout reported 60 false "missing
 *     command" failures and said nothing about the actual document drift.
 *   - it read only `<skills>/<name>/SKILL.md`, so `references/*.md`, other
 *     languages and the rendered per-host copies were never checked.
 *   - it checked a string of up to 3 tokens including argument placeholders.
 *
 * Coverage (all skill hosts, all languages, discovered dynamically so a new
 * language cannot be silently skipped):
 *   - OpenClaw plugin templates: packages/openclaw-plugin/templates/langs/<lang>/skills
 *   - pd-skills source:          packages/pd-skills/skills
 *   - Codex plugin skills:       plugins/principles-disciple/skills
 *   - WorkBuddy adapter skills:  packages/workbuddy-adapter/plugin/skills
 *
 * The command tree is read from `buildPdProgram()` in-process — the same object
 * the real CLI parses (cli-7-test-wiring) — so drift is reported without a
 * build step and the failure names the exact file, line and command.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import type { Command } from 'commander';
import { buildPdProgram } from '../../src/program.js';

// ── Command tree ────────────────────────────────────────────────────────────

interface CommandNode {
  readonly children: ReadonlyMap<string, CommandNode>;
}

/** Build a name → node map including commander aliases. */
function toCommandNode(command: Command): CommandNode {
  const children = new Map<string, CommandNode>();
  for (const child of command.commands) {
    const node = toCommandNode(child);
    children.set(child.name(), node);
    for (const alias of child.aliases()) children.set(alias, node);
  }
  return { children };
}

// ── Reference extraction ────────────────────────────────────────────────────

/** A `pd ...` reference found in a document, with its source location. */
interface PdReference {
  readonly file: string;
  readonly line: number;
  readonly command: string;
  /** Command tokens the tree could NOT resolve (empty when valid). */
  readonly unresolved: string[];
  /** Longest path that does resolve, for a useful failure message. */
  readonly resolvedPrefix: string;
}

/** Tokens that are argument placeholders, not command segments. */
function looksLikeCommandWord(token: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(token);
}

/**
 * Resolve the command words after `pd`.
 *
 * The tree is walked greedily. The first token that is not a registered child
 * ends the walk: if it still looks like a bare command word, the document is
 * referring to a command that does not exist (drift); otherwise it is an
 * argument (id, path, placeholder) and the reference is valid.
 */
function resolveReference(node: CommandNode, words: string[]): { unresolved: string[]; resolvedPrefix: string } {
  const resolved: string[] = [];
  let current = node;
  for (const word of words) {
    const next = current.children.get(word);
    if (next === undefined) {
      if (looksLikeCommandWord(word) && current.children.size > 0) {
        return { unresolved: [word], resolvedPrefix: resolved.join(' ') };
      }
      break;
    }
    resolved.push(word);
    current = next;
  }
  return { unresolved: [], resolvedPrefix: resolved.join(' ') };
}

/** Split a shell-ish command snippet into the words that follow `pd`. */
function wordsAfterPd(snippet: string): string[] | null {
  const match = /(?:^|[\s;|&$(])pd\s+(.+)$/.exec(snippet);
  if (match === null) return null;
  const words: string[] = [];
  for (const raw of match[1].trim().split(/\s+/)) {
    const word = raw.replace(/[),.;:]+$/, '');
    if (word.length === 0) continue;
    if (word.startsWith('-') || word.startsWith('<') || word.startsWith('$') || word.startsWith('=')) break;
    if (/[`"'/[\\]/.test(word)) break;
    words.push(word);
  }
  return words.length > 0 ? words : null;
}

/**
 * Split a captured snippet at EVERY shell separator and return each `pd` call.
 * Truncating at the first one let `pd pain recall && pd principle list` pass the
 * guard while the document still advertised a command that does not exist.
 */
function snippetCommands(snippet: string): string[] {
  return snippet
    .split(/&&|\|\||[;|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Extract `pd ...` references from the code contexts of a markdown document:
 * inline code spans, fenced blocks, and indented code lines. Prose is ignored
 * on purpose — "the pd command" is not a command reference.
 */
function extractReferences(markdown: string): { line: number; snippet: string }[] {
  const references: { line: number; snippet: string }[] = [];
  const lines = markdown.split(/\r?\n/);
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const lineNumber = index + 1;

    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s{2,}\S/.test(line) || /^(?:\$ )?pd\s/.test(trimmed)) {
      references.push({ line: lineNumber, snippet: trimmed });
    }
    for (const inline of line.matchAll(/`([^`]+)`/g)) {
      if (/(?:^|[\s;|&$(])pd\s+/.test(inline[1])) {
        references.push({ line: lineNumber, snippet: inline[1].trim() });
      }
    }
  }
  return references;
}

// ── Host discovery ──────────────────────────────────────────────────────────

interface SkillHost {
  readonly host: string;
  readonly dir: string;
}

/** Find every skill host tree; a missing tree is a contract break, not a skip. */
function resolveSkillHosts(repoRoot: string): { hosts: SkillHost[]; missing: string[] } {
  const hosts: SkillHost[] = [];
  const missing: string[] = [];

  const langsDir = join(repoRoot, 'packages', 'openclaw-plugin', 'templates', 'langs');
  if (existsSync(langsDir)) {
    for (const lang of readdirSync(langsDir, { withFileTypes: true })) {
      if (!lang.isDirectory()) continue;
      const dir = join(langsDir, lang.name, 'skills');
      if (existsSync(dir)) hosts.push({ host: `openclaw-${lang.name}`, dir });
      else missing.push(`openclaw-${lang.name}`);
    }
  } else {
    missing.push('openclaw-templates');
  }

  const fixed: SkillHost[] = [
    { host: 'pd-skills', dir: join(repoRoot, 'packages', 'pd-skills', 'skills') },
    { host: 'codex', dir: join(repoRoot, 'plugins', 'principles-disciple', 'skills') },
    { host: 'workbuddy', dir: join(repoRoot, 'packages', 'workbuddy-adapter', 'plugin', 'skills') },
  ];
  for (const candidate of fixed) {
    if (existsSync(candidate.dir)) hosts.push(candidate);
    else missing.push(candidate.host);
  }
  return { hosts, missing };
}

/** All markdown files below a directory (recursive). */
function markdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(full);
  }
  return files;
}

// ── Scan ────────────────────────────────────────────────────────────────────

const repoRoot = resolve(process.cwd(), '..', '..');
const { hosts, missing } = resolveSkillHosts(repoRoot);
const tree = toCommandNode(buildPdProgram());

const scanned: { host: string; files: number; references: number }[] = [];
const findings: PdReference[] = [];

for (const { host, dir } of hosts) {
  let references = 0;
  const files = markdownFiles(dir);
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const { line, snippet } of extractReferences(content)) {
      // Every command after &&, ||, ; or | is a real `pd` reference and must be
      // validated against the same tree — dropping the tail hid drift.
      for (const part of snippetCommands(snippet)) {
        const words = wordsAfterPd(part);
        if (words === null) continue;
        references += 1;
        const result = resolveReference(tree, words);
        if (result.unresolved.length > 0) {
          findings.push({
            file: relative(repoRoot, file).split('\\').join('/'),
            line,
            command: words.join(' '),
            unresolved: result.unresolved,
            resolvedPrefix: result.resolvedPrefix,
          });
        }
      }
    }
  }
  scanned.push({ host, files: files.length, references });
}

describe('PRI-455: SKILL ↔ CLI contract', () => {
  it('validates every pd call after a shell separator, not just the first', () => {
    // Regression: trimming at the first separator accepted a document that
    // still advertised `pd principle list` behind `&&`.
    const parts = snippetCommands('pd runtime usage report --json && pd principle list');
    expect(parts).toEqual(['pd runtime usage report --json', 'pd principle list']);

    const first = wordsAfterPd(parts[0]!);
    const second = wordsAfterPd(parts[1]!);
    expect(first).not.toBeNull();
    expect(resolveReference(tree, first!).unresolved).toEqual([]);
    expect(second).toEqual(['principle', 'list']);
    expect(resolveReference(tree, second!).unresolved.length).toBeGreaterThan(0);

    // The other shell separators must not drop the trailing call either.
    for (const sep of [';', '||', '|']) {
      const split = snippetCommands(`pd runtime usage report --json ${sep} pd principle list`);
      expect(split).toHaveLength(2);
      expect(resolveReference(tree, wordsAfterPd(split[1]!)!).unresolved.length).toBeGreaterThan(0);
    }
  });

  it('every skill host tree exists (openclaw per language, pd-skills, codex, workbuddy)', () => {
    expect(missing, `missing skill host directories: ${missing.join(', ')}`).toEqual([]);
  });

  it('found SKILL documents that reference pd commands in every host', () => {
    for (const entry of scanned) {
      expect(entry.files, `host ${entry.host} has no markdown files`).toBeGreaterThan(0);
      expect(entry.references, `host ${entry.host} has no pd command references`).toBeGreaterThan(0);
    }
  });

  it('every pd command referenced by a skill document exists in the real command tree', () => {
    const detail = findings
      .map(
        (f) =>
          `${f.file}:${f.line}  "pd ${f.command}"  -> unknown: ${f.unresolved.join(' ')}` +
          (f.resolvedPrefix ? `  (resolved: pd ${f.resolvedPrefix})` : ''),
      )
      .join('\n');
    expect(findings, `\n${findings.length} unresolved pd command reference(s):\n${detail}\n`).toEqual([]);
  });

  it('every host pd-cli-operator skill documents `pd pain recall` (SPEC-PD-PAIN-RECALL-CLI-001 §8.2)', () => {
    for (const { host, dir } of hosts) {
      const skillDir = join(dir, 'pd-cli-operator');
      expect(existsSync(skillDir), `pd-cli-operator skill directory missing for host ${host}`).toBe(true);
      // Rendered hosts ship one SKILL.md; the pd-skills source ships one file per language.
      const delivered = join(skillDir, 'SKILL.md');
      const files = existsSync(delivered)
        ? [delivered]
        : readdirSync(skillDir)
            .filter((name) => name.toLowerCase().endsWith('.md'))
            .map((name) => join(skillDir, name));
      expect(files.length, `no pd-cli-operator markdown for host ${host}`).toBeGreaterThan(0);
      for (const file of files) {
        expect(readFileSync(file, 'utf8'), `${relative(repoRoot, file)} must reference pd pain recall`).toMatch(
          /pd pain recall/,
        );
      }
    }
  });
});
