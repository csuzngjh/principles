@companion @release-watch
Feature: Companion 版本看门狗以安装权威为准

  对应 PRI-1016 锁定决策:更新落定后,由 Companion 把**它自己拉起的**控制台服务换到新
  发布;判据是安装权威 `~/.pd/active.json` 的发布身份(releaseId/generation),不是插件
  组件的 package.json 版本号。理由(本机 23 个已装发布实测):各组件按 changeset 独立
  bump,签名发布可以铺新 console/core 代码而插件号不变(频道 seq 15→16→17 全程 2.1.0,
  seq 22→23 全程 2.1.8),按组件号比较的看门狗对这些更新一次都不会响,旧进程无限期服务
  旧代码;而版本标记在事务 `staged` 之前就被翻走,正是 PRI-1012 用有界等待去容忍的那个
  窗口,也是回滚后看不见的的那个信号。
  行为契约覆盖:
  - 发布身份变化 → 托管实例交接;附着(外部/复用)实例只报告,绝不动手
  - 只有插件组件号变了而发布身份没变 → 无变化,不交接(组件轴不再有权决策)
  - 权威读不到/非法/版本不认识 → 不交接,带结构化 reason,严禁静默回退去比组件号
  - 没有可归属的启动基线 → 不杀掉一个无法归因的健康进程
  - 事务回滚把权威退回旧发布 → 同样按变更交接回去

  Background:
    Given 一个已启动的 Companion 看门狗夹具

  @pri-1016 @release-change
  Scenario: 更新落定后托管实例被交接,交接目标就是新发布
    When 运行中的发布是 A 第 47 代,安装权威是 B 第 48 代,实例由 Companion 托管
    Then 看门狗判定为交接
    And 交接目标是发布 B

  @pri-1016 @component-axis-blindspot
  Scenario: 组件号没变的发布更新照样交接(旧判据在这里失明)
    When 运行中的发布是 A 第 46 代,安装权威是 B 第 47 代,产品版本号两边都是 2.3.8,实例由 Companion 托管
    Then 看门狗判定为交接

  @pri-1016 @component-axis-noise
  Scenario: 组件号变了但发布身份没变,不交接(组件轴无权决策)
    When 运行中的发布是 A 第 47 代,安装权威是 A 第 47 代,插件组件号从 2.1.7 变成 2.1.8,实例由 Companion 托管
    Then 看门狗判定为无变化
    And 组件号这一轴确实动了,旧判据在这里会交接

  @pri-1016 @rollback
  Scenario: 事务回滚把权威退回旧发布,同样交接回去
    When 运行中的发布是 B 第 47 代,安装权威是 A 第 46 代,实例由 Companion 托管
    Then 看门狗判定为交接

  @pri-1016 @attached
  Scenario: 外部启动的实例只报告分歧,绝不被杀掉
    When 运行中的发布是 A 第 47 代,安装权威是 B 第 48 代,实例是附着的外部控制台
    Then 看门狗判定为只报告不动手

  @pri-1016 @authority-unavailable
  Scenario: 权威文件不存在时不交接,原因如实报告
    When 运行中的发布是 A 第 47 代,安装权威读取失败 reason 是 active_record_absent,实例由 Companion 托管
    Then 看门狗判定为不交接
    And 不交接的原因就是 active_record_absent

  @pri-1016 @authority-unavailable
  Scenario: 权威内容不是合法 JSON 时不交接,不回退去比组件号
    When 运行中的发布是 A 第 47 代,安装权威读取失败 reason 是 active_record_json_invalid,实例由 Companion 托管
    Then 看门狗判定为不交接
    And 不交接的原因就是 active_record_json_invalid

  @pri-1016 @authority-unavailable
  Scenario: 权威记录结构不是对象时不交接
    When 运行中的发布是 A 第 47 代,安装权威读取失败 reason 是 active_record_not_object,实例由 Companion 托管
    Then 看门狗判定为不交接
    And 不交接的原因就是 active_record_not_object

  @pri-1016 @authority-unavailable
  Scenario: 权威记录用了看不懂的 schemaVersion 时不交接
    When 运行中的发布是 A 第 47 代,安装权威读取失败 reason 是 active_record_schema_version_unsupported,实例由 Companion 托管
    Then 看门狗判定为不交接
    And 不交接的原因就是 active_record_schema_version_unsupported

  @pri-1016 @no-baseline
  Scenario: 没有可归属的启动基线时不动手
    When 运行中的发布未知,安装权威是 B 第 48 代,实例由 Companion 托管
    Then 看门狗判定为不交接
    And 不交接的原因就是 no_baseline
