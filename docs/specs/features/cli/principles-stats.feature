@cli-contract @observability
Feature: CLI principles stats 只读注入统计命令

  对应 SPEC v0.2 §6 Phase 0 / cli-1..cli-7。
  pd principles stats [--days <n>] [-w <workspace>] [--json]
  是 Principle 注入量/成本/重复/生效证据的唯一 Owner 可见聚合出口
  （PRI-562 Phase 0，证据收集例外）。

  Background:
    Given 一个可用的 pd-cli 可执行文件

  @cli-1 @principles-stats
  Scenario: --json 输出是严格的单一 JSON 对象
    Given 一个包含已知注入事件与回执账本的临时工作区
    When operator 执行 "pd principles stats --json"
    Then stdout 是严格的单一 JSON 对象
    And 该 JSON 对象可以被 JSON.parse 解析
    And stdout 不包含任何 banner 或 heading

  @cli-1 @principles-stats
  Scenario: 统计结果包含四类核心指标
    Given 一个包含已知注入事件与回执账本的临时工作区
    When operator 执行 "pd principles stats --json"
    Then 该 JSON 对象的 ok 字段为 true
    And 该 JSON 对象包含 injections 指标组
    And 该 JSON 对象包含 chars 指标组
    And 该 JSON 对象包含 duplicates 指标组
    And 该 JSON 对象包含 applicationCorrelation 指标组

  @cli-5 @principles-stats
  Scenario: 命令不写入任何状态（零状态写入）
    Given 一个包含已知注入事件与回执账本的临时工作区
    When operator 执行 "pd principles stats --json"
    Then 数据库未被修改
    And ledger 未被修改
    And 未入队新任务
    And 未创建后继任务

  @cli-6 @principles-stats
  Scenario: 空工作区时输出 degraded 降级 + nextAction
    Given 一个空的临时工作区
    When operator 执行 "pd principles stats --json"
    Then stdout 是严格的单一 JSON 对象
    And 该 JSON 对象的 ok 字段为 true
    And 该 JSON 对象的 status 字段为 "degraded"
    And 该 JSON 对象包含 nextAction 字段
    And nextAction 说明如何启用 receipt flag 或先产生注入数据
