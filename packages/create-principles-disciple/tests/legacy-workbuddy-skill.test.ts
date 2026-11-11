import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_WORKBUDDY_SKILL_DIR,
  PUBLISHED_LEGACY_WORKBUDDY_SKILLS,
  deprecateLegacyWorkbuddySkill,
  inspectLegacyWorkbuddySkill,
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
