/**
 * Install-time skill-language selection (PR #1332 follow-up, ERR-097).
 *
 * OpenClaw (verified on installed 2026.7.1-2) publishes plugin skills by
 * directory NAME: every immediate child of a declared `skills` root that
 * contains a SKILL.md is linked into ~/.openclaw/plugin-skills/<name>, the
 * first declaration wins, and later same-name roots only produce
 * "plugin skill name collision" warnings. There is no locale mechanism.
 *
 * Consequence: exactly ONE language root may be declared. The published
 * manifest declares the product default (zh); installs requested with
 * `--lang en` rewrite the INSTALLED manifest to the en root at
 * materialization time. The shipped package stays zh-only so any
 * materialization path that forgets to select degrades to the
 * collision-free default instead of regressing to 23 collision warnings.
 *
 * The same transform (detect + re-apply) is mirrored in
 * packages/pd-console/src/server/routes/update.ts so console updates
 * preserve the user's language choice; keep the two in sync.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export type SkillLanguage = 'zh' | 'en';

export const SKILL_LANGUAGE_ROOTS: Record<SkillLanguage, string> = {
  zh: 'templates/langs/zh/skills',
  en: 'templates/langs/en/skills',
};

export interface SkillLanguageResult {
  applied: boolean;
  /** rc-9: structured reason whenever selection did NOT apply. */
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLanguageSkillRoot(entry: unknown, language?: SkillLanguage): boolean {
  if (typeof entry !== 'string') return false;
  const normalized = entry.replaceAll('\\', '/');
  const languages: SkillLanguage[] = language ? [language] : ['zh', 'en'];
  return languages.some((lang) => normalized === SKILL_LANGUAGE_ROOTS[lang]);
}

/**
 * Detect the single declared language root.
 * Returns null when zero, both, or malformed entries are declared — callers
 * treat that as "no explicit selection" and fall back to the product default.
 */
export function detectSkillLanguage(manifestRaw: unknown): SkillLanguage | null {
  if (!isRecord(manifestRaw) || !Array.isArray(manifestRaw.skills)) return null;
  const languages = new Set<SkillLanguage>();
  for (const entry of manifestRaw.skills) {
    if (isLanguageSkillRoot(entry, 'zh')) languages.add('zh');
    else if (isLanguageSkillRoot(entry, 'en')) languages.add('en');
  }
  if (languages.size !== 1) return null;
  for (const language of languages) return language;
  return null;
}

/**
 * Pure manifest transform: strip every language skill root, then declare
 * exactly the selected language's root. Non-language entries (e.g. future
 * non-localized skill dirs) are preserved; non-string junk entries are
 * dropped (the host drops them anyway during normalization).
 * Returns null when the manifest has no skills array to select for.
 */
export function applySkillLanguageToManifest(
  manifestRaw: unknown,
  language: SkillLanguage,
): { manifest: Record<string, unknown>; changed: boolean } | null {
  if (!isRecord(manifestRaw) || !Array.isArray(manifestRaw.skills)) return null;
  const skills: unknown[] = manifestRaw.skills;
  const kept = skills.filter((entry): entry is string =>
    typeof entry === 'string' && !isLanguageSkillRoot(entry),
  );
  const next: string[] = [...kept, SKILL_LANGUAGE_ROOTS[language]];
  const unchanged =
    next.length === skills.length && next.every((entry, i) => entry === skills[i]);
  if (unchanged) return { manifest: manifestRaw, changed: false };
  return { manifest: { ...manifestRaw, skills: next }, changed: true };
}

/**
 * Apply language selection to the manifest inside an installed extension dir.
 * Never throws — this is a post-copy hardening step, and failing it must not
 * roll back an otherwise complete install. Every skip path returns a
 * structured note for the caller to surface (rc-9).
 */
export function applySkillLanguageSelection(extDir: string, language: SkillLanguage): SkillLanguageResult {
  const manifestPath = join(extDir, 'openclaw.plugin.json');
  if (!existsSync(manifestPath)) {
    return { applied: false, note: 'manifest_missing' };
  }
  const templateRoot = join(extDir, SKILL_LANGUAGE_ROOTS[language]);
  if (!existsSync(templateRoot)) {
    return { applied: false, note: `skill_templates_missing:${SKILL_LANGUAGE_ROOTS[language]}` };
  }
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return { applied: false, note: 'manifest_unparseable' };
  }
  const shaped = applySkillLanguageToManifest(manifestRaw, language);
  if (shaped === null) {
    return { applied: false, note: 'manifest_has_no_skills_array' };
  }
  if (shaped.changed) {
    writeFileSync(manifestPath, JSON.stringify(shaped.manifest, null, 2) + '\n', 'utf-8');
  }
  return { applied: true };
}
