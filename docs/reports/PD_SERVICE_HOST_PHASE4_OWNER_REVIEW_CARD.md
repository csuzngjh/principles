# Owner Review Card — PD Service Host Phase 4（PRI-1282）

1. **Problem**
   OpenClaw workspace 的后台消费生命周期由 OpenClaw Gateway 进程内的 AutoConsumer timer 拥有：Gateway 不运行=无消费；无原子交接；无双消费者证明；无独立 worker。

2. **Before**
   `InternalizationAutoConsumerService` 经 hook/service 注册 per-workspace timer chain；adaptive 调度状态仅存 Gateway 内存；`stop()` 只清 timer；marker 门禁在 OpenClaw 侧缺失（SPEC §8.4-5 自述缺口）；CAS 写路径未实现（§8.4-10 自述缺口）；`pd openclaw worker` 不存在。

3. **After**
   - 独立有界 worker：`pd openclaw worker --once|--readiness`（插件包 `./openclaw-worker` 子路径，复用共享周期/诊断/证据端口，带 liveness 与 §8.4 所有权门禁）。
   - Gateway：start/tick/post-cycle 三点 marker 门禁（fail-closed）+ quiesce 持久化确认 + 停摆槽位慢速 watch（rollback 免重启恢复）。
   - §8.4 交接：`pd service handover|rollback` 编排 + install-layout CAS 原语（跨进程锁/generation fencing/operationId 幂等/原子 rename）。
   - installer/update 全量写者与 CAS 同锁（ERR-168）。

4. **Existing mechanism reused**
   共享 `runInternalizationConsumerCycle`/`runPendingDiagnosticianOnce`（零业务分叉）；`createWorkspaceBehaviorEvidencePort`（codex 生产同型证据端口）；工具常量 SSoT 不动（guard 未改，worker 从同一定义导入）；SystemLogger 同模块（事件流连续）；`collectHostWorkspaceClaims`/`findForeignWorkspaceOwner`（不新增 workspaceBindings 权威）；manifest 既有 `backgroundExecutions` schema 与注册路径；Phase 1-3 全套锁/status/scheduler/dispatch。

5. **Complexity Delta**
   - 新持久化真相源：**无**（marker=manifest 既有字段；ack/handover 证据=过程证据，非所有权权威；liveness=worker 运行时证据）。
   - 新持久化状态：无（除上述证据文件）。
   - 新子系统/后台进程：**无**（无常驻循环；Gateway watch 是原 timer 槽位的停摆形态）。
   - 新公共抽象：`principles-disciple/openclaw-worker` 子路径、install-layout transition 原语 + 所有权只读投影、两个 CLI 命令、`MANAGED_WORKER_HOST_KINDS`、`pd.gateway-quiesce.v1`/`pd.service-handover-evidence.v1` 证据 schema（均单一定义、多消费者）。
   - 新 feature flag：无。新跨包依赖：无（pd-cli→principles-disciple 为既有边；plugin→install-layout 为 host-runtime 既有传递边显式化）。
   - 新 host 特定行为：openclaw worker/门禁（宿主边界内）。
   - 回滚：`pd service rollback`（已实测）或 marker 手工回写 + 版本回退。

6. **Design reason**
   最小闭环=把"谁有资格消费"从进程存活改为持久 marker，业务执行层零改动；CAS 原语归属 install-layout（manifest SSoT、零依赖包）供 Phase 4/5 共用；工具语义不经手（编译常量同一导入）；证据端口复用 host-runtime 只读实现避免 TrajectoryRegistry 进程生命周期。

7. **Verification**
   测试：install-layout +19（含双进程竞争）、plugin +21（含运行时 parity）、pd-cli +21（handover/rollback/managed 派发/CLI 契约）、installer ERR-168 +3；全部既有套件绿（仅本机 Windows 环境预存失败，CI=ubuntu）。真实安装态：sandbox（编译 dist 组装、canonical 入口解析）场景 A/C/D/E 全 PASS（含 SIGKILL 恢复、4 次迁移 generation 单调、回滚后拒跑）。发现并修复 1 个真实缺陷（unref'd 等待导致 rollback 静默 exit 0）。

8. **Risk**
   - 运行中 Gateway 的 live parity（场景 B）未跑真实 Gateway 进程。
   - 突发积压清空 ~2× 慢（量化披露，上界一个周期）。
   - marker 手工编辑损坏 → fail-closed 阻塞（需人工修复 manifest）——设计语义。
   - Phase 5 复用原语时若绕过编排顺序（先停旧消费者后 readiness）会产生无消费者窗口——已在 SPEC/顺序文档固定。

9. **Rollback / recovery**
   已实测：`pd service rollback`（停 SH 触发检查→CAS 回 legacy→观察 Gateway 恢复）；worker 直跑 legacy workspace 被拒；崩溃恢复=持久 state+operationId+generation 确定性续跑（verify-only continuation 已实现）；回滚失败保留 rollback_pending（fail-closed）。

10. **Follow-ups（刻意不做）**
    - Phase 5：Codex/WorkBuddy 交接（复用本原语）、Companion Worker Registry 退役、AC-01~13 总验收。
    - 失败退避复用 nextConsumerDelay 纯函数（如失败风暴成为现实）。
    - Windows Scheduler ≥1h 观察窗与 macOS/Linux 真机（平台门禁遗留）。
    - 场景 B live parity（需真实 Gateway 环境）。
