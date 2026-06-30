@cli-contract
Feature: CLI 严格 JSON 输出契约

  对应 cli-1-strict-json:--json 输出必须是 stdout 上恰好一个可解析的 JSON 对象。
  无 banner、heading、解释文本、混合 stdout 日志。

  Background:
    Given 一个可用的 pd-cli 可执行文件

  @cli-1 @prd-matrix:strict-json
  Scenario: 成功命令的 --json 输出是单一 JSON 对象
    When operator 执行 "pd pain retry --pain-id pain-001 --json"
    Then stdout 是严格的单一 JSON 对象
    And 该 JSON 对象可以被 JSON.parse 解析
    And stdout 不包含任何 banner 或 heading

  @cli-1 @prd-matrix:strict-json-error
  Scenario: 失败命令的 --json 输出含 reason 和 nextAction
    When operator 执行 "pd pain retry --pain-id nonexistent --json"
    Then stdout 是严格的单一 JSON 对象
    And 该 JSON 对象的 status 字段表示失败
    And 该 JSON 对象包含 reason 字段
    And 该 JSON 对象包含 nextAction 字段
