/**
 * 跨宿主技能交付一致性判定（纯逻辑，不做文件 I/O）。
 *
 * 判定口径全部来自全局清单（`skill-catalog.json`），调用方只负责把每个宿主
 * 实际交付的技能目录读成 `DeliveredHost`。这样测试、迁移脚本与未来的渲染器
 * 校验共用同一条规则，而不是各写一份"四个目录"的比较。
 *
 * 该规则**只**回答"发了几份、声明是否一致"，不回答"内容是否同源"——
 * 后者属于渲染 `--check` 的职责（设计 §7.3）。
 */
import type { SkillCatalog } from './skill-catalog.js';

export interface DeliveredHost {
  /** 交付面标识，例如 `openclaw-zh` / `codex` / `workbuddy`。 */
  readonly id: string;
  /** 该宿主实际交付的技能目录名。 */
  readonly skills: readonly string[];
  /** 其中 `SKILL.md` 缺失或为空的技能名。 */
  readonly emptySkills: readonly string[];
}

/** 返回全部偏差；空数组表示一致。 */
export function checkSkillParity(
  catalog: SkillCatalog,
  hosts: readonly DeliveredHost[],
): readonly string[] {
  const problems: string[] = [];
  const declared = new Set(catalog.skills.map((skill) => skill.name));

  for (const { name, status, retirable } of catalog.skills) {
    const hits = hosts.filter((host) => host.skills.includes(name)).map((host) => host.id);
    const expected = status === 'active' ? hosts.length : 0;
    if (hits.length !== expected) {
      problems.push(
        `${name} (${status}): expected ${expected} host(s), found ${hits.length} [${hits.join(', ') || 'none'}]`,
      );
    }
    if (!retirable && status !== 'active') {
      problems.push(`${name}: retirable=false but status=${status}`);
    }
    if (status !== 'active') continue;
    for (const host of hosts) {
      if (host.emptySkills.includes(name)) {
        problems.push(`${name} (${host.id}): SKILL.md is missing or empty`);
      }
    }
  }

  for (const host of hosts) {
    for (const name of host.skills) {
      if (!declared.has(name)) {
        problems.push(`${name} (${host.id}): delivered but not declared in skill-catalog.json`);
      }
    }
  }

  return problems;
}
