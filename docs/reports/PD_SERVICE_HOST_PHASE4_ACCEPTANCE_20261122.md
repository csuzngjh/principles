# PD Service Host Phase 4 — 验收报告（2026-11-22）

- **工单**：PRI-1282（Phase 4 — OpenClaw Worker 解耦、Gateway AutoConsumer 迁移与 Parity）
- **分支**：`ai/PRI-1282-openclaw-worker`；基线 `0102002b9`（PR #2743 merge commit = origin/main）
- **PR**：https://github.com/csuzngjh/principles/pull/2749
- **结论**：**PASS_WITH_LIMITATIONS**（限制见 §8；生产 marker 翻转维持平台门禁）

## 1. 提交序列

| SHA | 内容 |
|---|---|
| 3a3faf7d0 | Stage 0/1：源码审计 + 技术设计增量（CAS 阶段归属修正） |
| 67f6c2ff3 / 1cf193220 | CI round 1：registry 窗口 feature-detect、门禁测试 seam、runtime-writers allowlist、杂散报告清理 |
| e0374f6c6 | CI round 2：changeset 补 create-principles-disciple（N-3） |
| 9399f2126 | CI round 3：rc-2 类型守卫替换 5 处 as 断言 |
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

**最终 head `9399f2126`（round 3）：全部 checks success**——含 Verify Merge Gate（N-3 changeset 守卫、check-runtime-contract 0 违规、error-handbook、repo-hygiene、全部 typecheck/build/test 子门）、CodeQL、全部包测试 lane、packaged-install registry-parity smoke、e2e。

收敛过程（三轮，全部根因归档）：
1. **round 1（67f6c2ff3）**：a) `create-principles-disciple` 测试 typecheck——我的夹具用了非法 channel 字面量 `beta`（合法集 `stable|candidate`）；b) 插件既有 timer-chain 测试——新 §8.4 门禁的**真实** reader 在 CI 临时目录上 fail-closed（设计使然），在该套件的 import seam 上 mock 至 legacy 默认（门禁自身行为由专项套件覆盖）；c) `check-runtime-writers`——三个新写盘点（CAS 锁目录、worker liveness、handover 证据）按 ERR-146 以验证过的理由加入 allowlist；d) packaged-install smoke——registry 解析的旧版 install-layout 无新导出 → installer/update 侧对 `withInstallManifestWriteLock` 做 feature-detect（cohort 发布前的释放窗口保持既有行为）。
2. **round 2（e0374f6c6）**：N-3——installer 锁接线是 create-principles-disciple 的 release-affecting 改动，changeset 补第五个包（minor）。
3. **round 3（9399f2126）**：`check-runtime-contract` 5 个 ERR-001（JSON 解析点 `as` 断言）——全部改为真类型守卫/字段级验证（含 evidence 文档的完整 parse 函数：schema/kind/steps/ownership + 内嵌 record 构造器）；另有杂散 vitest json 报告清理 + `.vitest/` ignore 规则（1cf193220）。

本机已过：全部涉及包 tsc --noEmit、eslint（改动文件零告警）、根 build、runtime-contract/runtime-writers 守卫（提交树）。

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

---

## 11. 第四轮整改（2026-11-23，评审指令：跨进程锁 / Gateway 消费者互斥 / Evidence 恢复）

**最终 HEAD：`37aa69cf2`**（PR #2749 `ai/PRI-1282-openclaw-worker`）。

### 11.1 提交序列

| SHA | 内容 |
|---|---|
| 911fcf164 | §2/§4：CAS 锁原子互斥——SQLite 仲裁门（`BEGIN IMMEDIATE`+busy_timeout）串行化获取/过期回收/释放；service-run-lock stat 失败 fail-closed |
| d05abba75 | §3：Gateway consumer lease 生命周期——lease 需 instanceId，start/stop/quiesce 绑定进程实例，杜绝重启假 ACK |
| c3654d19f | §5–§9：--resume `no_resumable_operation`/`operation_id_mismatch`、abort 校验 opId+generation、completed 操作不可重入；evidence/intent EEXIST 全身份比对；CAS 后最终 ownership 验证；rollback intent 先持久化 + --resume 仅证据续跑；调度 enable/disable 与交接共享 run lock 串行化 + CAS 前锁内复查 |
| 37aa69cf2 | §9–§12 收尾：生命周期操作 nextAction；readiness 全进程字段+逐 kind 凭证+workspaceDir 绑定；ACK canonical realpath + 别名 fail-closed；workbuddy manifest 合并/裁剪全部锁内 + tmp+rename，缺锁导出 fail-closed |

### 11.2 测试

| 套件 | 结果 |
|---|---|
| pd-cli workspace-handover | 31/31（含 r4 新增 5 例：resume 身份、intent 恢复、最终验证、调度复查、证据身份） |
| pd-cli service-host / plugin service / install-layout transition | 91/91（三套） |
| create-principles-disciple 全量 | 1491 通过；本地 3 例环境性失败（gateway-notice mock、registry 探测）——改动前同样失败，与本轮无关，CI 同名 lane 全绿 |
| 多进程确定性测试 | install-layout 双进程 CAS 竞争（恰一胜者）+ CAS SQLite 门并发用例；无随机 sleep |

### 11.3 CI（最终 HEAD 37aa69cf2）

26 checks 全绿（含 Verify Merge Gate、CodeQL、pd-cli/Windows、packaged-install smoke、e2e）；CodeRabbit skip。PR mergeable 无冲突。

### 11.4 Review Threads

PR #2749 共 14 条 Devin Review 线程全部 ✅ resolved（本轮新增关闭 3 条：阶段任务误拒交接→§10；路径别名交接超时→§11；清单锁覆盖→§2）。

### 11.5 真实宿主验收

| 场景 | 状态 |
|---|---|
| 场景 A/C/D/E（Stage 9 sandbox 真实安装态） | 既有结论不变（PASS），本轮改动为编排/锁层加固，不重跑 |
| **真实 Gateway 进程 quiesce/消费互斥验收** | **NOT_VERIFIED** — 本机无真实 OpenClaw Gateway 进程可运行；互斥保证由 lease 语义 + 双进程 CAS 测试 + 插件门禁用例覆盖，无模拟 ACK 代替 |
| npm-pack→installer 发布管线 + macOS/Linux 真机 | NOT_VERIFIED（沿 §8/§9 既有声明） |

### 11.6 剩余风险

1. CAS SQLite 门依赖 `node:sqlite`（Node≥22.5 内置）；旧运行时尚未移除，如宿主 Node 过旧锁获取将 fail-closed 报错而非静默放行——按设计。
2. Gateway 真实进程下的 lease/ack 联调未验（上表 NOT_VERIFIED）——属 Phase 5 cutover 前置项。
3. `no_resumable_operation` 对"操作已完成但操作者误用 --resume"返回结构化的不可续跑而非静默成功——行为语义变化，已在证据字段披露。
