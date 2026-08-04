@internalization @progressive-disclosure
Feature: Evaluator 渐进式披露 — 两阶段评估与诊断输出

  对应 design §6.5 / §11。progressive_evaluator flag 开启后：
  - evaluator 先用摘要级上下文做 Stage 1 评估
  - 仅在 flagged / undetermined / 强制采样时触发 Stage 2 独立复评
  - Stage 2 输出完全替代 Stage 1（rc-7 / ERR-015/018/019）
  - flag 关闭时行为与当前单阶段评估完全一致

  Background:
    Given progressive_evaluator flag 已开启
    And 一个已通过校验的 artificer artifact

  @progressive @stage1-sufficient
  Scenario: Stage 1 判定通过且无 flagged — 不触发 Stage 2
    When evaluator 执行 Stage 1 评估
    Then Stage 1 输出的 compressionFidelity.missingDimensions 为空
    And Stage 1 输出的 painCoverage.fullyCovered 为 true
    And Stage 1 输出的 implementationFidelity.score >= 0.7
    And 最终输出等于 Stage 1 输出
    And stagesRun 为 1

  @progressive @stage2-flagged
  Scenario: Stage 1 检出 required 维度缺失 — 触发 Stage 2 独立复评
    When evaluator 执行 Stage 1 评估
    Then Stage 1 输出的 compressionFidelity.missingDimensions 含 riskLevel
    And 最终输出等于 Stage 2 输出（不与 Stage 1 合并）
    And stagesRun 为 2

  @progressive @stage2-isolation
  Scenario: Stage 2 不接收 Stage 1 的输出或 concerns
    When evaluator 触发 Stage 2 评估
    Then Stage 2 的 prompt 不包含 Stage 1 的 evaluation 结果
    And Stage 2 的 prompt 不包含 Stage 1 的 concerns
    And Stage 2 的最终输出是独立的（rc-7 隔离）

  @progressive @optional-fields
  Scenario: evaluator 输出含可选 painCoverage 和 compressionFidelity 字段
    When evaluator 产出评估结果
    Then 输出可以包含 painCoverage 字段
    And 输出可以包含 compressionFidelity 字段
    And compressionFidelity 不含 strategicPerspectiveCovered（excluded 维度）
    And compressionFidelity.missingDimensions 只含 required 维度
    And isEvaluatorOutputV2 对仅含新字段的输出返回 true

  @progressive @flag-off
  Scenario: progressive_evaluator flag 关闭 — 单阶段评估行为不变
    Given progressive_evaluator flag 已关闭
    When evaluator 执行评估
    Then 只进行一次 LLM 调用
    And 输出不含 painCoverage 字段
    And 输出不含 compressionFidelity 字段
