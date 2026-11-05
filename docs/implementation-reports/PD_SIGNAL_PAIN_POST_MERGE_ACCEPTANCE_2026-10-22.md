# PD 痛苦感知整改 — 合并后最终验收报告（2026-10-22）

> 验收对象：PR #2101（d00ea5c04）、#2102（765d5c4b8）、#2103（222d9e007）、#2104（792c37851）、#2105（974eae489，version-packages 物料化）
> 验收基线：**本地 main = origin/main = `974eae489`**（ff-only 同步，逐提交核对）
> 验收方式：只读优先——源码 diff 逐项核对 + 全新 worktree 干净构建 + 真实测试重跑 + 生产 dist CLI 端到端
> 结论：**GO（有条件）——适合进入真实宿主试运行；未发现 P0/P1 阻断风险**

---

## 1. 主干基线与工作区保护记录

- 验收开始时本地 main 落后于 origin/main；经 `git merge-base --is-ancestor` 确认可快进后执行 `git merge --ff-only origin/main`，本地 main 现为 `974eae489`（与 origin/main 同址）。
- 主工作区的 **14 项用户未跟踪资产在同步前后逐项一致**（`docs/plans/*`、`docs/specs/*`、`pri1012-review-fix/`、`packages/principles-core/tmp-test-ledger-*` 等），零覆盖、零清理。
- 功能验证与测试重跑在全新 worktree `D:\Code\_worktrees\principles\adhoc-20261022-post-merge-acceptance-acceptance`（分支 `ai/adhoc-20261022-post-merge-acceptance-acceptance`，即 `974eae489` 原样检出）内执行；该 worktree 无任何代码改动，验收后已释放 writer 认领。
- 本轮零代码修改、零 PR、零合并。唯一产出为本报告（未跟踪文档）。

## 2. 逐项审计闭环核对（对照实际 diff，非标题）

原始审计文件 `PD_SIGNAL_PAIN_AUDIT_2026-10-21.md` 至今未入库（多路径检索确认）；核对以整改任务上下文的逐项发现为意图权威，对合并后源码逐一验证：

| 项 | 合并后证据（源码位置 + 行为） | 状态 |
| --- | --- | --- |
| **P2-01** 降级分支同步健康写 | `signal-collector-host.ts`：全部健康计数走 `queueMicrotask`（countStage1Strong:241 / countStage2Invocation:283,499 / countStage2Queued:418 / countStage2Dropped:433-437）；降级分支注释（:312-315）与 `enqueueSignalConfirmation` 保持同步（可靠性）明示；回归测试 `signal-sync-path-regression.test.ts` 以可观测顺序锁死（`detectSync()` 返回时文件未写盘→微任务后计数正确）。**验收重跑 45/45（exit 0）** | ✅ 闭环 |
| **P2-02** Stage2 成本/健康可观测 | `signal-health.ts` 新增 stage2Invocations/stage2BatchSkipped（跨日归零、旧文件缺省读 0、类型错判损坏 :120）；调用点两处（realtime :283 + 批量 :499）；`config-doctor` 展示与积压分级（:520-522）。**真实 dist CLI 端到端**：`stage2 llm: invocations=7 batchSkipped=4` 正确呈现（见 §4） | ✅ 闭环 |
| **P2-03** 性能假设/轨迹持久化 | `signal-detect-sync.perf.test.ts` 可重复基准（4×300 迭代）；`SIGNAL_DETECTION_SYNC_PATH_BOUNDARIES.md` §3 recordUserTurn **维持现状**（三条理由 + NOT VERIFIED 标注 :60）、§4 基准数据与归因边界（NOT VERIFIED :85） | ✅ 闭环（见 §6） |
| **P2-04** 队列消费者耦合 | `correction-observer-service.ts:370-389` 启动门=correction_observer **或** signal_collector 任一开启；consumer-only 模式显式日志；:91 跳过计数化；doctor 分级端到端验证。词库优化仍由 correction_observer 独占（测试断言 dispatch 零调用） | ✅ 闭环 |
| **P3-01** WorkBuddy 不读共享词库 | `governance-signal-admission.ts:994` `resolveSharedCorrectionKeywordStoreForDetection` 新导出；:1059 admit 预检+准入共用共享 live store；`pd-hook.ts:301` adapter 预检同源。缺省参数保留 P0 四词行为（向后兼容） | ✅ 闭环 |
| **P3-02** 限流桶边界文档 | 边界文档 §2：内存 Map、**重启后配额重置语义**、canonical_pain_id 兜底与限流无关、不持久化的 P4 理由、已知接受风险（重启 N 倍超发 + doctor stage1Strong 可观测） | ✅ 闭环 |
| **P3-03** 跨宿主测试环境 | 根 `package.json:12` build 链含 `@principles/pd-cli`；`:13` `test:host-adapters` 入口；评审轮补充 `scripts/dev/lib/readiness.mjs` 注释修正（#2104 评审增量，良性）。**干净构建铁证见 §3** | ✅ 闭环 |
| **P3-04** WorkBuddy 仅间接覆盖 | `host-runtime/tests/governance-signal-admission.workbuddy-live.test.ts` 7 直接单测（门槛矩阵/安全门/降级/幂等）+ adapter 真实 hook 集成用例。**验收重跑 59/59（含既有 admission 套件，exit 0）** | ✅ 闭环 |

