Feature: Principle Receipt — RuleHost 拦截文案增强 (PRI-530)
  Owner 在使用现场（agent 转述 / 展开的工具卡片）能看到拦截行为的原则署名：
  标题、批准日期、来源纠正摘要。诚实边界：元数据缺失时降级显示原始 ID，
  不编造来源；flag 关闭时保持既有通用模板不变。

  Scenario: flag 开启且元数据完整——拦截文案携带原则署名
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_block_copy
    And 原则元数据完整：标题「删除前确认目标」、批准日期 2026-07-30、来源摘要存在
    When RuleHost 拦截一次 bash 工具调用
    Then blockReason 包含原则标题「删除前确认目标」
    And blockReason 包含批准日期 2026-07-30
    And blockReason 包含来源摘要「来源：」
    And blockReason 指示 agent 向 Owner 解释并请求确认

  Scenario: 元数据缺失（遗留 ruleId）——降级显示原始 ID，不编造来源
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 启用 principle_receipt_block_copy
    And 原则元数据不存在（拦截来自遗留规则 R-legacy-530）
    When RuleHost 拦截一次 bash 工具调用
    Then blockReason 包含原始规则 ID R-legacy-530
    And blockReason 不包含「来源：」

  Scenario: flag 关闭——保持既有英文通用模板
    Given 一个已安装 PD 的工作区，且 .pd/config.yaml 未启用 principle_receipt_block_copy
    And 原则元数据完整：标题「删除前确认目标」、批准日期 2026-07-30、来源摘要存在
    When RuleHost 拦截一次 bash 工具调用
    Then blockReason 为既有通用模板（包含 Security Gate Blocked）
    And blockReason 不包含原则署名标记「PD 原则」
