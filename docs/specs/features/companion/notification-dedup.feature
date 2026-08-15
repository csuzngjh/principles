@companion @notifications
Feature: Companion 待审批通知与去重

  对应 PRI-526 锁定决策 #4:仅对待审批项(和更新可用)弹系统通知,
  且不能把存量待审批当新闻轰炸用户。

  Background:
    Given companion 的持久化去重状态 notifiedApprovalIds

  @pri-526 @baseline-silent
  Scenario: 启动后第一拍快照作为静默基线,不弹任何通知
    When 已知基线尚未记录
    And 当前快照包含审批 "apr-1" 与 "apr-2"
    Then 通知列表为空
    And 基线记录为 ["apr-1", "apr-2"]

  @pri-526 @new-approval-notifies
  Scenario: 基线之后出现的新审批触发一次通知
    When 已知基线已记录且已知审批为 ["apr-1"]
    And 当前快照包含审批 "apr-1" 与 "apr-new"
    Then 通知列表为 ["apr-new"]

  @pri-526 @no-refire
  Scenario: 同一审批不因仍在待处理列表而重复通知
    When 已知基线已记录且已知审批为 ["apr-1"]
    And 当前快照仍包含审批 "apr-1"
    Then 通知列表为空

  @pri-526 @malformed-response
  Scenario: 接口响应不合法时不产生"没有待审批"的假象
    When 审批接口返回 success 为 false 的响应
    Then 快照解析结果为 undefined

  @pri-526 @update-once
  Scenario: 更新可用通知每个版本只弹一次
    Given 已通知过的版本列表为 ["1.0.0"]
    When 更新检查返回 hasUpdate=true 且 latestVersion 为 "1.0.0"
    Then 不应通知
    When 更新检查返回 hasUpdate=true 且 latestVersion 为 "1.1.0"
    Then 应通知
    When 更新检查返回 hasUpdate=false 且 latestVersion 为 "1.2.0"
    Then 不应通知