**8/8 全部闭环，无一项仅凭标题认定。**

## 3. 干净构建链验证（任务 8）

全新 worktree（零缓存、零既有 dist）从 `974eae489` bootstrap：

| 步骤 | 结果 |
| --- | --- |
| `npm run dev:worktree -- adhoc-20261022-post-merge-acceptance acceptance`（含 npm install + **根 build** + 就绪验证） | exit 0 |
| 根 build 链产出 `packages/pd-cli/dist/index.js` | **PRESENT**（修复前该路径在干净 worktree 中必缺） |
| `dev:worktree:ready --json` | `ok: true`，L1/L2/L3 全过，`leakage: []`（零主检出泄漏） |

**结论：构建链从干净状态正确工作，不依赖既有 dist。**（对照：整改前同流程 pd-cli dist 必缺 → 83 个本地测试假红。）

## 4. 目标测试与全套重跑（真实命令、退出码、计数）

全部在干净 worktree（`974eae489`）执行：

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | openclaw-plugin：`npx vitest run tests/core/signal-sync-path-regression.test.ts tests/service/correction-observer-batch-confirm.test.ts tests/service/correction-observer-service.test.ts tests/core/signal-health.test.ts` | **0** | **45/45 PASS** |
| 2 | `npm run test:host-adapters`（根 build → codex 全套 → workbuddy 全套） | **0** | Codex **303 PASS + 1 skip**（31 文件）；WorkBuddy **162 PASS**（13 文件，含真实引擎深链 BDD） |
| 3 | host-runtime：`npx vitest run tests/governance-signal-admission.workbuddy-live.test.ts tests/governance-signal-admission.test.ts` | **0** | **59/59 PASS** |
| 4 | host-runtime 全套 `npx vitest run` | **0** | **577/577 PASS**（49 文件） |
| 5 | openclaw-plugin 全套 `npx vitest run` | 1 | **2410 PASS / 4 FAIL**（失败定性见下） |
| 6 | pd-cli 全套 `npx vitest run` | **0** | **1979 PASS + 2 skip**（144 文件） |
| 7 | `npx vitest run tests/hooks/prompt-golden.test.ts`（单独复跑） | **0** | **7/7 PASS** |
| 8 | 性能基准 `npx vitest run tests/core/signal-detect-sync.perf.test.ts` | **0** | 4×300 迭代全过（数据见 §5） |
| 9 | 生产 CLI 端到端：`node packages/pd-cli/dist/index.js config doctor --workspace <临时工作区>` | **0** | 新指标行 + degraded 分级 + 旧格式向后兼容（见下） |

