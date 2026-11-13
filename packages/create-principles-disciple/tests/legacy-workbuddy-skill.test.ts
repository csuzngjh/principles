import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_WORKBUDDY_SKILL_DIR,
  LEGACY_WORKBUDDY_SKILL_ENTRIES,
  PUBLISHED_LEGACY_WORKBUDDY_SKILLS,
  deprecateAllLegacyWorkbuddySkills,
  deprecateLegacyWorkbuddySkill,
  inspectLegacyWorkbuddySkill,
  type LegacyWorkbuddySkillEntry,
  type PublishedLegacyWorkbuddySkill,
} from '../src/installers/legacy-workbuddy-skill.js';
import { formatHostStateSummary } from '../src/install-summary.js';

const directories: string[] = [];

function temporaryConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-legacy-skill-'));
  directories.push(dir);
  return dir;
}

function writeSkill(configDir: string, content: string): string {
  const dir = path.join(configDir, 'skills', LEGACY_WORKBUDDY_SKILL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, content);
  return file;
}

function writeSkillIn(configDir: string, dirName: string, content: string): string {
  const dir = path.join(configDir, 'skills', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, content);
  return file;
}

function publishedFor(content: string): readonly PublishedLegacyWorkbuddySkill[] {
  return [
    {
      label: '9.9.9-fixture',
      sha256: createHash('sha256').update(Buffer.from(content)).digest('hex'),
      provenance: 'test fixture',
    },
  ];
}

const PUBLISHED_PAYLOAD = ['---', 'name: pd-record-pain', 'description: legacy fixture', '---', '', 'body', ''].join('\n');

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('legacy WorkBuddy skill retirement (§5.5 / TD §7.4)', () => {
  it('reports absent when no legacy skill is installed', () => {
    const configDir = temporaryConfigDir();
    const state = inspectLegacyWorkbuddySkill({ configDir });
    expect(state.status).toBe('absent');
    expect(deprecateLegacyWorkbuddySkill({ configDir }).warnings).toEqual([]);
  });

  it('renames a provably unmodified published payload, keeping the bytes', () => {
    const configDir = temporaryConfigDir();
    const file = writeSkill(configDir, PUBLISHED_PAYLOAD);
    const outcome = deprecateLegacyWorkbuddySkill({ configDir, published: publishedFor(PUBLISHED_PAYLOAD) });

    expect(outcome.state.status).toBe('deprecated');
    const retired = `${file}.deprecated-9.9.9-fixture`;
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(retired, 'utf8')).toBe(PUBLISHED_PAYLOAD);
    expect(outcome.warnings[0]).toContain('Retired the obsolete user-level skill');
  });

  it('never overwrites or deletes a copy that matches no published version', () => {
    const configDir = temporaryConfigDir();
    const customised = `${PUBLISHED_PAYLOAD}owner edit\n`;
    const file = writeSkill(configDir, customised);
    const outcome = deprecateLegacyWorkbuddySkill({ configDir, published: publishedFor(PUBLISHED_PAYLOAD) });

    expect(outcome.state.status).toBe('modified');
    expect(fs.readFileSync(file, 'utf8')).toBe(customised);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['SKILL.md']);
    expect(outcome.warnings.join('\n')).toContain('deprecated_skill_modified');
  });

  it('is idempotent once the retired file exists', () => {
    const configDir = temporaryConfigDir();
    const file = writeSkill(configDir, PUBLISHED_PAYLOAD);
    const first = deprecateLegacyWorkbuddySkill({ configDir, published: publishedFor(PUBLISHED_PAYLOAD) });
    expect(first.state.status).toBe('deprecated');

    const second = deprecateLegacyWorkbuddySkill({ configDir, published: publishedFor(PUBLISHED_PAYLOAD) });
    expect(second.state.status).toBe('already_deprecated');
    expect(second.warnings).toEqual([]);
    expect(fs.readFileSync(`${file}.deprecated-9.9.9-fixture`, 'utf8')).toBe(PUBLISHED_PAYLOAD);
  });

  it('never touches a same-named directory that declares a different skill', () => {
    const configDir = temporaryConfigDir();
    const own = '---\nname: my-own-skill\n---\n\nmine\n';
    const file = writeSkill(configDir, own);
    const outcome = deprecateLegacyWorkbuddySkill({ configDir, published: publishedFor(PUBLISHED_PAYLOAD) });

    expect(outcome.state.status).toBe('absent');
    expect(outcome.warnings).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(own);
  });

  it('ships a registry whose hashes are 64 hex characters', () => {
    // The registry is the proof that a copy is unmodified; a malformed entry
    // would silently downgrade every install to "modified".
    expect(PUBLISHED_LEGACY_WORKBUDDY_SKILLS.length).toBeGreaterThan(0);
    for (const entry of PUBLISHED_LEGACY_WORKBUDDY_SKILLS) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.provenance.length).toBeGreaterThan(0);
    }
  });

  it('surfaces install warnings in the summary screen (rc-9)', () => {
    const lines = formatHostStateSummary([
      {
        success: true,
        hostId: 'workbuddy',
        warnings: ['WARNING: retired skill "pd-record-pain" was found but NOT modified'],
      },
    ], true);
    expect(lines.join('\n')).toContain('NOT modified');
  });
});

