import { buildGoldenTraceFromArtificer } from '../golden-trace.js';

/**
 * PRI-634 A2（authority migration）— code-bearing Artificer artifact 判定。
 *
 * 设计裁决（Owner 评审 2026-08-31 冻结）：`这条链是否需要 deterministic
 * RuleHost gate` 的 authority 是 **durable Artificer artifact 是否
 * code-bearing**，而不是 evaluator LLM 是否恰好输出了 optional 的 V2 字段
 * （`isEvaluatorOutputV2()`）。原控制流把 optional LLM output shape 当作
 * gate 前置 —— V2 字段全部 optional 且 validator 明确允许 V1 缺失
 * （evaluator-output.ts），导致一个完整 code-bearing 的 Artificer 产物可以在
 * evaluator 只返回 V1 shape 时结构性跳过安全门（48371236 链 attempt 17）。
 *
 * 评审实现约束：**不得**把「字段碰巧存在」当成新的弱 heuristic authority。
 * 本函数逐项镜像 `assembleRuleArtifact()`（evaluator-runner.ts）的静态前置
 * 验证 —— 返回 codeBearing=true 严格等价于「rule assembly 的全部静态检查
 * 将通过」。这样 authority 定义收敛到唯一的、机器可验证的语义：
 * 经 runtime validation 的 durable Artificer capability。
 *
 * 验证序列（与 assemble 的 rule_assembly_failed reasons 一一对应）：
 *   1. contentJson 缺失            → no_artificer_artifact
 *   2. JSON 解析失败 / 非 object   → artificer_artifact_unparseable
 *   3. implementationCode 非空串   → artificer_artifact_has_no_implementation_code
 *   4. goldenTraceCases 非数组     → artificer_golden_trace_cases_not_array
 *   5. buildGoldenTraceFromArtificer 失败（结构非法 / 无 positive+negative）
 *                                  → golden_trace_build_failed:<reason>
 *
 * affectedTools 刻意**不**作为硬条件：assemble 的真实语义是 tolerant
 * （optional 数组、元素 filter string、缺省 []）。把它收紧成硬失败会造出
 * 比 assemble 更严的假 authority，违反 One Source of Truth。
 *
 * 纯函数：无 I/O、无注入依赖，可直接单测。
 */
export type ArtificerCodeBearingAssessment =
  | { readonly codeBearing: true }
  | { readonly codeBearing: false; readonly reason: string };

export function assessArtificerCodeBearing(contentJson: string | null | undefined): ArtificerCodeBearingAssessment {
  if (typeof contentJson !== 'string' || contentJson.trim() === '') {
    return { codeBearing: false, reason: 'no_artificer_artifact' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return { codeBearing: false, reason: 'artificer_artifact_unparseable' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { codeBearing: false, reason: 'artificer_artifact_unparseable' };
  }

  // runtime-contract-exempt: ERR-001 object-guarded unknown property extraction;
  // values are typeof-checked / structurally validated immediately below.
  const { implementationCode, goldenTraceCases } = parsed as {
    implementationCode?: unknown;
    goldenTraceCases?: unknown;
  };

  if (typeof implementationCode !== 'string' || implementationCode.trim() === '') {
    return { codeBearing: false, reason: 'artificer_artifact_has_no_implementation_code' };
  }
  if (!Array.isArray(goldenTraceCases)) {
    return { codeBearing: false, reason: 'artificer_golden_trace_cases_not_array' };
  }

  // assemble 要求 ≥1 positive + ≥1 negative 且逐 case 结构合法
  // （buildGoldenTraceFromArtificer 内部对每项做 validateGoldenTraceCase）。
  const traceBuild = buildGoldenTraceFromArtificer({ cases: goldenTraceCases });
  if (!traceBuild.ok) {
    return { codeBearing: false, reason: `golden_trace_build_failed: ${traceBuild.reason}` };
  }

  return { codeBearing: true };
}
