/**
 * PRI-754 — AI User QA Scenario 定义与加载。
 *
 * Scenario 是简单 YAML（非 DSL）：persona / goal / success / observe。
 * 解析结果视为不可信输入（rc-1）：逐字段守卫校验，缺失必填字段 fail-loud
 * （rc-3），数组元素逐个校验（rc-4），不用 `as` 替代运行时校验（rc-2）。
 */
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';

export interface AiUserScenario {
  id: string;
  persona: string;
  goal: string;
  /** 成功标准：全部作为验收依据交给 AI User 逐条对照。 */
  success: string[];
  /** 观察点：提示 AI User 重点记录的体验问题。 */
  observe: string[];
  maxSteps: number;
  startUrl: string;
}

export const DEFAULT_MAX_STEPS = 10;
export const MAX_STEPS_CEILING = 50;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function requireNonEmptyString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (!isNonEmptyString(value)) {
    throw new Error(`scenario 字段 "${field}" 必须是非空字符串（rc-3 fail-loud）`);
  }
  return value;
}

function requireStringArray(
  record: Record<string, unknown>,
  field: string,
  opts: { required: boolean },
): string[] {
  const value = record[field];
  if (value === undefined) {
    if (opts.required) throw new Error(`scenario 字段 "${field}" 缺失（rc-3 fail-loud）`);
    return [];
  }
  if (!isNonEmptyStringArray(value)) {
    throw new Error(`scenario 字段 "${field}" 的每个元素都必须是非空字符串（rc-4 validate-array-elements）`);
  }
  if (opts.required && value.length === 0) {
    throw new Error(`scenario 字段 "${field}" 不能是空数组（rc-3 fail-loud）`);
  }
  return [...value];
}

function parseMaxSteps(record: Record<string, unknown>): number {
  const value = record['maxSteps'];
  if (value === undefined) return DEFAULT_MAX_STEPS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_STEPS_CEILING) {
    throw new Error(`scenario 字段 "maxSteps" 必须是 1-${MAX_STEPS_CEILING} 的整数`);
  }
  return value;
}

export function parseScenario(raw: unknown): AiUserScenario {
  const record = asRecord(raw);
  if (record === null) {
    throw new Error('scenario 根节点必须是 YAML mapping（rc-3 fail-loud）');
  }
  return {
    id: requireNonEmptyString(record, 'id'),
    persona: requireNonEmptyString(record, 'persona'),
    goal: requireNonEmptyString(record, 'goal'),
    success: requireStringArray(record, 'success', { required: true }),
    observe: requireStringArray(record, 'observe', { required: false }),
    maxSteps: parseMaxSteps(record),
    startUrl: record['startUrl'] === undefined ? '/' : requireNonEmptyString(record, 'startUrl'),
  };
}

export function loadScenario(filePath: string): AiUserScenario {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`无法读取 scenario 文件: ${filePath} — ${msg}`);
  }
  return parseScenario(yaml.load(text));
}
