/**
 * Plugin manifest skill-declaration invariants + shipped skill-set contract.
 *
 * OpenClaw's plugin skill loader resolves every directory listed in
 * openclaw.plugin.json `skills` (relative to the plugin root) and publishes
 * each immediate child containing SKILL.md, keyed by the child's NAME —
 * the first declaration wins; later same-name directories only produce a
 * "plugin skill name collision" warning and are silently dropped. There is
 * NO locale/i18n mechanism for plugin skills.
 *
 * Declaring both templates/langs/{en,zh}/skills therefore (a) emitted
 * collision warnings on every gateway start and (b) silently pinned every
 * published skill to the language listed first (en), even though PD's
 * product default language is zh.
 *
 * Contract: exactly ONE skills root is declared — the product-default
 * language (zh). The en templates stay in the package as translation assets
 * for install-time language selection (`--lang en` rewrites the INSTALLED
 * manifest's skills root to the en templates — see
 * create-principles-disciple/src/skill-language.ts); they are simply not
 * declared for publication here.
 *
 * PRI-547 (ClawHub audit remediation): the shipped skill set is exactly the
 * 8 MVP pd-* skills. The 15 pre-pivot evolution-framework skills were dead
 * weight in the published artifact and a major source of ClawHub security
 * findings. This test is the permanent gate keeping legacy skills out of
 * the shipped plugin.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { isAbsolute, join, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

/** The only skills allowed to ship (PRI-547 ClawHub audit remediation). */
const EXPECTED_SKILLS = [
  'pd-auditor',
  'pd-cli-operator',
  'pd-explorer',
  'pd-implementer',
  'pd-mentor',
  'pd-pain-signal',
  'pd-planner',
  'pd-runtime-v2',
] as const;

/**
 * Model-invocation boundary (PRI-547 AC-02/AC-03): every skill must declare
 * `disable-model-invocation` EXPLICITLY. Only the three narrow PD operational
 * skills stay model-discoverable; the five SOP role skills must not enter the
 * model prompt on their own.
 */
const EXPECTED_MODEL_INVOCATION_DISABLED: Record<string, boolean> = {
  'pd-auditor': true,
  'pd-cli-operator': false,
  'pd-explorer': true,
  'pd-implementer': true,
  'pd-mentor': true,
  'pd-pain-signal': false,
  'pd-planner': true,
  'pd-runtime-v2': false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// rc-1/rc-2: manifest parsed as unknown and narrowed with a type guard.
const manifestRaw: unknown = JSON.parse(
  readFileSync(join(packageRoot, 'openclaw.plugin.json'), 'utf-8'),
);
if (!isRecord(manifestRaw)) {
  throw new Error('openclaw.plugin.json is not an object');
}
const skillsDirs: string[] = Array.isArray(manifestRaw.skills)
  ? manifestRaw.skills.filter((s): s is string => typeof s === 'string')
  : [];

function listSkillNames(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/** Read the YAML frontmatter block of a SKILL.md into key -> raw value. */
function readFrontmatter(skillMd: string): Map<string, string> {
  const lines = readFileSync(skillMd, 'utf-8').split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0] !== '---') {
    throw new Error(`no frontmatter block: ${skillMd}`);
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    throw new Error(`unterminated frontmatter block: ${skillMd}`);
  }
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return fields;
}

describe('manifest skills declaration', () => {
  it('declares exactly one skills root: the product-default language (zh)', () => {
    expect(skillsDirs).toEqual(['templates/langs/zh/skills']);
  });

  it('declared skill dirs are relative and stay inside the package root', () => {
    for (const dir of skillsDirs) {
      expect(isAbsolute(dir)).toBe(false);
      const abs = resolve(packageRoot, dir);
      expect(abs === packageRoot || abs.startsWith(packageRoot + sep)).toBe(true);
      expect(existsSync(abs), `declared skills dir missing: ${dir}`).toBe(true);
    }
  });

  it('across all declared roots, skill names are unique (no collision warnings)', () => {
    const seen = new Map<string, string>();
    for (const dir of skillsDirs) {
      const abs = resolve(packageRoot, dir);
      for (const name of listSkillNames(abs)) {
        const previous = seen.get(name);
        expect(
          previous,
          `skill "${name}" would collide between ${previous} and ${dir} — OpenClaw publishes by name (first wins), so declare only one language root`,
        ).toBeUndefined();
        seen.set(name, dir);
      }
    }
    // Positive assertion: the zh root publishes exactly the approved skill set
    expect([...seen.keys()].sort()).toEqual([...EXPECTED_SKILLS]);
  });

  it('ships BOTH language template roots with the identical approved skill set', () => {
    const zhRoot = resolve(packageRoot, 'templates', 'langs', 'zh', 'skills');
    const enRoot = resolve(packageRoot, 'templates', 'langs', 'en', 'skills');
    expect(existsSync(zhRoot), 'template root missing: templates/langs/zh/skills').toBe(true);
    expect(existsSync(enRoot), 'template root missing: templates/langs/en/skills').toBe(true);
    expect(listSkillNames(zhRoot)).toEqual([...EXPECTED_SKILLS]);
    expect(listSkillNames(enRoot)).toEqual([...EXPECTED_SKILLS]);
  });
});

describe('skill frontmatter contract (PRI-547)', () => {
  for (const lang of ['zh', 'en'] as const) {
    const root = resolve(packageRoot, 'templates', 'langs', lang, 'skills');

    it(`[${lang}] every shipped skill declares disable-model-invocation explicitly`, () => {
      for (const name of EXPECTED_SKILLS) {
        const fields = readFrontmatter(join(root, name, 'SKILL.md'));
        expect(
          fields.has('disable-model-invocation'),
          `${lang}/${name}: disable-model-invocation must be declared explicitly (no default-value reliance)`,
        ).toBe(true);
      }
    });

    it(`[${lang}] disable-model-invocation values match the approved boundary`, () => {
      for (const [name, expected] of Object.entries(EXPECTED_MODEL_INVOCATION_DISABLED)) {
        const fields = readFrontmatter(join(root, name, 'SKILL.md'));
        expect(
          fields.get('disable-model-invocation'),
          `${lang}/${name}: disable-model-invocation`,
        ).toBe(String(expected));
      }
    });

    it(`[${lang}] every shipped skill declares name matching its directory`, () => {
      for (const name of EXPECTED_SKILLS) {
        const fields = readFrontmatter(join(root, name, 'SKILL.md'));
        expect(fields.get('name')).toBe(name);
        expect(fields.has('description')).toBe(true);
      }
    });
  }
});
