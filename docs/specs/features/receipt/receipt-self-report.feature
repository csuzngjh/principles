Feature: Principle Receipt — 软原则自述行 (PRI-532)
  flag 开启时，注入的原则指令块要求 agent 在原则真正改变其行为时于回复末尾
  追加一行 📌 自述（引用 directive id）；llm_output / before_message_write
  捕获该标记并写入 self_reported 履历（每原则×会话去重）。
  诚实边界：自述是 agent 自述（probabilistic），标记文本按不可信数据处理；
  flag 关闭时模板与既有输出一致、零捕获。

  Scenario: flag 开启——指令模板包含自述要求
    Given principle_receipt_self_report 已启用
    When 渲染原则指令块
    Then 输出包含自述格式行「📌 应用了你的原则」
    And 输出包含"每原则每会话至多一行"约束
    And 输出指示使用 directive 的 id

  Scenario: flag 关闭——模板与既有输出一致
    Given principle_receipt_self_report 未启用
    When 渲染原则指令块
    Then 输出不包含「📌」
    And 输出与既有模板逐字节一致

  Scenario: 捕获标记行——写入 self_reported 履历行
    Given principle_receipt_self_report 已启用
    When assistant 回复包含「📌 应用了你的原则「princ-A」：先读文档再动手」（会话 sess-sr）
    Then principle_applications 新增一行 kind=self_reported level=effect
    And 该行 principle_id=princ-A、session_id=sess-sr、digest 含自述内容

  Scenario: 同会话同原则重复标记——只记一行
    Given principle_receipt_self_report 已启用
    When 同一会话的两次 assistant 回复包含相同原则的标记行
    Then principle_applications 只有一行 kind=self_reported

  Scenario: 畸形标记——不写行、不抛错
    Given principle_receipt_self_report 已启用
    When assistant 回复包含空 id 与超长 id 的伪标记行
    Then principle_applications 没有新增任何 self_reported 行
