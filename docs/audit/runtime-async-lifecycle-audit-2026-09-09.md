# Runtime Async Lifecycle 审计报告（PRI-680）

- 日期：2026-09-09；基线 `origin/main` @ 5071308c8
- 方法：全仓 token 扫描（setInterval / setTimeout / while / for await / scheduler /
  worker / consumer / poll / watch / loop / tick / heartbeat 等）→ 逐个人工源码核对
  → 高风险循环补 characterization tests（本 PR）
- 结论一句话：**PR #1514 之后的存量循环里没有新的"必死"链条——唯一的结构性死亡
  向量已由既有设计消化；真实风险集中在 Companion worker 注册表的永久降级（设计使然
  但可观察面不足）与 EvolutionWorker 的 stop/重启语义（默认关闭所以不易察觉）。**

## 1. Inventory（长期运行循环全册）

| # | 组件 | 入口 | 机制 | 分类/接线 | 风险 |
|---|---|---|---|---|---|
| A1 | InternalizationAutoConsumerService | openclaw-plugin/src/service/internalization-auto-consumer-service.ts:70 | 递归 setTimeout（120s） | 管道/生产，默认开 | **低（PR #1514 已修+有测试）** |
| A2 | Codex worker 守护循环 | pd-cli/src/commands/codex-worker.ts:162 | while+await+sleep | 管道/生产（Companion 拉起） | **低（同上）** |
| A3 | EvolutionWorkerService 心跳 | openclaw-plugin/src/service/evolution-worker.ts:607 | 递归 setTimeout（默认 15min） | 管道（legacy evolution），flag 默认关 | **中（stop/重启缺陷，见 §3）** |
| A4 | 共享消费周期体 | host-runtime/src/internalization-consumer-cycle.ts:233 | 单次有界周期（非循环） | 管道/生产 | 低 |
| A5 | SplitDiagnosticianRunner 阶段重试 | principles-core/.../split-diagnostician-runner.ts:342 | 有界 while（cap 10） | 管道/生产 | 低 |
| A6 | **Companion WorkspaceWorkerRegistry** | pd-companion/src/lib/workspace-workers.ts + main.ts:316 | setInterval 60s 对账 + 重启梯子（1s/2s/4s ×3） | 管道邻近/桌面生产 | **高（可观察性，见 §2）** |
| B1 | CorrectionObserverService | openclaw-plugin/src/service/correction-observer-service.ts:164 | 递归 setTimeout（15min） | 独立/生产（config 门控） | **中低（隐性韧性，见 §4）** |
| B2 | Companion 轮询/更新检查 | pd-companion/src/main/main.ts:583-695 | setInterval + void 异步 | 独立/桌面 | 低 |
| B3 | EventLog flush 定时器 | openclaw-plugin/src/core/event-log.ts:506 | setInterval 30s（unref） | 独立/生产 | 低 |
| B4 | EvolutionEngine 存盘重试 | openclaw-plugin/src/core/evolution-engine.ts:464 | 自重排 1s 一次性 | 独立/生产 | 低中（持久故障下 1s 无界重试，但有日志） |
| B5/B6/B7 | session 去抖 / telemetry 导出 / Console UI 轮询 | 各处 | 有界/一次性/React effect | 独立 | 低 |

已排除（非循环）：诊断重试 CLI（cap 10）、rulehost 管线（maxStageRetries）、
HTTP body `for await`、readline `for await`、bounded LLM poll 等。

## 2. A6 — Companion worker 注册表（最高风险，设计使然）

**四项审计**：
- A 失败存活：梯子 3 次后**永久降级**——`scheduleRestart` 预算耗尽后 entry 留在
  map，`sync()` 无法重置（有意设计：防无限 crash loop；有回归测试钉住
  workspace-workers.test.ts:125"重启耗尽后 sync 不重置预算"）；
- B 可观察性：**仅一行 `workspace_worker_degraded` 日志**——无托盘/通知/周期性
  重试升级面；恢复路径=manifest 移除重加或重启 Companion（人工）；
