@cli-contract @internalization
Feature: CLI context-trace 只读诊断命令

  对应 design §6.7 / cli-1..cli-7。
  pd runtime internalization context-trace --task <taskId> [--json]
  是 Layer 0/1/2 全部诊断信号的唯一 Owner 可见出口。

  Background:
    Given 一个可用的 pd-cli 可执行文件

  @cli-1 @context-trace
  Scenario: --json 输出是严格的单一 JSON 对象
    When operator 执行 "pd runtime internalization context-trace --task task-001 --json"
    Then stdout 是严格的单一 JSON 对象
    And 该 JSON 对象可以被 JSON.parse 解析
    And stdout 不包含任何 banner 或 heading

  @cli-5 @context-trace
  Scenario: 命令不写入任何状态（零状态写入）
    When operator 执行 "pd runtime internalization context-trace --task task-001 --json"
    Then 数据库未被修改
    And ledger 未被修改
    And 未入队新任务
    And 未创建后继任务

  @cli-6 @context-trace
  Scenario: 全 flag 关闭时输出 feature_disabled 降级 + nextAction
    Given 所有 progressive-disclosure flag 已关闭
    When operator 执行 "pd runtime internalization context-trace --task task-001 --json"
    Then stdout 是严格的单一 JSON 对象
    And 该 JSON 对象的 ok 字段为 true
    And 该 JSON 对象的 degradations 含 code 为 feature_disabled 的条目
    And 该 JSON 对象包含 nextAction 字段
    And nextAction 说明如何在 .pd/config.yaml 启用 flag

  @cli-6 @context-trace
  Scenario: 任务不存在时输出结构化错误 + nextAction
    Given progressive-disclosure flag 已开启
    When operator 执行 "pd runtime internalization context-trace --task nonexistent --json"
    Then stdout 是严格的单一 JSON 对象
    And 该 JSON 对象的 ok 字段为 false
    And 该 JSON 对象包含 error.code 字段
    And 该 JSON 对象包含 nextAction 字段

  @cli-4 @context-trace
  Scenario: context-trace 不提供 --dry-run 或 --confirm 选项
    Then context-trace 命令不注册 --dry-run 选项
    And context-trace 命令不注册 --confirm 选项
