/**
 * PD 内置技能的全局清单（唯一事实源）。
 *
 * 该清单回答两个问题，且只回答这两个问题：
 *   - 哪些技能存在（`status`）：active 必须在每个宿主各交付一份，retired 不得出现在任何宿主；
 *   - 哪些技能不允许退场（`retirable`）：false 表示永远不得改成 retired。
 *
 * 宿主路径、命令、能力差异都**不在**这里声明 —— 那些属于 `hosts/<id>.json`（见设计 §4.2）。
 * 校验采用 fail-loud：不完整或互相矛盾的清单必须显式报错，不允许静默跳过（rc-3 / rc-9）。
 */

export type SkillStatus = 'active' | 'retired';

export interface SkillCatalogEntry {
  readonly name: string;
  readonly status: SkillStatus;
  readonly retirable: boolean;
  /**
   * 条件退场闸门（设计 §2.5）。非空字符串表示：条件未满足前该技能不得改为 retired。
   * 这是 Owner 要求的书面约束，不是口头约定；解析时保留，禁止静默丢弃。
   */
  readonly retirementCondition?: string;
}

export interface SkillCatalog {
  readonly skills: readonly SkillCatalogEntry[];
}

/** 清单自身的结构性错误（区别于"文件不存在"这类 I/O 错误）。 */
export class SkillCatalogError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid skill catalog: ${problems.join('; ')}`);
    this.name = 'SkillCatalogError';
  }
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUSES = ['active', 'retired'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSkillStatus(value: unknown): value is SkillStatus {
  return value === 'active' || value === 'retired';
}

/**
 * 把外部数据（JSON.parse 结果、测试夹具、未来渲染器的输入）校验成清单。
 * 未知值一律先当作 unknown，不使用 `as` 绕过校验（rc-1 / rc-2）。
 */
export function parseSkillCatalog(value: unknown): SkillCatalog {
  if (!isRecord(value)) throw new SkillCatalogError(['root must be an object']);
  const rawSkills = value.skills;
  if (!Array.isArray(rawSkills)) throw new SkillCatalogError(['`skills` must be an array']);
  if (rawSkills.length === 0) throw new SkillCatalogError(['`skills` must not be empty']);

  const problems: string[] = [];
  const entries: SkillCatalogEntry[] = [];
  const seen = new Set<string>();

  rawSkills.forEach((raw, index) => {
    const at = `skills[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const { name, status, retirable, retirementCondition } = raw;
    if (typeof name !== 'string' || !SKILL_NAME.test(name)) {
      problems.push(`${at}.name must be a kebab-case skill name`);
      return;
    }
    if (!isSkillStatus(status)) {
      problems.push(`${at}.status must be one of ${STATUSES.join('|')}`);
    }
    if (typeof retirable !== 'boolean') {
      problems.push(`${at}.retirable must be a boolean`);
    }
    if (
      retirementCondition !== undefined &&
      (typeof retirementCondition !== 'string' || retirementCondition.trim() === '')
    ) {
      problems.push(`${at}.retirementCondition must be a non-empty string when present`);
    }
    if (seen.has(name)) {
      problems.push(`${at}.name duplicates "${name}"`);
    }
    seen.add(name);
    if (!isSkillStatus(status) || typeof retirable !== 'boolean') return;
    if (status === 'retired' && retirable === false) {
      problems.push(`${name} is marked retirable=false but status=retired`);
      return;
    }
    entries.push({
      name,
      status,
      retirable,
      ...(typeof retirementCondition === 'string' ? { retirementCondition } : {}),
    });
  });

  if (problems.length > 0) throw new SkillCatalogError(problems);
  return { skills: entries };
}
