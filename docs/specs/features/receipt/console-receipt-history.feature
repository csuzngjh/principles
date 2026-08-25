Feature: Principle Receipt — Console 生效履历展示 (PRI-533)
  Owner 打开原则详情页可以看到「生效履历」：生效/注入两级计数、时间线
  （presence 灰色分列）、诚实性脚注；ledger flag 关闭或表缺失时显示
  降级态（reason + nextAction），不显示空数据冒充。
  PRI-590 起每个响应携带 coverage（sourceStatus/validationStatus/
  observedFrom/retentionPolicyDays），让 Owner 分辨「观察到的证据」与
  「不可用/已关闭/数据不可信」，真零不冒充、未知不折算为零。

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

  Scenario: 每原则生效计数供 Activations 页计数列消费
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_ledger
    And 原则 princ-A 有 2 次 effect 记录与 1 次 presence 记录
    When 查询全部原则的生效计数
    Then 返回 status=ok 且 princ-A 的生效计数为 effect=2 presence=1

  Scenario: 披露 coverage——数据源可用且校验有效
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_ledger
    And 原则 princ-A 有 2 次 effect 记录与 1 次 presence 记录
    When 查询原则 princ-A 的生效履历
    Then 返回 coverage sourceStatus=available validationStatus=valid
    And observedFrom 等于最早记录时间且 retentionPolicyDays=90

  Scenario: 真零——无保留记录时 observedFrom 为空而非降级
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_ledger
    And 原则 princ-A 有一条 effect 记录
    When 查询原则 princ-unknown 的生效履历
    Then 返回 coverage sourceStatus=available validationStatus=valid
    And observedFrom 为空

  Scenario: flag 关闭时 coverage 标记 disabled 而非不可用
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 未启用 principle_receipt_ledger
    When 查询任意原则的生效履历
    Then 返回 coverage sourceStatus=disabled 且 reasonCode 非空

  Scenario: 表缺失时 coverage 标记 unavailable
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_ledger
    And 工作区的 principle_applications 表已删除
    When 查询全部原则的生效计数
    Then 生效计数的 coverage sourceStatus=unavailable 且 reasonCode 非空

  Scenario: level 异常的脏行让计数不可信（malformed 而非可信零）
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_ledger
    And 原则 princ-A 有一条 effect 记录
    And 原则 princ-B 有一条 level 异常的脏记录
    When 查询全部原则的生效计数
    Then 生效计数的 coverage validationStatus=malformed
    And 生效计数的 coverage reasonCode 为 ledger_level_invalid

  Scenario: self-report 独立关闭不影响 coverage 可用性
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_ledger
    And .pd/config.yaml 关闭 principle_receipt_self_report
    And 原则 princ-A 有一条 effect 记录
    When 查询原则 princ-A 的生效履历
    Then 返回 coverage sourceStatus=available validationStatus=valid