describe('retired skill registry coverage (5c383e572)', () => {
  it('registers every user-level skill retired before unification', () => {
    expect(LEGACY_WORKBUDDY_SKILL_ENTRIES.map((entry) => entry.dir)).toEqual([
      'pd-record-pain',
      'pd-status',
      'pd-setup',
      'pd-disable',
      'pd-review',
    ]);
    for (const entry of LEGACY_WORKBUDDY_SKILL_ENTRIES) {
      expect(entry.published.length).toBeGreaterThan(0);
      for (const payload of entry.published) {
        expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(payload.label.length).toBeGreaterThan(0);
        expect(payload.provenance.length).toBeGreaterThan(0);
      }
    }
  });

  it('recognises the exact blobs left behind on upgraded machines', () => {
    // Byte-identical copies recovered from ~/.workbuddy/skills/ on a machine
    // upgraded across 5c383e572. Each must resolve to a published payload of
    // its own skill, otherwise retirement degrades to "modified" and stale
    // Codex-era skills keep competing with the plugin's current four.
    const observed: readonly (readonly [string, string])[] = [
      ['pd-status', '853d5f8de9996239dbfc4d1fca27f5e96cd852cf1b8deea0c1cb8d1655800126'],
      ['pd-setup', '8d6eae4df8b311c37e86788bc5487a5b692970573334f5b890ee6fd452f20502'],
      ['pd-disable', '590769fcf93d60389346e001ce8a76c2157976f5d38035523f3807ffc2477f8e'],
      ['pd-review', '18665f1a8e0d5a34ab245859cc34f08c56c8946648274e870e95d1642e331b74'],
    ];
    for (const [dir, sha256] of observed) {
      const entry = LEGACY_WORKBUDDY_SKILL_ENTRIES.find((candidate) => candidate.dir === dir);
      expect(entry?.published.some((payload) => payload.sha256 === sha256)).toBe(true);
    }
  });

  it('never registers post-unification, still-shipped pd-review payloads', () => {
    const stillShipped = [
      '1fa09ba4e40aba7448e869a0712fdaf104ab352621d42293d6c4aaf8a26f6eec', // 5c383e57
      '829a9b25e5ab3103b4bcb138cda01bd58e1c45dbf73c1f70b31fb00277008198', // 5c383e57
      '10691f5aa5464021e9127d0942e6f2aea9b8eaafd0b8c3c0b89a67f185b74e86', // 7ccb93b1
      '8aa8d54c4ee87d141559c07a48530c66500e7035314dd6535d91365e074bbb23', // 7ccb93b1
    ];
    const review = LEGACY_WORKBUDDY_SKILL_ENTRIES.find((entry) => entry.dir === 'pd-review');
    for (const sha256 of stillShipped) {
      expect(review?.published.some((payload) => payload.sha256 === sha256)).toBe(false);
    }
  });
});

describe('deprecateAllLegacyWorkbuddySkills (one install pass)', () => {
  const alpha = ['---', 'name: alpha', '---', '', 'alpha body', ''].join('\n');
  const beta = ['---', 'name: beta', '---', '', 'beta body', ''].join('\n');

  it('retires every registered skill, not just the first one', () => {
    const configDir = temporaryConfigDir();
    const alphaFile = writeSkillIn(configDir, 'alpha', alpha);
    const betaFile = writeSkillIn(configDir, 'beta', beta);
    const entries: readonly LegacyWorkbuddySkillEntry[] = [
      { dir: 'alpha', published: publishedFor(alpha) },
      { dir: 'beta', published: publishedFor(beta) },
    ];

    const outcome = deprecateAllLegacyWorkbuddySkills({ configDir, entries });

    expect(outcome.outcomes.map((item) => item.state.status)).toEqual(['deprecated', 'deprecated']);
    expect(fs.existsSync(alphaFile)).toBe(false);
    expect(fs.existsSync(betaFile)).toBe(false);
    expect(fs.readFileSync(`${alphaFile}.deprecated-9.9.9-fixture`, 'utf8')).toBe(alpha);
    expect(fs.readFileSync(`${betaFile}.deprecated-9.9.9-fixture`, 'utf8')).toBe(beta);
    expect(outcome.warnings).toHaveLength(2);
  });

  it('keeps an Owner-modified copy but still retires the other skills', () => {
    const configDir = temporaryConfigDir();
    const alphaFile = writeSkillIn(configDir, 'alpha', `${alpha}owner edit\n`);
    const betaFile = writeSkillIn(configDir, 'beta', beta);
    const entries: readonly LegacyWorkbuddySkillEntry[] = [
      { dir: 'alpha', published: publishedFor(alpha) },
      { dir: 'beta', published: publishedFor(beta) },
    ];

    const outcome = deprecateAllLegacyWorkbuddySkills({ configDir, entries });

    expect(outcome.outcomes.map((item) => item.state.status)).toEqual(['modified', 'deprecated']);
    expect(fs.readFileSync(alphaFile, 'utf8')).toBe(`${alpha}owner edit\n`);
    expect(fs.existsSync(betaFile)).toBe(false);
    expect(outcome.warnings.join('\n')).toContain('deprecated_skill_modified');
    expect(outcome.warnings.join('\n')).toContain('Retired the obsolete user-level skill "beta"');
  });

  it('is idempotent across repeated upgrade passes', () => {
    const configDir = temporaryConfigDir();
    const entries: readonly LegacyWorkbuddySkillEntry[] = [
      { dir: 'alpha', published: publishedFor(alpha) },
    ];
    writeSkillIn(configDir, 'alpha', alpha);

    expect(deprecateAllLegacyWorkbuddySkills({ configDir, entries }).outcomes[0]?.state.status).toBe('deprecated');
    const second = deprecateAllLegacyWorkbuddySkills({ configDir, entries });
    expect(second.outcomes[0]?.state.status).toBe('already_deprecated');
    expect(second.warnings).toEqual([]);
  });
});
