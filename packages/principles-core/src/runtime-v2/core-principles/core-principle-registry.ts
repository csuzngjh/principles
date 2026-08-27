/**
 * Core Principle Registry — T-01..T-11
 *
 * Canonical source of truth for the built-in core principles.
 * The shipped THINKING_OS.md templates carry the same T-NN ids; the drift
 * test in openclaw-plugin validates template ↔ registry alignment
 * (id + name + canonical statement anchor).
 *
 * ## Layer model (PRI-606/PRI-607 correction)
 *
 * The active set is 10 principles in two layers:
 * - 6 Foundational Axioms (`layer: 'foundational'`) — high-abstraction,
 *   tool-agnostic, generative decision rules. Injected via
 *   `<core_principles>`.
 * - 4 Operating Principles (`layer: 'operating'`) — how an agent puts the
 *   axioms into practice. Surfaced via THINKING_OS directives.
 *
 * ## T-07 compatibility migration
 *
 * T-07 (Minimal Change Surface) historically duplicated T-06's semantic
 * (solution simplicity + change surface). Its meaning is absorbed by
 * T-06 (Minimal Sufficient Change). T-07 ids persist in workspace training
 * state, ledger trees, and pi_artifacts `groundedOnCorePrincipleIds`, so the
 * id is NOT reused: it stays resolvable (`isCorePrincipleId('T-07')` → true)
 * but is `status: 'deprecated'` and excluded from every active surface
 * (prompt injection, THINKING_OS templates, training-state init).
 * T-11 (Close the Loop) takes the freed slot as a new operating principle.
 *
 * Bilingual: each principle has EN (name/statement) and
 * ZH (nameZh/statementZh) fields.
 */

import { Type } from '@sinclair/typebox';

// ── Core principle entry ──────────────────────────────────────────────────

/** Semantic layer of a core principle (PRI-606/PRI-607 two-layer model). */
export type CorePrincipleLayer = 'foundational' | 'operating';

/** Lifecycle status. Deprecated ids stay resolvable for historical data. */
export type CorePrincipleStatus = 'active' | 'deprecated';

export interface CorePrinciple {
  /** Canonical id — also the directive id in THINKING_OS.md templates (e.g. 'T-01') */
  id: string;
  /** Semantic layer: foundational axiom vs operating principle. */
  layer: CorePrincipleLayer;
  /**
   * Lifecycle status. Absent means 'active'. Deprecated entries are excluded
   * from prompt injection, THINKING_OS templates, and training-state init,
   * but remain resolvable via getCorePrinciple()/isCorePrincipleId() so
   * historical artifacts referencing them keep validating.
   */
  status?: CorePrincipleStatus;
  /**
   * For deprecated entries: id of the active principle that absorbed this
   * principle's semantics (e.g. T-07 → T-06).
   */
  supersededBy?: string;
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
  layer: Type.Union([Type.Literal('foundational'), Type.Literal('operating')]),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('deprecated')])),
  supersededBy: Type.Optional(Type.String({ pattern: '^T-\\d{2}$' })),
  name: Type.String({ minLength: 1 }),
  nameZh: Type.String({ minLength: 1 }),
  statement: Type.String({ minLength: 1 }),
  statementZh: Type.String({ minLength: 1 }),
});

// ── Registry data ─────────────────────────────────────────────────────────

