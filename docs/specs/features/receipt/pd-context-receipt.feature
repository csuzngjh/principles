Feature: Principle Receipt — /pd-context status 会话回执 (PRI-534)
  Owner 在聊天里输入 /pd-context status 即可零打扰地查看本会话的回执：
  注入了哪些原则、被拦截几次、自动纠正几次。
  无会话身份（非聊天调用）时不显示回执区块。

  Scenario: 注入与干预发生后的会话回执
    Given 会话 sess-pd 注入了原则 princ-A 与 princ-B
    And 会话 sess-pd 发生了 2 次拦截与 1 次自动纠正
    When Owner 执行 /pd-context status
    Then 输出包含「本会话回执」
    And 输出包含注入原则 2 条（含 princ-A）
    And 输出包含拦截 2 次与自动纠正 1 次

  Scenario: 空会话显示零计数回执
    Given 会话 sess-empty 尚无任何注入或干预
    When Owner 执行 /pd-context status
    Then 输出包含「本会话回执」与注入原则 0 条

  Scenario: 无会话身份时不显示回执区块
    Given 命令调用不携带 sessionId
    When Owner 执行 /pd-context status
    Then 输出不包含「本会话回执」
