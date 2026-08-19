/**
 * Core Principle Registry — T-01..T-10
 *
 * Canonical source of truth for the 10 built-in core principles.
 * The shipped THINKING_OS.md templates carry the same T-NN ids; the drift
 * test in openclaw-plugin validates template ↔ registry alignment.
 *
 * Bilingual: each principle has EN (name/statement) and
 * ZH (nameZh/statementZh) fields.
 *
 * See 02-review-response-and-amendments.md §2.1 for the three-way
 * naming collision resolution.
 */

import { Type } from '@sinclair/typebox';

// ── Core principle entry ──────────────────────────────────────────────────

export interface CorePrinciple {
  /** Canonical id — also the directive id in THINKING_OS.md templates (e.g. 'T-01') */
  id: string;
  /** Human-readable name (EN) */
  name: string;
  /** Human-readable name (ZH) — bilingual counterpart */
  nameZh: string;
  /** One-line axiom statement for prompt injection and routing (EN) */
  statement: string;
  /** One-line axiom statement (ZH) */
  statementZh: string;
}

export const CorePrincipleSchema = Type.Object({
  id: Type.String({ pattern: '^T-\\d{2}$' }),
  name: Type.String({ minLength: 1 }),
  nameZh: Type.String({ minLength: 1 }),
  statement: Type.String({ minLength: 1 }),
  statementZh: Type.String({ minLength: 1 }),
});

// ── Registry data ─────────────────────────────────────────────────────────

const CORE_PRINCIPLE_DATA: CorePrinciple[] = [
  {
    id: 'T-01',
    name: 'Survey Before Acting',
    nameZh: '先梳理再行动',
    statement: 'Understand the structure first before making changes.',
    statementZh: '在做出变更前，先理解其结构。',
  },
  {
    id: 'T-02',
    name: 'Respect Constraints',
    nameZh: '尊重约束',
    statement: 'Trust files, not your context window. Write conclusions to files.',
    statementZh: '信任文件而非上下文窗口，将结论写入文件。',
  },
  {
    id: 'T-03',
    name: 'Evidence Over Assumption',
    nameZh: '证据优先于假设',
    statement: 'Use logs, code, and outputs before inferring causes.',
    statementZh: '在推断原因之前，先使用日志、代码和输出作为证据。',
  },
  {
    id: 'T-04',
    name: 'Reversible First',
    nameZh: '可逆优先',
    statement: 'Prefer changes that are safe to roll back when risk is high.',
    statementZh: '在高风险时，优先选择可安全回滚的变更。',
  },
  {
    id: 'T-05',
    name: 'Safety Rails',
    nameZh: '安全护栏',
    statement: 'Call out guardrails, prohibitions, and failure-prevention constraints.',
    statementZh: '明确指出护栏、禁令和故障预防约束。',
  },
  {
    id: 'T-06',
    name: 'Simplicity First',
    nameZh: '简单优先',
    statement: 'Prefer the smallest understandable solution over over-engineering.',
    statementZh: '优先选择最小可理解的方案，而非过度设计。',
  },
  {
    id: 'T-07',
    name: 'Minimal Change Surface',
    nameZh: '最小变更面',
    statement: 'Limit the blast radius and touch only what is necessary.',
    statementZh: '限制爆炸半径，只触碰必要的部分。',
  },
  {
    id: 'T-08',
    name: 'Pain As Signal',
    nameZh: '痛苦即信号',
    statement: 'Treat failures and friction as clues to step back and rethink.',
    statementZh: '将失败和摩擦视为线索，退一步重新思考。',
  },
  {
    id: 'T-09',
    name: 'Divide And Conquer',
    nameZh: '分而治之',
    statement: 'Split the task into smaller phases before execution.',
    statementZh: '在执行前将任务拆分为更小的阶段。',
  },
  {
    id: 'T-10',
    name: 'Memory Externalization',
    nameZh: '记忆外部化',
    statement: 'Write intermediate conclusions to files for persistence.',
    statementZh: '将中间结论写入文件以实现持久化。',
  },
];

// ── Frozen public API ─────────────────────────────────────────────────────

/** Frozen array of all 10 core principles */
export const CORE_PRINCIPLES: readonly CorePrinciple[] = Object.freeze(
  CORE_PRINCIPLE_DATA.map(p => Object.freeze({ ...p }))
);

/** Frozen array of all core principle ids */
export const CORE_PRINCIPLE_IDS: readonly string[] = Object.freeze(
  CORE_PRINCIPLE_DATA.map(p => p.id)
);

/** Type guard: returns true if the value is a known core principle id */
export function isCorePrincipleId(value: string): value is typeof CORE_PRINCIPLE_IDS[number] {
  if (typeof value !== 'string') return false;
  return CORE_PRINCIPLE_IDS.includes(value);
}

/** Lookup a core principle by id; returns undefined if not found */
export function getCorePrinciple(id: string): CorePrinciple | undefined {
  if (typeof id !== 'string') return undefined;
  return CORE_PRINCIPLES.find(p => p.id === id);
}
