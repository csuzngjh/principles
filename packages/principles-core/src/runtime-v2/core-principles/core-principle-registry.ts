/**
 * Core Principle Registry — T-01..T-10
 *
 * Canonical source of truth for the 10 built-in core principles.
 * The shipped THINKING_OS.md templates carry the same T-NN ids; the drift
 * test in openclaw-plugin validates template ↔ registry alignment
 * (id + name + layer + canonical statement anchor).
 *
 * ## Layer model (PRI-606/PRI-607)
 *
 * The registry is exactly 10 principles in two layers:
 * - 6 Foundational Axioms (`layer: 'foundational'`) — high-abstraction,
 *   tool-agnostic, generative decision rules. Injected via
 *   `<core_principles>`.
 * - 4 Operating Principles (`layer: 'operating'`) — how an agent puts the
 *   axioms into practice. Surfaced via THINKING_OS directives.
 *
 * ## Pre-release reset policy (Owner decision, PR #1421 round 3)
 *
 * Built-in core principle semantics were redesigned during the pre-release
 * MVP phase. Existing experimental PD workspaces are NOT migrated in place;
 * testing this version requires a fresh workspace. The project intentionally
 * prioritizes a simple canonical model over compatibility machinery for
 * experimental state: there are no deprecated entries, no status/supersededBy
 * lifecycle fields, and no legacy aliases here.
 *
 * Bilingual: each principle has EN (name/statement) and
 * ZH (nameZh/statementZh) fields.
 */

import { Type } from '@sinclair/typebox';

// ── Core principle entry ──────────────────────────────────────────────────

/** Semantic layer of a core principle (PRI-606/PRI-607 two-layer model). */
export type CorePrincipleLayer = 'foundational' | 'operating';

export interface CorePrinciple {
  /** Canonical id — also the directive id in THINKING_OS.md templates (e.g. 'T-01') */
  id: string;
  /** Semantic layer: foundational axiom vs operating principle. */
  layer: CorePrincipleLayer;
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
    id: 'T-07',
    layer: 'operating',
    name: 'Close the Loop',
    nameZh: '闭环验证',
    statement: 'After acting, observe the result and compare it with the intended outcome; execution is not success until verified.',
    statementZh: '行动后观察实际结果，并与预期目标进行比较；完成执行并不等于已经成功。',
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

/** Active foundational axioms — the `<core_principles>` injection set. */
export function getFoundationalPrinciples(): readonly CorePrinciple[] {
  return CORE_PRINCIPLES.filter(p => p.layer === 'foundational');
}

/** Active operating principles — surfaced via THINKING_OS directives. */
export function getOperatingPrinciples(): readonly CorePrinciple[] {
  return CORE_PRINCIPLES.filter(p => p.layer === 'operating');
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
