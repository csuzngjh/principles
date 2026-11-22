# PD Service Host Phase 4 — 验收报告（2026-11-22）

- **工单**：PRI-1282（Phase 4 — OpenClaw Worker 解耦、Gateway AutoConsumer 迁移与 Parity）
- **分支**：`ai/PRI-1282-openclaw-worker`；基线 `0102002b9`（PR #2743 merge commit = origin/main）
- **PR**：见 Linear/PR 链接（提交序列 `3a3faf7d0..64490bc89` + 本 docs 提交）
- **结论**：**PASS_WITH_LIMITATIONS**（限制见 §8；生产 marker 翻转维持平台门禁）

## 1. 提交序列

| SHA | 内容 |
|---|---|
| 3a3faf7d0 | Stage 0/1：源码审计 + 技术设计增量（CAS 阶段归属修正） |
| 43e60e429 | install-layout：§8.4 CAS/transition 原语 + 只读投影（18 用例） |
| 22d9f683f | installer/update：install.json 写者统一走 CAS 锁（ERR-168，3 用例走真实调用路径） |
| 4ef25bc7d | openclaw-plugin：`openclaw-worker` 子路径（cycle/readiness/liveness）+ Gateway marker 门禁与 quiesce（21 用例含运行时 parity） |
| ae0026a7c | pd-cli：`pd openclaw worker`、managed/shadow 宿主集拆分、`pd service handover/rollback` 编排、双进程 CAS 竞争测试 |
| b62a2fc39 | managed 派发执行已交接 openclaw workspace 的回归（13 用例） |
| 64490bc89 | 修复：handover 编排等待必须 ref'd（Stage 9 发现的 exit-0-空输出缺陷） |

## 2. 测试

| 套件 | 结果 |
|---|---|
| install-layout 全量（含新增 transition + 双进程竞争） | 新增 19 用例全绿（本机 Windows 环境预存 7 例 POSIX 夹具失败 + symlink EPERM——CI=ubuntu 全绿，与本 PR 无关，已逐条核对为基线即有） |
| create-principles-disciple ERR-168 共存 | 3/3 |
| openclaw-plugin service 全量 | 148/148（127 既有 + 21 新增） |
| pd-cli service-host 全量 | 469 通过 / 1 失败（shadow M1 symlink EPERM——Windows 权限环境预存，CI 绿） |
| pd-cli 命令契约（openclaw worker / handover 注册） | 8/8 |
| pd-cli handover/rollback/managed 派发 | 13/13 |

## 3. CI

PR 创建后运行仓库必需检查（见 PR 状态；本报告不预先宣称绿）。本机已过：全部涉及包 tsc --noEmit、eslint（改动文件零告警）、根 build。

## 4. 真实安装态验收（Stage 9，隔离 sandbox `D:\Code\.pd-tmp\principles\pri1282-acceptance-home`）

**安装形态**：由 worktree 构建产物组装的真实 install-layout——`<home>/.pd/runtime/pd-cli/dist/index.js` 为 canonical CLI 入口（`resolveActiveReleaseCliEntry` 真实解析），node_modules 为完整依赖树 + 四个 workspace 包的**编译 dist**（无 .ts 源参与运行）；manifest + active.json 为合法记录。**未走** npm-pack→installer 全发布管线（release reproducibility 由既有 CI 于 PR diff 覆盖）——如实用记录。

| 场景 | 结果 | 证据 |
|---|---|---|
| A：Gateway 不运行，worker 独立服务授权 workspace | **PASS** | 安装入口 `openclaw worker --readiness` 全 checks ready（含真实 declaration/trajectory/凭据检查）；交接后 `--once` mode=ready（真实 state.db 写入） |
| B：Gateway 运行中的 shadow parity 对比 | **NOT_VERIFIED-live**（本机未启动真实 OpenClaw Gateway 进程）；代码级 parity 已由运行时 ports parity 测试钉住（catalog/semantics/hostKinds/事件流一致，仅 owner 归因不同） |
| C：完整 handover（隔离环境） | **PASS** | 安装 CLI `service handover` ok:true；六步证据链 binding→begin→readiness→quiesce_ack→cas_flip→worker_cycle；marker gen2 service_host_owned；workspace 原子注册；write-once 证据文件 |
| D：强杀 worker 后恢复 | **PASS** | SIGKILL 中断周期（exit signal=SIGKILL）→ 下一触发周期 exit 0 mode=ready，state.db 完整，liveness 正常收口 |
| E：rollback | **PASS** | `service rollback` ok:true（JSON + 证据落盘）；marker gen4 legacy_owned（4 次迁移单调递增）；回滚后 worker 直跑被拒（paused）——无双消费者；Gateway 未运行 → gatewayResumption=not_verified（诚实记录，恢复由 start 门禁保证，插件测试已验证 RESUMED 路径） |
| F：多 workspace 并存（一个迁移、另一个保持 legacy） | **PASS（代码级）** | install-layout 隔离测试（"one workspace transition never touches another"）+ managed 准入矩阵；未在 sandbox 摆第二 workspace（同构路径，无新代码面） |

