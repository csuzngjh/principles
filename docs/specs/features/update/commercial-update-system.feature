@update-system
Feature: 商业级版本更新系统行为契约

  对应 SPEC docs/superpowers/specs/2026-08-25-commercial-grade-update-system-design.md §18。
  覆盖 check / apply / reinstall / refusal / interrupted recovery / rollback /
  legacy migration / version display / history classification 九类可观察行为。
  步骤驱动真实模块（ReleaseManager、事务 journal、恢复器、迁移器、版本报告），
  不允许 mock 掉被测行为。

  Background:
    Given 一个隔离的临时 HOME 作为安装根
    And 一个带 bootstrap 与双槽安装状态的 ~/.pd 布局

  @update-check
  Scenario: check 通过签名链解析渠道并给出前进决策
    When 对 stable 渠道执行 ReleaseManager.check
    Then 返回候选发布的 canonical productVersion 与 publicationSequence
    And 决策为 allowed 且 direction 为 update

  @update-apply
  Scenario: apply 在仓库未发布工件时安全拒绝并关闭事务
    When 执行 ReleaseManager.apply 而仓库未发布工件
    Then 拒绝原因为 metadata_refresh_failed
    And 拒绝信息包含面向 Owner 的 nextAction
    And 打开的更新事务以终态 failed 关闭

  @update-reinstall
  Scenario: 相同 releaseId 的再次安装被分类为 reinstall
    When 前进策略评估同一 releaseId 的候选
    Then 决策为 allowed 且 direction 为 reinstall

  @update-refusal
  Scenario: 更旧的发布序列在默认策略下被拒绝
    When 前进策略评估 publicationSequence 更小的候选
    Then 决策被拒绝且原因为 downgrade_blocked
    And 拒绝信息包含显式 downgrade 下一步说明

  @update-recovery
  Scenario: 激活窗口中断后恢复为旧确认版本而非混合状态
    When 事务 journal 记录到 activated 但 active.json 未落到新 generation
    Then 恢复结果为 old_confirmed
    And 恢复原因说明回退到先前确认的 generation

  @update-recovery-refusal
  Scenario: 首次激活中断且无先前版本时显式拒绝
    When 事务 journal 记录到 activated 且没有任何先前 active 记录
    Then 恢复结果为 explicit_refusal
    And nextAction 要求运行官方安装器

  @update-rollback-once
  Scenario: 确定性失败触发一次全体回滚
    When 一个先前运行中的 host 出现 handshake_mismatch
    Then 协调决策为 auto_rollback

  @update-rollback-breaker
  Scenario: 第二次确定性失败打开断路器
    When 已用过一次自动回滚后再次出现确定性失败
    Then 协调决策为 circuit_breaker_open
    And nextAction 说明保留最后确认版本并要求显式 Owner 操作

  @update-rollback-environmental
  Scenario: 网络类失败不触发自动回滚
    When 一个先前运行中的 host 出现 network_unavailable
    Then 协调决策为 retry_handshake 而非回滚

  @update-legacy-migration
  Scenario: 官方安装器将 overlay 安装迁移到双槽布局
    When 由官方安装器对存在的 overlay 执行迁移
    Then 迁移成功且 active.json 记录 generation 1
    And overlay 目录保持只读原样
    And 历史记录追加 legacy_migration 事件

  @update-legacy-migration-scope
  Scenario: 非官方调用方不得迁移 bootstrap
    When 非官方安装器调用方对 overlay 执行迁移
    Then 迁移被拒绝且原因为 bootstrap_write_out_of_scope
    And 磁盘上不产生任何 ~/.pd 写入

  @update-version
  Scenario: pd 版本表面报告 canonical 身份而非 checkout 包版本
    When 构建 ~/.pd 安装的 canonical 版本报告
    Then productVersion 来自 active.json
    And source 为 official-installer
    And 短文本格式为 Principles Disciple 前缀加版本与 releaseId 前缀

  @update-history
  Scenario: 历史方向由 canonical 序列推导而非包版本猜测
    When 历史事件以 release 序列 9 对先前序列 8 分类方向
    Then direction 为 forward
    When 历史事件以 release 序列 7 对先前序列 8 分类方向
    Then direction 为 backward
