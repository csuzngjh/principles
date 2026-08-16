/**
 * Install-time skill-language selection (PR #1332 companion).
 *
 * OpenClaw publishes plugin skills by directory name (first declaration
 * wins, no locale mechanism), so exactly ONE language root may be declared.
 * The shipped manifest declares zh (product default); `--lang en` installs
 * must rewrite the INSTALLED manifest to the en root — verified here at
 * both the pure-transform level and the real installPluginToStaging path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applySkillLanguageToManifest,
  applySkillLanguageSelection,
  detectSkillLanguage,
} from '../src/skill-language.js';
import { installPluginToStaging } from '../src/installer.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readManifestSkills(dir: string): string[] {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'openclaw.plugin.json'), 'utf-8'));
  if (!isRecord(raw) || !Array.isArray(raw.skills)) {
    throw new Error(`test fixture manifest malformed under ${dir}`);
  }
  return raw.skills.filter((s): s is string => typeof s === 'string');
}

describe('applySkillLanguageToManifest (pure transform)', () => {
  const zhOnly = { id: 'principles-disciple', skills: ['templates/langs/zh/skills'] };

  it('keeps a zh-default manifest unchanged (default install path is a no-op)', () => {
    const result = applySkillLanguageToManifest(zhOnly, 'zh');
    expect(result?.changed).toBe(false);
    expect(result?.manifest.skills).toEqual(['templates/langs/zh/skills']);
  });

  it('rewrites the manifest to the en root for --lang en', () => {
    const result = applySkillLanguageToManifest(zhOnly, 'en');
    expect(result?.changed).toBe(true);
    expect(result?.manifest.skills).toEqual(['templates/langs/en/skills']);
  });

  it('collapses a legacy dual-root declaration to exactly the selected root', () => {
    const legacy = { id: 'pd', skills: ['templates/langs/en/skills', 'templates/langs/zh/skills'] };
    expect(applySkillLanguageToManifest(legacy, 'zh')?.manifest.skills)
      .toEqual(['templates/langs/zh/skills']);
  });

  it('preserves non-language skill roots and drops junk entries', () => {
    const manifest = { id: 'pd', skills: ['templates/langs/zh/skills', 'custom/skills', 42] };
    expect(applySkillLanguageToManifest(manifest, 'en')?.manifest.skills)
      .toEqual(['custom/skills', 'templates/langs/en/skills']);
  });

  it('accepts backslash-separated roots (Windows-authored manifests)', () => {
    const manifest = { id: 'pd', skills: ['templates\\langs\\zh\\skills'] };
    expect(applySkillLanguageToManifest(manifest, 'en')?.manifest.skills)
      .toEqual(['templates/langs/en/skills']);
  });

  it('returns null for manifests without a skills array', () => {
    expect(applySkillLanguageToManifest({ id: 'pd' }, 'en')).toBeNull();
    expect(applySkillLanguageToManifest('not-a-manifest', 'en')).toBeNull();
    expect(applySkillLanguageToManifest(null, 'en')).toBeNull();
  });
});

describe('detectSkillLanguage', () => {
  it('detects a single declared language root', () => {
    expect(detectSkillLanguage({ skills: ['templates/langs/zh/skills'] })).toBe('zh');
    expect(detectSkillLanguage({ skills: ['templates/langs/en/skills'] })).toBe('en');
  });

  it('returns null for dual-root legacy manifests, no roots, or malformed input', () => {
    expect(detectSkillLanguage({ skills: ['templates/langs/en/skills', 'templates/langs/zh/skills'] })).toBeNull();
    expect(detectSkillLanguage({ skills: ['custom/skills'] })).toBeNull();
    expect(detectSkillLanguage({})).toBeNull();
    expect(detectSkillLanguage(null)).toBeNull();
  });
});

describe('applySkillLanguageSelection (fs-level)', () => {
  let extDir: string;

  beforeEach(() => {
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-skill-lang-'));
    for (const lang of ['zh', 'en']) {
      const skillDir = path.join(extDir, 'templates', 'langs', lang, 'skills', 'admin');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${lang}`);
    }
    fs.writeFileSync(
      path.join(extDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'pd', skills: ['templates/langs/zh/skills'] }, null, 2),
    );
  });

  afterEach(() => {
    fs.rmSync(extDir, { recursive: true, force: true });
  });

  it('rewrites the installed manifest for en', () => {
    const result = applySkillLanguageSelection(extDir, 'en');
    expect(result.applied).toBe(true);
    expect(readManifestSkills(extDir)).toEqual(['templates/langs/en/skills']);
  });

  it('is a no-op for the zh default', () => {
    const result = applySkillLanguageSelection(extDir, 'zh');
    expect(result.applied).toBe(true);
    expect(readManifestSkills(extDir)).toEqual(['templates/langs/zh/skills']);
  });

  it('degrades with a structured note when the requested templates are missing', () => {
    fs.rmSync(path.join(extDir, 'templates', 'langs', 'en'), { recursive: true, force: true });
    const result = applySkillLanguageSelection(extDir, 'en');
    expect(result.applied).toBe(false);
    expect(result.note).toBe('skill_templates_missing:templates/langs/en/skills');
    expect(readManifestSkills(extDir)).toEqual(['templates/langs/zh/skills']);
  });

  it('degrades with a structured note when the manifest is missing', () => {
    fs.rmSync(path.join(extDir, 'openclaw.plugin.json'));
    const result = applySkillLanguageSelection(extDir, 'zh');
    expect(result.applied).toBe(false);
    expect(result.note).toBe('manifest_missing');
  });

  it('degrades with a structured note when the manifest is unparseable', () => {
    fs.writeFileSync(path.join(extDir, 'openclaw.plugin.json'), '{not json');
    const result = applySkillLanguageSelection(extDir, 'en');
    expect(result.applied).toBe(false);
    expect(result.note).toBe('manifest_unparseable');
  });
});

describe('installPluginToStaging applies skill-language selection (production path)', () => {
  let tmpHome: string;
  let pluginDir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-skill-home-'));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows — override
    // both so getPluginExtDir() resolves inside the sandbox on every platform.
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-skill-plugin-'));
    const plugin = path.join(pluginDir, 'plugin');
    for (const lang of ['zh', 'en']) {
      const skillDir = path.join(plugin, 'templates', 'langs', lang, 'skills', 'admin');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${lang}`);
    }
    fs.mkdirSync(path.join(plugin, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'dist', 'bundle.js'), '// bundle');
    fs.writeFileSync(
      path.join(plugin, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'principles-disciple', skills: ['templates/langs/zh/skills'] }, null, 2),
    );
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  function readInstalledManifestSkills(): string[] {
    return readManifestSkills(
      path.join(tmpHome, '.openclaw', 'extensions', 'principles-disciple'),
    );
  }

  it('--lang en rewrites the installed manifest to the en skills root', async () => {
    await installPluginToStaging(pluginDir, 'en');
    expect(readInstalledManifestSkills()).toEqual(['templates/langs/en/skills']);
  });

  it('default zh leaves the shipped manifest untouched', async () => {
    await installPluginToStaging(pluginDir, 'zh');
    expect(readInstalledManifestSkills()).toEqual(['templates/langs/zh/skills']);
  });
});