**openclaw 全套 4 个失败的逐一定性（均非本次整改回归）：**

1. `principle-application-ledger.steps.test.ts` ×2 — Windows 临时目录清理 EPERM（`fs.rmSync` 资源占用）；整改前基线上同文件同失败（有 2026-10-21 stash 对照证据）。**预存环境 flake。**
2. `template-anti-regression.test.ts` ×1 — GNU tar 对 worktree 路径双转义（`tar: D\:\\...: Cannot open`）；tar 在 PD 断言逻辑之前失败。**预存环境问题**，建议立单。
3. `prompt-golden.test.ts` ×2 — 210 文件高负载下的 5s 超时及连带 fixture 状态污染；**单独串行复跑 7/7 全过（命令 7）**。**负载型 flake，非内容回归。**

**生产 CLI 端到端（真实 dist，非测试桩）：**

- 构造合法健康文件（invocations=7, batchSkipped=4, pending=9）→ doctor 输出 `stage2 llm: invocations=7 batchSkipped=4` + `status: degraded` + reason `"backlog stands at 9 pending rows while batch confirmation was skipped 4 time(s) today"` + nextAction 指向 signal_collector 配置修复。✅
- 旧格式文件（无新字段）→ `status: ok`、新计数读作 0、既有计数原样。✅ 向后兼容经真实 CLI 成立。

## 5. 性能基准（合并后重跑）及局限

环境：Windows / node v26.7.0 / 干净 worktree / 300 迭代 + 50 预热每场景 / 隔离临时 workspace + 真实 trajectory SQLite + mock classifier（**零真实 LLM 调用、零生产数据**）。

| 场景 | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| S1 普通消息零命中（分类器不可用） | 10.007ms | 12.219ms | 12.565ms | 13.899ms |
| S2 高精度命中 | 10.023ms | 12.551ms | 14.762ms | 21.757ms |
| S3 歧义命中+降级入队 | 11.541ms | 13.120ms | 19.279ms | 22.281ms |
| S4 歧义命中+realtime 调用前段 | 9.435ms | 12.802ms | 15.748ms | 21.398ms |

**局限（如实声明）：**

1. 本轮为只读验收，**未做同会话修复前 A/B**——绝对值与整改期 A/B 记录（修复后 p50 8.0–10.2ms）存在 1–3.5ms 漂移，处于本机已观测的 run-to-run 方差带（±1.5–3ms，受并发负载/树状态影响），**不构成回归证据，也不重复充当修复收益证据**。
2. 修复的结构性行为（健康写离开同步调用栈、微任务后计数正确、SQLite 入队同步完成）由**确定性顺序断言测试**证明（命令 1，45/45），不依赖耗时测量。
3. 历史生产卡顿根因维持 **NOT VERIFIED**（边界文档 §4 原标注继续有效）。

## 6. 任务 7 单独核实：P2-03 与 P3-02

- **P2-03（轨迹持久化开销）**：✅ 完成。审计要求"分析 recordUserTurn 语义、仅证不破才可改"——交付为**分析后维持现状**（边界文档 §3：turnIndex 语义、user_turns 作为证据回链锚点表的四个消费面、空白消息假设不成立），并明确 NOT VERIFIED 标注（不声称生产卡顿由此引起）。这是该审计项的合规完成形态，非静默 DONE。可重复基准存在于 `signal-detect-sync.perf.test.ts`（含 recordUserTurn 真实 SQLite 写入路径）。
- **P3-02（限流桶重启语义及文档）**：✅ 完成。边界文档 §2 明确：进程内存态、**重启配额重置**（每小时上限=N×重启次数的已知接受风险）、重复 Pain 由 canonical_pain_id 兜底而与限流桶无关、为何不持久化（P4：不为启发式新增真理源）。文档随 #2101 入库主干。
- 附带发现（P3 装饰性）：§3 第 1 条 `排序/JION 语义` 拼写（应为 JOIN）。不影响语义，建议随下次文档触碰修正。

## 7. 三宿主剩余风险（试运行视角）

