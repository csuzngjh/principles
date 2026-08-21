Feature: Principle Receipt — Console 生效履历展示 (PRI-533)
  Owner 打开原则详情页可以看到「生效履历」：生效/注入两级计数、时间线
  （presence 灰色分列）、诚实性脚注；ledger flag 关闭或表缺失时显示
  降级态（reason + nextAction），不显示空数据冒充。

  Scenario: 有履历数据时返回计数与时间线
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_ledger
    And 原则 princ-A 有 2 次 effect 记录与 1 次 presence 记录
    When 查询原则 princ-A 的生效履历
    Then 返回 status=ok 且 effectCount=2 presenceCount=1
    And 时间线按时间倒序且包含 kind 与 digest

  Scenario: flag 关闭时返回降级态（reason + nextAction）
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 未启用 principle_receipt_ledger
    When 查询任意原则的生效履历
    Then 返回 status=degraded 且 reason 与 nextAction 均非空

  Scenario: 无记录的原则返回空履历而非降级
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_ledger
    And 原则 princ-A 有一条 effect 记录
    When 查询原则 princ-unknown 的生效履历
    Then 返回 status=ok 且 effectCount=0 events 为空
