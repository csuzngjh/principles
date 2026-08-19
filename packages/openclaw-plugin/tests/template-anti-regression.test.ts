/**
 * Anti-regression contract for shipped core workspace templates (Round 3, PRI-547).
 *
 * PD is an owner-governed behavior layer. It must NOT ship retired pre-pivot
 * semantics in the core templates it flattens into user workspaces, and it must
 * NOT ship identity/persona/user-profile content that forces a persona or
 * presets real user preferences.
 *
 * Two layers:
 *  1. Source layer: scan templates/langs/{en,zh}/core/ directly.
 *  2. Tarball layer: npm pack (--ignore-scripts, templates are static files
 *     that do not depend on the build) and verify the packaged files and their
 *     content — not just the source tree.
 *
 * Negation-aware: a banned term inside a "does not own / do not" sentence is
 * allowed (that is the correct way to state PD's boundary); a banned term in a
 * prescriptive/affirmative sentence is a contract violation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');

const CORE_DIRS = [
  path.join(PACKAGE_ROOT, 'templates', 'langs', 'en', 'core'),
  path.join(PACKAGE_ROOT, 'templates', 'langs', 'zh', 'core'),
];

/** Files PD is allowed to ship in core templates (OpenClaw host loads these). */
const EXPECTED_CORE_FILES = [
  'AGENTS.md',
  'BOOT.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'PRINCIPLES.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
] as const;

/** Retired semantics that must never appear in an affirmative/prescriptive sense. */
const RETIRED_TERMS = [
  'spicy evolver',
  '麻辣进化者',
  'weekly_governance',
  'evolution_queue',
  "don't ask permission",
  '不要请求许可',
  'self-evolution',
  '自我进化',
  'heartbeat-state',
  'current_focus',
  'strategy.md',
  'conductor',
  'task completion protocol',
  'groom memory',
  '整理记忆',
  'group-chat persona',
  '流程即权限',
  'process as authority',
  '2026-03-13',
] as const;

/**
 * Boundary-statement words: allowed only when the file contains an explicit
 * "PD does not own this" boundary declaration. A prescriptive occurrence
 * (e.g. "align to strategy.md every heartbeat") is a contract violation.
 */
const BOUNDARY_TERMS = [
  'strategic alignment',
  '战略对齐',
  'task derivation',
  '任务衍生',
  'memory maintenance',
  '记忆维护',
  'memory grooming',
] as const;

/** File-level boundary declarations that license BOUNDARY_TERMS. */
const BOUNDARY_DECLARATIONS = [
  'does not own',
  'does not prescribe',
  '不拥有',
  '不预设',
  '不属于',
] as const;

/** Line-level negations that make a banned term acceptable (boundary statement). */
const NEGATION_RE =
  /(do not|does not|don't|never|not own|does not own|no |without|不|不要|没有|不属于|不拥有|不是|非 pd|非pd)/i;

function collectCoreFiles(): { dir: string; file: string; content: string }[] {
  const out: { dir: string; file: string; content: string }[] = [];
  for (const dir of CORE_DIRS) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      // Read directly: the templates are static fixtures and a missing file
      // must fail loudly rather than being masked by a stat/exists pre-check.
      const content = fs.readFileSync(full, 'utf8');
      out.push({ dir, file: entry.name, content });
    }
  }
  return out;
}

function findRetiredHits(content: string): string[] {
  const hits = new Set<string>();
  const lines = content.split(/\r?\n/);
  const hasBoundaryDeclaration = BOUNDARY_DECLARATIONS.some((d) => content.toLowerCase().includes(d.toLowerCase()));
  for (const line of lines) {
    for (const term of RETIRED_TERMS) {
      if (line.toLowerCase().includes(term.toLowerCase())) {
        if (NEGATION_RE.test(line)) continue;
        hits.add(term);
      }
    }
    for (const term of BOUNDARY_TERMS) {
      if (line.toLowerCase().includes(term.toLowerCase())) {
        // Licensed only when the file declares PD's boundary at the file level.
        if (hasBoundaryDeclaration || NEGATION_RE.test(line)) continue;
        hits.add(term);
      }
    }
  }
  return [...hits];
}

