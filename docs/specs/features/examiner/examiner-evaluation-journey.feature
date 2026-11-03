Feature: Examiner v0.10.1 — Owner-controlled Behavioral Evaluation journey (SPEC-PD-EXAMINER-001 v0.10.1)
  Owner 从 Console 走完"原则评估 → 生产证据 → Study 配置 → 执行 → Report V2 →
  治理交接"的完整旅程。两条证据通道互补但不合并：受控 A/B 结果与生产观察
  分列呈现；确认阶梯（submitted/host_accepted/context_present/runtime_loaded）
  与应用证明（agent_claimed/runtime_verified）永不自动升级；不可用的数据通道
  以 DEGRADED + 原因呈现，绝不当成零事件。异步执行契约（202 + runId、单活
  运行、重启恢复 RESULT_UNKNOWN 不自动重试）与 F2 授权门在路由层强制执行。

  Scenario: 生产证据聚合——不可用通道如实降级而非零事件
    Given 一个已安装 PD 的工作区（无 state.db 的运行时数据）
    When Owner 查询原则 pri-target 的生产证据聚合
    Then 返回 ledger 原则事实与 asOf
    And activation 通道为 degraded 且带结构化原因
    And injection 通道为 degraded 且带 globalReason
    And 证据审计五类计数全为零但 status=degraded 且带原因
    And 确认阶梯与应用证明全为零且未被升级

  Scenario: 查询不存在的原则返回 404
    Given 一个已安装 PD 的工作区
    When Owner 查询原则 pri-missing 的生产证据聚合
    Then 返回 404 principle_not_found

  Scenario: 套件目录——固定目录与 SYNTHETIC Gold 的 Gate 1 边界
    Given Examiner 研究引擎可用
    When Owner 查询 challenge 套件目录
    Then 返回 didactic-pair 与 calibration-core 两个固定套件
    And 每个套件标注 SYNTHETIC_OFFLINE 与 Gate 1 阻塞说明

  Scenario: 干净目标创建——冻结生产快照与真实 Pain 溯源
    Given 一个已安装 PD 的工作区，原则 pri-target 为 active 且无 RuleCode 耦合，Pain 溯源为 pain-e2e-1
    When Owner 以 calibration-core 套件创建 Study
    Then 返回服务端铸造的 EXM-C- 身份与 6 个计划配对
    And Study 目录冻结 production-snapshot.json（schema v1）
    And 冻结映射携带真实 painRefs=[pain-e2e-1]
    And 追加快照后冻结绑定校验仍通过

  Scenario: 耦合目标拒绝——无独立性证据不得声称 principle_only
    Given 一个已安装 PD 的工作区，原则 pri-target 绑定了运行时 live RuleCode 激活
    When Owner 为其创建 Study
    Then 返回 422 study_creation_refused 且未写入任何文件

  Scenario: 异步执行契约——202 受理、清单结算、零模型调用
    Given 一个 Owner 拥有的可写 Study 且预检通过
    When Owner 以 host-dry-run 模式请求运行
    Then 返回 202 与 RUN-C- runId
    And 运行在事件账本上结算为检查清单（含 stage_r_authorization、host_cli_probe、model_calls_zero）
    And 离线 Runner 未被启动（无 RUN_STARTED）

  Scenario: 单活运行——进行中的运行拒绝重复请求
    Given 一个 Study 存在未结算的 CONSOLE_RUN_ACCEPTED（受理进程仍存活）
    When Owner 再次以 host-dry-run 请求运行
    Then 返回 409 run_in_progress 且未追加新运行事件

  Scenario: 重启恢复——死进程的未完成运行结算为 RESULT_UNKNOWN 且绝不自动重试
    Given 一个 Study 存在未结算的 CONSOLE_RUN_ACCEPTED 且受理进程已死亡
    When 执行启动恢复扫描
    Then 追加 CONSOLE_RUN_ABANDONED 且 outcome=RESULT_UNKNOWN
    And 重复扫描不再产生新的放弃事件
    And 恢复后可受理新运行而废弃运行保持 ABANDONED

  Scenario: F2 授权门——未授权与错误绑定一律拒绝
    Given 一个可写 Study 不含 run-authorization.json
    When Owner 请求 f2-real-host 运行
    Then 返回 403 real_execution_not_authorized 且未追加运行事件
    Given 同一 Study 写入了状态非 APPROVED 的授权记录
    When Owner 请求 f2-real-host 运行
    Then 仍返回 403 且原因指明 APPROVED required

  Scenario: F2 授权门——绑定正确的 APPROVED 记录受理后本轮仍不执行（零模型调用）
    Given 一个可写 Study 写入了绑定本 Study 冻结套件的 APPROVED F2 授权记录
    When Owner 请求 f2-real-host 运行
    Then 返回 202 与 RUN-C- runId
    And 运行结算为 FAILED 且 outcome=F2_EXECUTION_NOT_ENABLED_THIS_ROUND
    And 事件账本无 RUN_STARTED（零真实模型调用）

  Scenario: 历史研究资产永远只读
    Given 历史研究资产 EXM-V09-ACC-ISO 存在于研究引擎
    When Owner 打开该 Study 的状态
    Then 返回 readOnly=true 与边界原因
