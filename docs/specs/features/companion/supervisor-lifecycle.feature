@companion @supervisor
Feature: Companion 控制台服务监管生命周期

  对应 PRI-526/PRI-631 锁定决策:companion 通过 `pd console open --json --no-browser`
  拉起(或附着)控制台服务；仅在没有有效 PD_CONSOLE_TOKEN 时追加 `--no-auth`。
  token 只由子进程环境继承，不进入 argv、日志或 launch JSON。配置 token 时，
  只有 health 明确报告 authenticated 且 token 验证成功的实例才允许复用。
  行为契约覆盖:
  - fresh spawn(有 serverPid)→ managed 模式;复用已有实例 → attached 模式且不拥有进程
  - 快速连续崩溃按 1s/2s/4s 退避重启,超过 3 次进入 server_crash_loop 降级
  - 稳定运行(≥60s)后崩溃视为新一轮故障,重新计数
  - 主动退出(用户退出/手动重启)不触发自动重启

  Background:
    Given 一个使用假时钟的 ConsoleSupervisor

  @pri-526 @managed-mode
  Scenario: fresh spawn 带 serverPid 进入 managed 模式并拥有进程
    When supervisor 启动且控制台以 serverPid 4242 完成启动
    Then supervisor 状态为 running 且 mode 为 managed
    And supervisor 拥有该进程

  @pri-526 @attached-mode
  Scenario: 复用外部实例进入 attached 模式且不拥有进程
    When supervisor 启动且控制台返回 reused 结果
    Then supervisor 状态为 running 且 mode 为 attached
    And supervisor 不拥有该进程

  @pri-526 @crash-loop
  Scenario: 快速连续崩溃 3 次退避重启,第 4 次进入 crash-loop 降级
    When 控制台启动成功后立即崩溃
    Then 安排 1000ms 后重启
    When 重启成功后再次立即崩溃
    Then 安排 2000ms 后重启
    When 第三次重启成功后再次立即崩溃
    Then 安排 4000ms 后重启
    When 第四次重启成功后再次立即崩溃
    Then supervisor 进入 server_crash_loop 降级且不再安排重启

  @pri-526 @stability-window
  Scenario: 稳定运行超过 60 秒后的崩溃重新计数,不触发 crash-loop
    When 控制台启动并稳定运行 61 秒后崩溃
    Then 安排 1000ms 后重启(新一轮故障)

  @pri-526 @intentional-stop
  Scenario: 主动退出后服务进程退出不触发自动重启
    When 控制台启动成功
    And supervisor 标记主动停止
    When 服务进程退出
    Then supervisor 状态回到 idle 且不再安排重启