- C 停机正确性：stopAll 清 pending 重启 + kill 全部（有测试）；
- D 重复启动：canonical path 键控 Map，别名折叠（有测试）。

**判定**：行为正确性已被测试充分钉住；缺陷等级取决于产品视角——对 Episode 002
这类长实验，worker 静默降级 3 次即断管道且 Owner 无感知。**Pipeline 邻近 + 桌面
产品行为变化 → 本 Sprint 只记录**（新工单，见 Linear 链接），不动代码。
注意：该组件**正在监督 Episode 002 的 codex workspace worker**——实验期间若发生
3 连崩，现象是管道静默停摆，此报告即为排查线索。

## 3. A3 — EvolutionWorker（默认关闭的 legacy evolution 路径）

**四项审计 + characterization tests**（本 PR
`tests/service/evolution-worker-lifecycle.test.ts`，5/5 绿）：
- A 失败存活：**好**——cycle body 全 catch + reschedule 在 catch 之外（测试 A/B）；
- **证伪一个假设**：cycle 失败 + worker-status 写盘同时失败时链**仍存活**
  （writeWorkerStatus 自吞错误，:542-551）——不存在"报告路径失败→静默死亡"向量
  （测试 F）；
- B 可观察性：logger.error + worker-status.json（含错误清单），达标；
- C 停机正确性：stop 清 timer ✓（测试 C）；
- D 重复启动：同 workspace 幂等 ✓（测试 D）；**缺陷①**：stop() 不清
  `_startedWorkspaces` → stop 后同 workspace start 被静默跳过，重启需新进程
  （测试 E 钉住现状）；**缺陷②**：模块级单变量 `timeoutId` 被多 workspace 互覆，
  stop() 只能停最后启动者（源码证据 :73/:749-750，未测——单例模块级状态难以
  在不重构的情况下干净表征）。

**判定**：flag 默认关、legacy 路径 → 两个 stop/重启缺陷**不修**（新工单记录），
等待 evolution 路线的去留决策（若退役则随代码删除）。

## 4. B1 — CorrectionObserver（独立服务，config 门控）

- 稳态 `runCycle` 本体无 try/catch（:206-212），**但**被调函数
  `runCorrectionObserverCycle` 整体包在 try/catch 内（:82 起）——结构上今天不可能
  reject；启动路径已有 `.catch`+重排（有先行者意识到该风险）；
- 风险性质：**潜在**而非现实——未来对 cycle 体的任何改动（把某步移出 try）都会
  暴露稳态静默死亡面；且无 PRI-655 式"注入拒绝→链存活"测试；
- **判定：不修**。修复需要注入拒绝的测试 seam（P7：为假想变化加 seam 违规），
  而 cycle 语义改动属 Episode 002 冻结区外围。已在 PRI-680 工单记录：下次触碰
  该文件时补齐对称 try/catch + 链存活测试。

## 5. 总结与处置矩阵

| 发现 | 等级 | 处置 |
|---|---|---|
| Companion worker 永久降级仅一行日志 | 高（可观察性） | 新 Linear 工单（产品决策：托盘通知/周期性升级重试） |
| EvolutionWorker stop 不清 started 集 | 中 | 新 Linear 工单（随 evolution 路线决策） |
| EvolutionWorker 模块级共享 timer handle | 中 | 同上工单 |
| CorrectionObserver 稳态无兜底 catch | 中低（潜在） | PRI-680 工单记录，下次改该文件时带测试补 |
| EvolutionEngine 存盘重试无界 1s 节奏 | 低中 | PRI-680 工单记录（加退避即可，独立小修） |
| A1/A2/A4/A5/B2/B3/B5-B7 | 低 | 无需动作 |

**Episode 002 冻结排除项**：以上全部未在生产代码中修复——A6/A3 属管道邻近，
B1/B4 属低紧迫独立项；本 Sprint 对生产代码的净改动为零（仅新增测试与文档）。
