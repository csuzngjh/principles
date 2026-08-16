Feature: Principle Receipt — 生效履历存储 (PRI-531)
  Owner 的原则应用历史进入持久存储（state.db principle_applications），
  两级口径：effect（拦截/自动纠正）与 presence（prompt 注入，按会话×原则去重）。
  诚实边界：requireApproval 不写 effect 行（宿主无暂停能力，无行为改变）；
  flag 关闭时零写入；写入失败降级不阻断 hook。

  Scenario: RuleHost 拦截写入 effect 行
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_ledger
    When RuleHost 拦截一次工具调用（规则 R-531，会话 sess-531）
    Then principle_applications 表新增一行 kind=rule_blocked level=effect
    And 该行包含 session_id=sess-531、rule_id=R-531 与拦截原因摘要

  Scenario: 自动纠正生效后写入 effect 行
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_ledger
    When RuleHost 对一次工具调用应用 live 自动纠正（dry_run false→true）
    Then principle_applications 表新增一行 kind=auto_correct_applied level=effect
    And 该行 digest 记录被纠正的字段与前后值

  Scenario: requireApproval 不写 effect 行
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_ledger
    When RuleHost 对一次工具调用返回 requireApproval
    Then principle_applications 表没有新增任何行

  Scenario: prompt 注入写 presence 行且按会话去重（含重启）
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_ledger
    When 同一会话注入原则 princ-A 与 princ-B 两次
    Then principle_applications 表只有 2 行 kind=prompt_injected level=presence
    And 进程重启（连接缓存清空）后再次注入相同原则
    Then 仍然只有 2 行 presence（部分唯一索引跨重启去重）

  Scenario: flag 关闭时零写入
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 未启用 principle_receipt_ledger
    When RuleHost 拦截一次工具调用
    Then principle_applications 表没有新增任何行
