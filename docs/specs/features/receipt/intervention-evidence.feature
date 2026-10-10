Feature: Principle Intervention Evidence — 证据链四问与 Owner 结果 (PD v2 Phase 1, ADR-0027/SPEC §13.8)
  Owner 从 Console 可以按原则/激活/行为/效果四种选择器查看规范化证据链：
  投递（确认程度）、应用（agent_claimed 与 runtime_verified 分列）、行为
  Episode、Effect 与 Outcome。空区段是"本范围内未观察到"，不是"未发生"；
  pending 关联、来源冲突、降级（缺库/未初始化/旗标关）都有结构化原因。
  Owner 结果输入只接受事实反馈（episode 引用 + 观察摘要），actor 由服务端
  身份解析注入，任何 runtime 证明字段都无法从该入口伪造。同源重放幂等。

  Scenario: Owner 按原则查看完整证据链（投递+应用+行为+效果+结果分列）
    Given 一个已安装 PD 的工作区，且启用了 principle_receipt_ledger
    And 有一条已批准激活 act-1 的证据链：投递 submitted、自述 agent_claimed、Episode ep-1、Effect linked、Outcome owner_feedback
    When Owner 查询原则 princ-A 的证据链
    Then 返回 status=ok 且 deliveries=1 applications=1 effects=1 outcomes=1
    And applications[0] 的 proofMethod 为 agent_claimed 且不含 runtime 证明边界
    And coverage sourceStatus=available 且 asOf 非空

  Scenario: 自述与 Runtime 证据分列且互不升级
    Given 一个已安装 PD 的工作区，且启用了 principle_receipt_ledger
    And 原则 princ-A 有一条 agent_claimed 自述应用与一条 runtime_verified 阻断应用（绑定激活 act-1 与证明边界）
    When Owner 查询原则 princ-A 的证据链
    Then applications 共 2 条且按 proofMethod 分别可辨
    And agent_claimed 记录不含 enforcementBoundary 而 runtime_verified 记录含

  Scenario: 缺失关联如实展示为 pending 而非丢失
    Given 一个已安装 PD 的工作区，且启用了 principle_receipt_ledger
    And 有一条 Effect 引用了尚未到达的 Episode ep-missing
    When Owner 查询原则 princ-A 的证据链
    Then effects[0] 的 associationStatus 为 pending_association
    And unresolvedReferences 包含 missingKey=ep-missing 与 field=episodeKey

  Scenario: 重放同源批次幂等且连接重启后仍可查询
    Given 一个已安装 PD 的工作区，且启用了 principle_receipt_ledger
    And 已写入一批含 4 条记录的证据链
    When 以相同来源重放该批次并用新连接查询
    Then 记录数不变且重放结果报告 duplicates 而非新增
    And 查询结果与首次一致
    And Episode 由自身选择器可达且与首次一致

  Scenario: Owner 结果提交——服务端注入 actor 且拒绝 runtime 证明字段
    Given 一个已安装 PD 的工作区，且启用了 principle_receipt_ledger
    And 存在行为 Episode ep-1 与已解析的 Owner 身份 owner-console-1
    When Owner 对 ep-1 提交结果观察 "受保护文件未被创建"
    Then 返回 status=recorded 且 provenance=owner_report
    And 落库 outcome 的 actorId 为 owner-console-1 且 outcomeSource 为 owner_feedback
    When 提交体携带 proofMethod=runtime_verified 字段时
    Then 返回 400 且错误说明 Owner 契约只接受三个字段

  Scenario: 前证据数据库只降级不创建（真不可用）
    Given 一个无证据表的旧 state.db 工作区，且启用了 principle_receipt_ledger
    When Owner 查询任意原则的证据链
    Then 返回 status=degraded 且 reason 含 evidence_schema_not_initialized
    And 该 GET 不创建任何证据表