| 宿主 | 状态 | 剩余风险 |
| --- | --- | --- |
| OpenClaw | 信号路径整改全部落地；全套 2410 过（4 失败均定性为预存/flake） | ① 关键词检测在生产本就默认活跃，本次未改变其触发面；Stage2 计数自本版起才有基线，首日数字无环比参照。② 存量 signal_confirmations 积压在 classifier 恢复后开始消费（≤20 条/15min 有界 LLM 成本）——预期行为但首次出现真金支出。③ 限流桶重启重置语义（P3-02 已文档化）在频繁重启的网关上会放大 STRONG 量，靠 doctor stage1Strong 观测。 |
| Codex | 303+1 skip 全过；消费共享词库与 admission 链未变 | ingestion 路径本轮零改动；无新增风险。 |
| WorkBuddy | 162 全过（含深链 BDD）；共享词库接入 | ① **触发面扩大至「共享 store 当下 high+correction 全集」**——边界测试锁定来源门/续接门/前缀门/显式前缀/双 flag（默认 OFF），但真实 WorkBuddy 流量上的误报率无生产数据，**试运行必须先在单个测试工作区开启观察**。② earned-high 词质量依赖 OpenClaw 侧 TP/FP 闭环诚实性（FP 即降级，已有测试）。③ 零 LLM/零 transcript 契约有测试锁定，但建议试运行期用事件日志抽查 `workbuddy_keyword_pain_admitted` 实际触发词与预期词表一致性。 |

**跨宿主共性**：三宿主的"真实命中率/误报率"均无生产数据——这正是试运行要回答的问题，单元与集成测试不能替代（任务书同款原则）。

## 8. 未完成事项与推荐下一步

| 项 | 状态 | 建议 |
| --- | --- | --- |
| 原始审计文件入库 | 未完成（文件不存在于任何库） | Owner 提供原件后入库，对齐编号 |
| 3 个预存环境 flake（EPERM 清理 / tar 路径 / vitest 高负载超时） | 未修复（与整改无关） | 各立独立 issue；EPERM 建议 rmSync 重试或句柄延迟释放；tar 建议换 Node 内建解包 |
| 边界文档 JION 拼写 | 未修复（装饰性） | 随下次文档触碰修正 |
| 存量积压消费进度可观测性（oldest-pending age） | 未实现（#2102 follow-up 已记录） | 后续 doctor 增强 |
| 真实宿主试运行 | **未开始**（本轮为代码验收） | 见 GO 条件 |

## 9. 最终裁决：**GO（有条件）**

**当前代码适合进入真实宿主试运行。未发现 P0/P1 阻断风险。**

依据：8/8 审计项在合并主干逐项核实闭环（内容级，非标题级）；干净构建链从零状态正确工作；三宿主全套重跑真实通过（OpenClaw 仅存的 4 个失败全部定性为预存环境问题或负载 flake，各有独立复跑/基线证据）；生产 dist CLI 端到端验证新观测面与向后兼容；性能基准可重复且归因边界诚实。

**试运行条件（Owner 控制点）：**

1. WorkBuddy 侧先在**单个测试工作区**显式开启 `host.workbuddy` + `workbuddy_live_keyword_pain`（两者默认 OFF），观察期核对 `workbuddy_keyword_pain_admitted` 事件的触发词与共享词表一致性后再扩面。
2. OpenClaw 侧留意存量 signal_confirmations 消费带来的有界 LLM 成本（≤20 条/15min）；不接受时以 `signal_collector.enabled=false` 关闭消费（回到旧行为）。
3. 试运行判定使用 `pd config doctor` 的 signal-health 段（当日计数跨日归零——观察窗口按日切分）。

**不得将本 GO 误读为生产验收**：CI 绿与套件绿证明的是代码契约成立；真实宿主的命中率、误报率、成本曲线只能由试运行数据回答。本轮所有测试均使用隔离 workspace 与 mock classifier，未调用任何真实付费 LLM、未接触生产数据。
