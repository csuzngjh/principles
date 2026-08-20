@mvp-core
Feature: Owner 在 Principle Detail 理解原则治理状态

  Story A' 治理投影只读地解释 Runtime 事实，不改变现有审批动作。

  Background:
    Given pd-console governance projection BDD 服务可用
    And workspace 中存在可查看的原则

  @prd-matrix:governance-projection
  Scenario: 有来源支撑的待审批投影显示状态、原因和下一步
    Given 该原则的治理投影需要 Owner 决策
    When Owner 打开该原则详情页
    Then Owner 能看到治理状态、来源可信度和下一步安全动作
    And 默认视图不暴露技术证据标识

  @prd-matrix:governance-projection-degraded-revision
  Scenario: 证据不完整的自动修订显示不确定性且不提供 Owner 动作
    Given 该原则正在自动修订且证据不完整
    When Owner 打开该原则详情页
    Then Owner 能看到修订状态和证据不确定性
    And 默认视图不暴露技术证据标识

  @prd-matrix:governance-projection-rollback
  Scenario: 治理投影关闭时保留原有原则详情体验
    Given 该原则的治理投影功能已关闭
    When Owner 打开该原则详情页
    Then 原有原则内容仍然显示
    And 治理投影卡片不显示