function assertTemplatesClean(label: string, files: { dir?: string; file: string; content: string }[]) {
  // File-set check must be per language directory (en/zh have the same names).
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const key = f.dir ?? 'default';
    const list = byDir.get(key) ?? [];
    list.push(path.basename(f.file));
    byDir.set(key, list);
  }
  const expected = [...EXPECTED_CORE_FILES].sort();
  for (const [dir, names] of byDir) {
    expect(names.sort(), `${label}: core template file set in ${dir}`).toEqual(expected);
  }
  for (const f of files) {
    const hits = findRetiredHits(f.content);
    expect(hits, `${label}: retired semantics in ${f.file}`).toEqual([]);
  }
}

describe('core template anti-regression contract (Round 3)', () => {
  it('source templates: only neutral PD-scoped files, no retired semantics', () => {
    assertTemplatesClean('source', collectCoreFiles());
  });

  it('source templates: PRINCIPLES.md is a neutral scaffold without author P-10', () => {
    for (const dir of CORE_DIRS) {
      const p = path.join(dir, 'PRINCIPLES.md');
      expect(fs.existsSync(p)).toBe(true);
      const content = fs.readFileSync(p, 'utf8');
      // Neutral scaffold: points at the runtime as the source of truth for
      // T-01..T-10, and must not re-print them or the author's historical P-10.
      expect(content.toLowerCase()).not.toContain('流程即权限');
      expect(content.toLowerCase()).not.toContain('process as authority');
      expect(content).not.toContain('2026-03-13');
      expect(content.toLowerCase()).not.toContain('p-10');
      // A T-list reprint (T-01 Survey..., T-02 ...) would create a second
      // source of truth. Bare mention like "T-01-T-10" is fine, but the
      // principle names themselves must not be reprinted here.
      const tNames = [
        'survey before acting',
        'respect constraints',
        'evidence over assumption',
        'reversible first',
        'safety rails',
        'simplicity first',
        'minimal change',
        'pain as signal',
        'divide and conquer',
        'memory externalization',
      ];
      for (const name of tNames) {
        expect(content.toLowerCase()).not.toContain(name);
      }
    }
  });
});

describe('packaged tarball anti-regression contract (Round 3)', () => {
  let tarballDir: string;
  let tarballPath: string;
  let extractedDir: string;

  beforeAll(() => {
    tarballDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tpl-tarball-'));
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const out = execFileSync(npmCmd, ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballDir], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    const start = out.indexOf('[');
    const end = out.lastIndexOf(']');
    const parsed = JSON.parse(out.slice(start, end + 1));
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    tarballPath = path.join(tarballDir, entry.filename);
    expect(fs.existsSync(tarballPath)).toBe(true);

    extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tpl-extract-'));
    execFileSync('tar', ['-xzf', tarballPath, '-C', extractedDir], { encoding: 'utf8' });
  });

  it('tarball contains core templates with the expected file set', () => {
    for (const lang of ['en', 'zh']) {
      const dir = path.join(extractedDir, 'package', 'templates', 'langs', lang, 'core');
      const names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile()).sort();
      expect(names, `tarball ${lang} core files`).toEqual([...EXPECTED_CORE_FILES].sort());
    }
  });

  it('tarball ships .principles/PRINCIPLES.md (principle repository scaffold)', () => {
    for (const lang of ['en', 'zh']) {
      const workspaceScaffold = path.join(extractedDir, 'package', 'templates', 'workspace', '.principles', 'PRINCIPLES.md');
      expect(fs.existsSync(workspaceScaffold), `tarball ${lang} workspace scaffold`).toBe(true);
    }
  });

  it('tarball core template content has no retired semantics', () => {
    const files: { dir: string; file: string; content: string }[] = [];
    for (const lang of ['en', 'zh']) {
      const dir = path.join(extractedDir, 'package', 'templates', 'langs', lang, 'core');
      for (const name of fs.readdirSync(dir)) {
        files.push({ dir: `tarball/${lang}`, file: name, content: fs.readFileSync(path.join(dir, name), 'utf8') });
      }
    }
    assertTemplatesClean('tarball', files);
  });
});
