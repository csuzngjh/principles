/**
 * Plugin manifest skill-declaration invariants.
 *
 * OpenClaw's plugin skill loader resolves every directory listed in
 * openclaw.plugin.json `skills` (relative to the plugin root) and publishes
 * each immediate child containing SKILL.md, keyed by the child's NAME —
 * the first declaration wins; later same-name directories only produce a
 * "plugin skill name collision" warning and are silently dropped. There is
 * NO locale/i18n mechanism for plugin skills.
 *
 * Declaring both templates/langs/{en,zh}/skills therefore (a) emitted 23
 * collision warnings on every gateway start and (b) silently pinned every
 * published skill to the language listed first (en), even though PD's
 * product default language is zh.
 *
 * Contract: exactly ONE skills root is declared — the product-default
 * language (zh). The en templates stay in the package as translations; they
 * are simply not declared for publication.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { isAbsolute, join, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

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
      const entries = existsSync(abs) ? readdirSync(abs, { withFileTypes: true }) : [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!existsSync(join(abs, entry.name, 'SKILL.md'))) continue;
        const previous = seen.get(entry.name);
        expect(
          previous,
          `skill "${entry.name}" would collide between ${previous} and ${dir} — OpenClaw publishes by name (first wins), so declare only one language root`,
        ).toBeUndefined();
        seen.set(entry.name, dir);
      }
    }
    // Positive assertion: the zh root actually publishes the skill set
    expect(seen.size).toBeGreaterThanOrEqual(20);
  });
});
