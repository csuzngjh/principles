import { validateGoldenTrace } from '../golden-trace.js';

/**
 * PRI-634 — 可激活 rule 产物的内容契约（activation 候选解析用）。
 *
 * 事实基线：合法的 activation 目标是 **evaluator assemble 的 rule 产物**
 * （evaluator-runner.ts 的 assembleRuleArtifact 输出）。该产物必然携带
 * `implementationCode`、`goldenTrace`、`ruleHostGateDecision='accepted_shadow'`
 * 三项 —— 后者由 adversarialResult.passed===true 的装配前置条件保证。
 *
 * Artificer 的原始产物不是可激活目标：它的 schema 是 `goldenTraceCases`
 * （数组，未经 buildGoldenTraceFromArtificer），既无 `goldenTrace` 也无
 * `ruleHostGateDecision`。把它改标成 kind='rule' + validated（例如数据修复）
 * 会造出 kind/validated 全部匹配、内容却完全不合法的伪候选。
 *
 * 修复前 `resolveActivationCandidate` 只按 kind+validated 过滤，伪候选被放行
 * 到 `RuleHostWriter.canActivate` 才以 `no_golden_trace` 爆炸，Owner 在治理台
 * 上只能看到 `rollout_dispatch_refused`，无从判断是规则内容坏还是链路坏。
 * 本契约把该判定前移到候选解析阶段。
 *
 * 校验项 = `RuleHostWriter.canActivate` 静态检查（沙箱调用之前）的子集，
 * 刻意不含 feature flag 判定与 v2 内容约束 —— 那些依赖运行时注入，属于
 * writer 的职责。此处只判定「这是不是一条 evaluator assemble 出来的产物」。
 */
export type RuleActivationContentGap =
  | 'content_json_unparseable'
  | 'implementationCode'
  | 'goldenTrace'
  | 'ruleHostGateDecision:accepted_shadow';

export type RuleActivationContentCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly missingFields: readonly RuleActivationContentGap[] };

/** evaluator assemble 产物写入的 gate decision 字面量（与 writer 判定同源）。 */
const ACCEPTED_SHADOW = 'accepted_shadow';

/**
 * 有界解析 contentJson，判定其是否满足可激活 rule 产物的内容契约。
 * 纯函数：无 I/O、无注入依赖，可直接单测。
 */
export function checkRuleActivationContent(contentJson: string): RuleActivationContentCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return { ok: false, missingFields: ['content_json_unparseable'] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, missingFields: ['content_json_unparseable'] };
  }

  // runtime-contract-exempt: ERR-001 object-guarded unknown property extraction;
  // values are typeof-checked / schema-validated immediately below.
  const { implementationCode, goldenTrace, ruleHostGateDecision } = parsed as {
    implementationCode?: unknown;
    goldenTrace?: unknown;
    ruleHostGateDecision?: unknown;
  };

  const missingFields: RuleActivationContentGap[] = [];
  if (typeof implementationCode !== 'string' || implementationCode.trim().length === 0) {
    missingFields.push('implementationCode');
  }
  // 与 writer 同用 validateGoldenTrace：goldenTraceCases（artificer schema）
  // 在此必然不通过，伪候选因此被筛掉。
  if (!validateGoldenTrace(goldenTrace).valid) {
    missingFields.push('goldenTrace');
  }
  if (ruleHostGateDecision !== ACCEPTED_SHADOW) {
    missingFields.push('ruleHostGateDecision:accepted_shadow');
  }

  return missingFields.length === 0 ? { ok: true } : { ok: false, missingFields };
}