**验收期间发现并修复的真实缺陷**：rollback 编排的 unref'd 等待使 Node 在事件循环清空时带悬挂 Promise 退出（迁移已落盘、stdout 空、exit 0）——库级复现（unsettled top-level await）+ 修复（ref'd）+ sandbox 复验全链路 JSON/证据齐全（64490bc89）。

## 5. Parity 结果

- **运行时 ports parity（测试钉住）**：worker 与 Gateway `runConsumerCycle` 交给共享周期的 hostToolCatalog/toolSemantics/hostKinds 完全一致；emitEvent 同为 SystemLogger 模块（交接后事件流连续）；唯一差异 owner/logLabel（诚实归因）。
- **业务规则零分叉**：worker 不含第二套候选选择/诊断/内化/恢复判断（全部为共享实现调用）。
- **调度对比**：见 `PD_SERVICE_HOST_PHASE4_SCHEDULING_COMPARISON.md`（固定 120s 决策 + 真实策略重放量化 + 语义变化披露）。

## 6. CAS 并发证据

双进程（真实子进程 + 启动栅栏）竞争同一 workspace 的 begin_handover：恰一胜者（changed=true），败者结构化拒绝（lock_busy/operation_in_progress），manifest 复验可解析、状态正确（install-layout `tests/background-execution-transition.process.test.ts`）。

## 7. Quiesce 证据

`pd.gateway-quiesce.v1`：绑定 workspace+operationId+generation；in-flight 有界等待（10min）+ 诚实 `in_flight_timeout`（不伪造取消）；挂起周期无法 ack（诚实无证据=交接 fail-closed）；start 拒绝路径同样写 ack（新进程证明）；慢速 watch 对新操作身份重写 ack。插件 9 用例覆盖（fake timers 驱动真实状态机）。

## 8. 已知限制（不隐瞒）

1. **生产 marker 翻转维持平台门禁**（指令 §11.3）：Windows 真实安装态 Scheduler ≥1h 观察窗（Phase 3 遗留）与 macOS/Linux 真机验证未完成前，不对生产 workspace 执行 owner 翻转。本 PR 交付代码/测试/隔离环境验证。
2. **场景 B（运行中 Gateway 的 shadow parity）**未在本机执行真实 Gateway 进程——NOT_VERIFIED-live。
3. **sandbox 安装形态**为构建产物组装（非 npm-pack→installer 全管线）。
4. **Gateway 全程未运行时 handover fail-closed**（无 ack 写者 → BLOCKED，nextAction 指引启动 Gateway）——设计使然，非缺陷。
5. adaptive timer 语义变化（突发清空 ~2× 慢、失败退避为固定 120s 重试）已量化披露；无既有 SLA 证据，未做 interval 调优。
6. 长文本写入曾出现一次标识符大小写损坏（runOpenClaw→runOpenclaw）——已被 tsc/测试捕获修复；该失效模式记录在案。

## 9. 平台验证情况

Windows（本机）：上述全部。macOS/Linux：未接触真机（Phase 3 同款 NOT_VERIFIED）；纯逻辑模块（transition/worker cycle）为平台无关代码 + POSIX 路径用例在 CI linux 覆盖。

## 10. 最终结论

**PASS_WITH_LIMITATIONS**——Phase 4 退出条件在隔离环境与代码/测试层面全部满足：OpenClaw workspace 可由 Service Host 独占驱动（A/C/D），可回滚（E），无双消费者（各门禁+测试），Codex/WorkBuddy 路径回归绿（469 通过套件）。生产 cutover 待平台门禁（Phase 5 范畴）。
