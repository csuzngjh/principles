/**
 * 跨宿主技能交付一致性（AC-1 / AC-2 / AC-3）。
 *
 * 期望集合 100% 来自 `skill-catalog.json`：这里不出现任何技能名字面量，
 * 也不出现宿主数量的字面量。因此退场时只需把清单里的 `status` 改成
 * `retired`，同一条断言会自动从"每个宿主都必须有"收紧为"任何宿主都不许有"。
 *
 * 局限（不要误读为同源校验）：本文件只比对"发了几份、名称是否在清单内"，
 * 抓不住"数量对但内容漂了"。内容同源由渲染器的 `--check` 负责。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseSkillCatalog } from '../src/skill-catalog.js';
import { checkSkillParity, type DeliveredHost } from '../src/skill-delivery-parity.js';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const CATALOG_PATH = path.join(PACKAGE_ROOT, 'skill-catalog.json');

/**
 * 技能交付面：宿主 -> 该宿主的技能根目录。这是"PD 在哪里发技能"的基础设施，
 * 不是技能清单；技能集合只允许来自 catalog。
 */
const DELIVERY_HOSTS: ReadonlyArray<{ id: string; root: string }> = [
  { id: 'openclaw-zh', root: path.join(REPO_ROOT, 'packages/openclaw-plugin/templates/langs/zh/skills') },
  { id: 'openclaw-en', root: path.join(REPO_ROOT, 'packages/openclaw-plugin/templates/langs/en/skills') },
  { id: 'codex', root: path.join(REPO_ROOT, 'plugins/principles-disciple/skills') },
  { id: 'workbuddy', root: path.join(REPO_ROOT, 'packages/workbuddy-adapter/plugin/skills') },
];

function readDeliveredHost(host: { id: string; root: string }): DeliveredHost {
  const skills = existsSync(host.root)
    ? readdirSync(host.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  const emptySkills = skills.filter((name) => {
    const file = path.join(host.root, name, 'SKILL.md');
    return !existsSync(file) || statSync(file).size === 0;
  });
  return { id: host.id, skills, emptySkills };
}

function readCatalog() {
  // 读真实清单，不用手写夹具：夹具会让"清单改了但测试没改"这类漂移不可见。
  return parseSkillCatalog(JSON.parse(readFileSync(CATALOG_PATH, 'utf8')));
}

describe('cross-host skill parity', () => {
  it('delivers exactly the catalog-declared skill set to every host', () => {
    expect(checkSkillParity(readCatalog(), DELIVERY_HOSTS.map(readDeliveredHost))).toEqual([]);
  });

  it('keeps every retirable=false skill active', () => {
    const frozen = readCatalog().skills.filter((skill) => skill.retirable === false);
    expect(frozen.length).toBeGreaterThan(0);
    expect(frozen.every((skill) => skill.status === 'active')).toBe(true);
  });
});
