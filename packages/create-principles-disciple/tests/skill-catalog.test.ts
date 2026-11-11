/**
 * 全局技能清单的结构校验。
 *
 * 清单是"哪些技能存在、哪些不许退场"的唯一事实源（设计 §7.2.1）。
 * 这里只守清单**自身**的一致性；"清单与四个宿主目录是否一致"由
 * `cross-host-skill-parity.test.ts` 守，不要在这里重复。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseSkillCatalog, SkillCatalogError } from '../src/skill-catalog.js';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const CATALOG_PATH = path.join(PACKAGE_ROOT, 'skill-catalog.json');

function readCatalog(): unknown {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
}

function problemsOf(value: unknown): readonly string[] {
  try {
    parseSkillCatalog(value);
  } catch (error) {
    expect(error).toBeInstanceOf(SkillCatalogError);
    return (error as SkillCatalogError).problems;
  }
  throw new Error('expected parseSkillCatalog to reject the input');
}

describe('shipped skill catalog', () => {
  it('parses', () => {
    const catalog = parseSkillCatalog(readCatalog());
    expect(catalog.skills.length).toBeGreaterThan(0);
  });

  it('declares every skill exactly once', () => {
    const catalog = parseSkillCatalog(readCatalog());
    const names = catalog.skills.map((skill) => skill.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps at least one skill that may never be retired', () => {
    // H2 的载体：CLI 知情技能必须不可退场。此处不写具体技能名，
    // 否则清单就不再是唯一事实源。
    const catalog = parseSkillCatalog(readCatalog());
    expect(catalog.skills.some((skill) => skill.retirable === false)).toBe(true);
  });
});

describe('parseSkillCatalog rejects malformed catalogs', () => {
  it('rejects a non-object root', () => {
    expect(problemsOf([]).length).toBeGreaterThan(0);
    expect(problemsOf(null).length).toBeGreaterThan(0);
  });

  it('rejects a missing or empty skills array', () => {
    expect(problemsOf({})).toContain('`skills` must be an array');
    expect(problemsOf({ skills: [] })).toContain('`skills` must not be empty');
  });

  it('rejects an entry with an unusable name', () => {
    const problems = problemsOf({ skills: [{ name: 'PD Control', status: 'active', retirable: true }] });
    expect(problems).toContain('skills[0].name must be a kebab-case skill name');
  });

  it('rejects an unknown status', () => {
    const problems = problemsOf({ skills: [{ name: 'pd-x', status: 'paused', retirable: true }] });
    expect(problems).toContain('skills[0].status must be one of active|retired');
  });

  it('rejects a non-boolean retirable flag', () => {
    const problems = problemsOf({ skills: [{ name: 'pd-x', status: 'active', retirable: 'yes' }] });
    expect(problems).toContain('skills[0].retirable must be a boolean');
  });

  it('rejects duplicate names', () => {
    const problems = problemsOf({
      skills: [
        { name: 'pd-x', status: 'active', retirable: true },
        { name: 'pd-x', status: 'active', retirable: true },
      ],
    });
    expect(problems).toContain('skills[1].name duplicates "pd-x"');
  });

  it('rejects retiring a skill marked retirable=false', () => {
    const problems = problemsOf({ skills: [{ name: 'pd-cli-operator', status: 'retired', retirable: false }] });
    expect(problems).toContain('pd-cli-operator is marked retirable=false but status=retired');
  });

  it('reports every problem at once instead of the first one', () => {
    const problems = problemsOf({
      skills: [
        { name: 'Bad Name', status: 'active', retirable: true },
        { name: 'pd-y', status: 'paused', retirable: 1 },
      ],
    });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});
