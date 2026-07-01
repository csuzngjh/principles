@mvp-core
Feature: Owner 审批 prompt channel 原则激活

  Story A 后端切面:pain → admitted candidate → principle → awaiting_owner_review
  → owner approve → activation queued/completed → active RuleHost record
  → 后续相同调用改变行为 → observation evidence 持久化 → owner rollback
  → 后续相同调用不再应用规则

  覆盖 PRD 验收矩阵:
  - @prd-matrix:owner-reject: owner 拒绝后原则不被激活
  - @prd-matrix:full-loop: 完整 prompt channel 循环

  Background:
    Given 一个干净的测试 workspace
    And 一条已通过验证的 principle artifact,artifactId 为 "art-test-001"

  @prd-matrix:full-loop
  Scenario: 完整 prompt channel 端到端循环
    When owner 审批通过该原则,channel 为 "prompt"
    Then 原则被激活,activationId 存在
    And activation state store 中存在 channel 为 "prompt" 的 active 记录
    And 该记录的 deactivatedAt 为 null

  @prd-matrix:owner-reject
  Scenario: owner 拒绝后原则不被激活
    When owner 拒绝该原则
    Then 原则未被激活
    And activation state store 中不存在该原则的 active 记录