const CORE_PRINCIPLE_DATA: CorePrinciple[] = [
  {
    id: 'T-01',
    layer: 'foundational',
    name: 'Survey Before Acting',
    nameZh: '先梳理再行动',
    statement: 'Build a sufficient model of the relevant system before making consequential changes.',
    statementZh: '在进行有后果的变更前，先建立对相关系统足够准确的理解。',
  },
  {
    id: 'T-02',
    layer: 'foundational',
    name: 'Intent & Constraints First',
    nameZh: '意图与约束优先',
    statement: "Act toward the owner's actual intent; explicit goals, constraints, boundaries, and decisions override inferred preferences.",
    statementZh: '围绕 Owner 的真实意图行动；明确表达的目标、约束、边界与决策优先于模型自行推断的偏好。',
  },
  {
    id: 'T-03',
    layer: 'foundational',
    name: 'Evidence Over Assumption',
    nameZh: '证据优于假设',
    statement: 'Use observable evidence—code, logs, outputs, and state—before inferring causes or claiming results.',
    statementZh: '在推断原因或宣称结果之前，优先使用可观察的代码、日志、输出与状态作为证据。',
  },
  {
    id: 'T-04',
    layer: 'foundational',
    name: 'Reversible & Safe by Default',
    nameZh: '默认可逆且安全',
    statement: 'When uncertainty or downside is meaningful, prefer reversible actions and preserve hard safety boundaries.',
    statementZh: '当不确定性或潜在损失不可忽略时，优先选择可逆行动，并保持不可突破的安全边界。',
  },
  {
    id: 'T-05',
    layer: 'operating',
    name: 'Safety Rails',
    nameZh: '安全护栏',
    statement: 'Translate hard constraints into explicit guardrails, checks, and forbidden transitions before execution.',
    statementZh: '在执行前，把不可突破的约束转化为明确的护栏、检查和禁止状态转移。',
  },
  {
    id: 'T-06',
    layer: 'foundational',
    name: 'Minimal Sufficient Change',
    nameZh: '最小充分改变',
    statement: 'Choose the simplest intervention that satisfies the intent, and change no more state than necessary.',
    statementZh: '选择能够满足真实意图的最简单干预方式，并且只改变必要的状态。',
  },
  {
    // Deprecated compatibility entry — see file header. Statement kept
    // verbatim from the pre-migration registry: it is the identity persisted
    // in existing workspaces' training state and historical artifacts.
    id: 'T-07',
    layer: 'foundational',
    status: 'deprecated',
    supersededBy: 'T-06',
    name: 'Minimal Change Surface',
    nameZh: '最小变更面',
    statement: 'Limit the blast radius and touch only what is necessary.',
    statementZh: '限制爆炸半径，只触碰必要的部分。',
  },
  {
    id: 'T-08',
    layer: 'foundational',
    name: 'Pain As Signal',
    nameZh: '痛苦即信号',
    statement: 'Treat failures, corrections, and friction as feedback to improve future behavior rather than repeat the same mistake.',
    statementZh: '把失败、纠正与摩擦视为改进未来行为的反馈，而不是反复犯同样的错误。',
  },
  {
    id: 'T-09',
    layer: 'operating',
    name: 'Divide And Conquer',
    nameZh: '分而治之',
    statement: 'Decompose complex work into independently understandable and verifiable parts when that reduces uncertainty or risk.',
    statementZh: '当拆分能够降低不确定性或风险时，将复杂任务分解为可独立理解和验证的部分。',
  },
  {
    id: 'T-10',
    layer: 'operating',
    name: 'Memory Externalization',
    nameZh: '记忆外部化',
    statement: 'Persist important intermediate conclusions, decisions, and state outside transient context when continuity matters.',
    statementZh: '当连续性重要时，把关键中间结论、决策与状态持久化到瞬时上下文之外。',
  },
  {
    id: 'T-11',
    layer: 'operating',
    name: 'Close the Loop',
    nameZh: '闭环验证',
    statement: 'After acting, observe the result and compare it with the intended outcome; execution is not success until verified.',
    statementZh: '行动后观察实际结果，并与预期目标进行比较；完成执行并不等于已经成功。',
  },
];

// ── Frozen public API ─────────────────────────────────────────────────────

/** Frozen array of all core principles, including deprecated entries */
export const CORE_PRINCIPLES: readonly CorePrinciple[] = Object.freeze(
  CORE_PRINCIPLE_DATA.map(p => Object.freeze({ ...p }))
);

/** Frozen array of all core principle ids, including deprecated ones */
export const CORE_PRINCIPLE_IDS: readonly string[] = Object.freeze(
  CORE_PRINCIPLE_DATA.map(p => p.id)
);

/**
 * Active core principles (deprecated entries excluded).
 * This is the set every active surface — prompt injection, THINKING_OS
 * templates, training-state initialization — must be derived from.
 */
export function getActiveCorePrinciples(): readonly CorePrinciple[] {
  return CORE_PRINCIPLES.filter(p => (p.status ?? 'active') === 'active');
}

/** Active foundational axioms — the `<core_principles>` injection set. */
export function getFoundationalPrinciples(): readonly CorePrinciple[] {
  return CORE_PRINCIPLES.filter(
    p => p.layer === 'foundational' && (p.status ?? 'active') === 'active'
  );
}

/** Active operating principles — surfaced via THINKING_OS directives. */
export function getOperatingPrinciples(): readonly CorePrinciple[] {
  return CORE_PRINCIPLES.filter(
    p => p.layer === 'operating' && (p.status ?? 'active') === 'active'
  );
}

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
