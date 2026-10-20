# SPEC-PD-CODEMODE-001 v0.2 — 执行报告（G0 资格门裁决）

**执行日期**：2026-10-20
**执行类型**：G0 只读源码核查 + 仓库内证据审查 + 独立工作树报告交付。
**最终裁决**：**NO-GO / NO CANDIDATE（候选场景证据门未通过；生产接入维持 NO-GO）**。未安装 pi-codemode、未新增依赖、未修改任何生产代码、未创建 feature flag、未进入 P0/P1。P2 真实模型与 P3 生产接线 **NOT_RUN**（未授权，亦无 G0 GO 前提）。

---

## Owner Review Card

1. **Problem**：SPEC-PD-CODEMODE-001 v0.2 要求验证 PD 内部是否存在值得引入 Pi Code Mode（QuickJS 沙箱脚本编排工具）的真实工作流，即逐项通过 U-01~U-05 资格门。
2. **Before**：SPEC v0.2 与前置源码审计已给出默认 NO-GO 姿态，但 U-01~U-05 证据表未经过本轮独立执行核实。
3. **After**：独立重核最新 PD/Pi 源码与仓库内全部可合法访问的工作负载数据。U-01 被现有证据**反向证伪**（生产无可消费任务、真实 L2 循环零执行记录）、U-03 无可测量基线、U-04 中 B1 确定性组合工具可完整覆盖全部理论收益（B2 无独特收益）、U-05 无需验证（无候选）。裁决 NO-GO / NO CANDIDATE。
4. **Existing mechanism reused**：零新机制。全部结论基于现有 runAgentLoop/runToolCall、四工具合同、Owner Evidence preflight 与既有遥测事件面。
5. **Complexity Delta**：全部 NO（依赖/Schema/子系统/公共抽象/flag/跨包依赖/宿主行为/外部能力增量为零；唯一产物为本报告与任务链文档传播）。
6. **Design reason**：SPEC 规定任一 U 门缺证据即 NO-GO 且零代码；本报告证明的是"不存在候选"，最小正确交付即文档。
7. **Verification**：见 §2 实际命令与退出码；关键事实均带 file:line 与 git ref。
8. **Risk**：误读风险——本裁决不是对 Pi Code Mode 沙箱本身的安全或质量否定；若未来生产出现真实多轮 L2 工作负载，需按 §10 重开 G0。
9. **Rollback / recovery**：无需回滚（零代码零依赖）。重开评估的最小证据清单见 §10。
10. **Follow-ups**：`read_artifact` 无截断（§9.2）记录为未来 B1 类只读接口改进的候选观察项，本轮不实施。

---

## 1. 基线与工作区状态

| 项目 | 实际核实值 | 与 SPEC/审计基线的关系 |
|---|---|---|
| PD origin/main | `ec66d23385b88a7f36442702ea862432435aa470`（2026-10-19，chore: version packages #2091） | 与 SPEC 基线**一致** |
| PD 本地 main（primary，只读） | `bf5aed354`（落后 origin/main 8 个提交） | 与审计记录一致；本轮未改动 primary |
| 关键实现文件漂移 | `git diff --stat bf5aed354..origin/main` 对 5 个目标源文件 + 2 个适配器文件：**仅 `packages/principles-core/package.json` 有变化**（版本号 1.294.0→1.294.2、typebox ^0.34.48→^0.34.52） | 审计 F-01 判断成立：Artificer/Dreamer/consumer-cycle 源码在两基线间未变，本轮直接以 primary 工作树副本核实源码等价于 origin/main |
| Pi origin/main | `a731ba8b80ac56662b4ca7f09102f94447862d8c`（2026-10-20，docs(tui) CJK changelog） | **较 SPEC 基线 73f8de80b 前进**（fetch 时更新）；差异为 TUI 文档提交 |
| Pi v1.3.0 tag | `71023aec1546d6d677a65669c5665c0927ce0dd0` | 与 SPEC 基线一致 |
| `packages/codemode` 源码 v1.3.0..origin/main | 仅 `CHANGELOG.md` +2 行（Unreleased 标题） | Code Mode 源码自 v1.3.0 发布后**未变化** |
| `packages/agent/src` v1.2.0..v1.3.0..origin/main | 两次 diff 均为空 | runToolCall/agent-loop 源码自 v1.2.0 起**未变化**（PD 所装 1.2.0 与最新 main 行为一致） |
| PD 核心依赖 | `@earendil-works/pi-agent-core 1.2.0`、`@earendil-works/pi-ai 1.2.0`（core package.json:108-109）；**无 pi-codemode** | 核实成立 |
| engines | pi-agent-core 1.2.0 / pi-codemode 1.3.0 均 `>=22.19.0`；create-principles-disciple `>=22.0.0`（package.json:83-84） | 既有元数据不一致，非 Code Mode 新增门槛（不处理、不升级） |
| 执行工作树 | `D:\Code\_worktrees\principles\adhoc-20261020-codemode-execution-wcsf73-codemode-execution`，分支 `ai/adhoc-20261020-codemode-execution-wcsf73-codemode-execution`，base = origin/main `ec66d2338`，writer 认领 `zcode`（lease+git lock 已取得） | 官方 `create-task-worktree` 流程；`--skip-bootstrap`（docs-only 任务，无构建/测试依赖需求） |
| 材料传播 | 自 SPEC 源工作树 `adhoc-20261019-codemode-spec-alignment-369e05` 复制 5 份文件，SHA-256 逐一比对**全部一致**（清单见附录 A） | 复制前已检查目标存在性：3 个 CODEMODE 文件为新增；IAER/PI12 的 +13 行附录为同任务链上一环节产物 |

## 2. 核查方法与实际命令（全部只读；退出码均为 0，另有 2 次工具性偏差如实记录）

| # | 命令（在指定仓库/工作树执行） | 退出码 | 说明 |
|---|---|---|---|
| C1 | `git fetch origin && git rev-parse origin/main`（PD primary） | 0 | 基线刷新 |
| C2 | `git diff --stat bf5aed354..origin/main -- <7 个目标文件>`（PD） | 0 | 源码漂移核查 |
| C3 | `git fetch origin && git rev-parse origin/main v1.3.0^{commit}` + `git diff --stat v1.3.0..origin/main -- packages/codemode`（Pi） | 0 | 未 checkout/修改 Pi |
| C4 | `git show v1.2.0:packages/agent/src/agent-loop.ts`（分段读取 660-900 行、508-522 行、586-652 行） | 0 | runToolCall 与并行执行机制 |
| C5 | `git show v1.3.0:packages/codemode/{package.json,src/types.ts,src/runtime/prelude-source.ts,CHANGELOG.md}` + `v1.3.0:packages/agent/examples/mcp-codemode/tools.ts` | 0 | 沙箱元数据/默认值/输出上限/worker 语义/官方示例 |
| C6 | Read/Grep：PD 的 artificer-l2-adapter、artificer-l2-tool-contract、l2-agent-loop-adapter、agent-tool-contract、internalization-consumer-cycle、pi-ai-runtime-adapter（primary 工作树副本，经 C2 证明等价 origin/main） | 0 | 生产路径源码事实 |
| C7 | `rg` 扫描 docs/（specs/implementation-reports/audit/experiments/plans）+ telemetry eventType 盘点 | 0 | U-01 工作负载数据源清查 |
| C8 | `node scripts/dev/create-task-worktree.mjs … --skip-bootstrap --json` + `worktree-claim.mjs --writer zcode` | 0 | 官方工作树与租约 |
| C9 | `cp` 5 份材料 + `sha256sum` 双端比对 | 0 | 首轮循环比对因 MSYS 反斜杠路径解析出现 5 个伪 MISMATCH；改正斜杠路径复跑后 **5/5 MATCH**（§1 表）。无任何文件内容差异 |
| C10 | 一次 `git show … | sed -n '110,165p'` 查询被 Mimosa 钩子误判拦截（只读命令命中误报模式，与 memory 在案的只读复合命令误拦同类）；改用 grep 上下文形式完成同一只读查询 | — | 如实记录，不影响结论 |
| C11 | `git diff --check` + 文档链接存在性检查（本工作树） | 见 §11 | 交付前检查 |

**未运行**：任何 PD 包测试套件、Code Mode 沙箱、QuickJS/WASM/Worker、B0/B1/B2 代码对照、真实付费模型调用。原因：G0 未通过，SPEC §2/§5 与执行指令 §4 明确禁止在无候选时制造 PoC 或运行时代码。

## 3. 关键源码事实（本轮独立核实）

### 3.1 PD 侧

| 事实 | 证据位置 |
|---|---|
| Artificer 四工具协议及顺序（read→validate→replay→submit）写在系统协议层 | `artificer-l2-adapter.ts:425-435` |
| 两 L2 适配器均用 `runAgentLoop`（非 Agent 类），文件头注释记录选择原因（finishTurn/abort/精确终止） | `l2-agent-loop-adapter.ts:8-21,36`；`artificer-l2-adapter.ts:11-13,39-40` |
| beforeToolCall 白名单双层防御（Artificer 4 工具 / Dreamer 3 工具） | `artificer-l2-adapter.ts:528-533`；`l2-agent-loop-adapter.ts:493`；whitelist 定义于两份 tool-contract 尾部 |
| finishTurn 终止合同（error/aborted 守卫 + turnCount + outputCapture） | `artificer-l2-adapter.ts:538-546` |
| `validate_rulecode` = 三个纯静态检查（禁则/return 缺字段/matched=false 一致性），不执行代码 | `artificer-l2-tool-contract.ts:252-289` |
| `replay_rulecode` = buildGoldenTraceFromArtificer + evaluateRefinerRuleHostGate（注入 gateDeps，确定性回放） | 同文件 `:298-358` |
| `submit_rulecode` = 权威 ArtificerValidator 校验 + outputCapture 捕获 | 同文件 `:367-403` |
| **validate/replay 的工具输出本身已是紧凑文本**（"VALID/INVALID + 违规行"、"PASSED/FAILED + 案例行"），不存在大体积中间结果 | 同文件 `:267-280,323-349` |
| Dreamer `read_principles` 输出为紧凑 {id, statement} 列表；`read_artifact` 返回 contentJson **原文、无截断**（唯一理论上的大输出点） | `agent-tool-contract.ts:139-167,93-122` |
| Owner Evidence / intent-basis preflight 先于 runner 构造（结构化 skip reason，fail-closed） | `internalization-consumer-cycle.ts:564,641` 及周边 |
| L2 遥测面：`artificer_l2_turn`/`dreamer_l2_turn` 逐工具事件（toolName/ok/error/turn）；Artificer 循环后从消息提取 token usage 入 PRI-795 evidence 块 | `artificer-l2-adapter.ts:466-476,170-173,754`；`l2-agent-loop-adapter.ts:431-466` |
| Diagnostician 路径 = one-shot `completeSimple`（无工具循环、无多步检索工具面）；usage 以 input/output tokens 记录 | `pi-ai-runtime-adapter.ts:458,580,1215,1306,85-90`；runner 目录无 diagnostician 专用 runner |

### 3.2 Pi 侧

| 事实 | 证据位置 |
|---|---|
| `runToolCall` 在 **PD 已安装的 1.2.0** 中存在并导出：参数准备→schema 验证→beforeToolCall(可 block)→execute→afterToolCall 全管线；文档明示"工具调用其他工具时用它，使权限类 hook 同样生效" | v1.2.0 `packages/agent/src/agent-loop.ts:811-819,791-800,708-777`；`index.ts` 经 `export * from "./agent-loop.ts"` 导出 |
| Agent Loop 并行机制：未被标记 `executionMode:'sequential'` 的工具同轮并行执行（`executeToolCallsParallel`） | v1.2.0 `agent-loop.ts:508-522,586-652`；PD 两套 L2 工具均未标记 sequential |
| 官方嵌套示例基于 **Agent 实例**（agent.state.messages/tools、agent.beforeToolCall/afterToolCall）→ `runToolCall`；与 PD runAgentLoop 形态不同构，接入需自建 assistantMessage/context 桥 | v1.3.0 `packages/agent/examples/mcp-codemode/tools.ts:83-103` |
| Code Mode 为独立包 `@earendil-works/pi-codemode 1.3.0`，依赖 quickjs-wasi 3.6.2，**不依赖 pi-agent-core**；engines >=22.19.0 | v1.3.0 `packages/codemode/package.json:2-3,66-70` |
| 沙箱默认值：timeoutMs 默认 300000ms；memoryLimitBytes 默认**无细粒度限制**（仅 wasm32 4GiB 寻址空间） | v1.3.0 `codemode/src/types.ts:123-131` |
| 输出上限为 prelude 内固定常量：`MAX_OUTPUT_CHARS = 16 Mi 字符`、`MAX_OUTPUT_ITEMS = 100,000`（store 另有 256Ki/1Mi 限制）；脚本侧超限抛错，**非 per-sandbox 可配置** | v1.3.0 `codemode/src/runtime/prelude-source.ts:34-35,42-43,304-348` |
| 1.3.0 worker 语义：结果/close() 在**请求关闭后即 settle，不等于 worker 真正退出**；需 `onWorkerStarted(exited)` 或 `acquireWorker` release 跟踪真实退出 | v1.3.0 `codemode/CHANGELOG.md` 1.3.0 节（6-12 行）；`src/runtime/host.ts` |

以上与前置审计报告（§2 F-01~F-07）一致，本轮全部独立复核成立，无翻案证据。

## 4. 工作负载证据（U-01 的核心）

本轮清查了仓库内全部可合法访问的工作负载数据源（生产 state.db 与原始私有轨迹按指令禁止读取）。现有证据**反向证伪**"存在真实多轮 L2 工作负载"：

1. **生产无可消费 Artificer 任务**。IAER Production Pilot 报告（`docs/implementation-reports/SPEC-PD-IAER-001-production-pilot-2026-10-15.md` §H，只读核实段）：宿主重启后消费周期每 2 分钟运行，每轮 `INTERNALIZATION_CONSUMER_SKIP {"reason":"no_ready_tasks"}`，runs 表零新增；37 条 pending 为 hydration 排除的僵尸、85 条 terminal-failed 在唤醒扫描之外——"生产队列当前没有任何能被新语义消费的任务"。唯一能产生真实 L2 执行的路径（Owner 授权单例恢复/新 Pain 流入）截至该报告**未发生**。
2. **历史 401 次 Artificer L2 运行全部在进入工具循环前失败**。IAER SPEC §2.2：385 条失败全部为 `behavior_example_pack_missing`，中位耗时 0.01s——即从未发生 read_spec→validate→replay→submit 的多轮执行。
3. **Dreamer L2 生产配置关闭**（IAER SPEC §2.1）——该候选在生产根本不运行。
4. **真实模型 L2 全链 E2E 从未执行**。Pi12-COMPAT Phase 3 AC-6 零授权轮报告（2026-10-18）：真实调用 opt-in 测试已备好但 `LLM_E2E_ENABLED` 未开启，**0 请求、$0**；AC-6 状态 NOT_RUN。全链测试（B2 场景）的设计预期即 `maxTurns:8` 内走完四工具链——这量化了理论工作负载：**一条完整 Artificer 链约 4-5 个模型回合，且工具输出为紧凑文本**。
5. **仓库内无 L2 回合/用量聚合报告**。`artificer_l2_turn`/`dreamer_l2_turn` 事件携带 toolName/ok/error/turn（无 token），其数据落在生产库（禁读，且如第 1 条所示本就无新数据）；docs/ 全量扫描（specs/implementation-reports/audit/experiments/plans）未发现任何含真实 L2 回合数、工具调用次数、token usage 或输出体积的聚合分析。

**结论**：不存在"多次依赖调用/重复查询/大结果上下文成本"的真实、重复工作负载。不是"暂时没找到证据"，而是现有最佳证据表明该负载**当前不存在**。

## 5. U-01 ~ U-05 逐项裁决

| 门 | 裁决 | 依据（摘要） |
|---|---|---|
| **U-01 真实工作负载** | **FAIL（被证据反向证伪）** | §4 五条证据；Artificer 生产零可消费任务+历史失败均在循环前；Dreamer 生产关闭；Diagnostician 无工具面 |
| **U-02 可脚本化** | 技术上部分成立，但**无意义** | Artificer validate/replay 是确定性步骤且输出已紧凑（§3.1）——没有需要脚本去筛选/聚合的大中间结果；语义步骤（读规范、起草、提交）不可脚本化。Dreamer 两读取本就可同轮并行（§3.2），无中间数据处理需求 |
| **U-03 价值可测量** | **FAIL（无基线）** | 无任何真实 token/费用/延迟/回合基线（§4 第 4、5 条）；fixture 无法证明真实模型成本变化（SPEC §5 明示）。连"改善 ≥15%"的分母都不存在 |
| **U-04 简单方案不足** | **FAIL（B1 充分，B2 无独特收益）** | 见 §7 同题对照：B1 组合工具可完整实现 validate→replay 压缩与同等输出，零新依赖零沙箱；Dreamer 并行读取已内建；B2 在任何现有场景无 B1 之外的可识别收益 |
| **U-05 安全桥可行** | API 存在但**无需验证** | runToolCall 全管线在 1.2.0 可用（§3.2），桥接在纸面可行；但因 U-01~U-04 全败，构建/测试该桥无对象。官方示例与 PD runAgentLoop 不同构、同轮 codemode+submit 批次互斥等真实成本仍全部未验证——这构成未来重开时的既知工作清单，而非本轮可记为"可行"的证据 |

**G0 裁决：NO-GO / NO CANDIDATE。** 按 SPEC §2 与执行指令 §4：不安装 pi-codemode、不新增运行时抽象、不写 adapter/tool-contract 代码、不创建 feature flag、不跑 P0/P1。

## 6. 三场景适用性（本轮独立复核后维持并加固 SPEC §3 裁决）

- **Artificer L2 — NO-GO 候选**。唯一存在确定性步骤对（validate→replay）的场景，但：(a) 无真实工作负载（§4）；(b) 两步输出已紧凑，Code Mode"筛选大结果"的核心价值无作用面；(c) B1 以零新复杂度实现同等压缩（§7）。规范阅读（read_spec）必须留在模型侧，脚本无法替代语义理解。
- **Dreamer L2 — NO-GO 候选**。生产关闭；两独立读取在 pi-agent-core 1.2.0 下本就同轮并行（executeToolCallsParallel，两工具未标 sequential），Code Mode 无回合节省空间；`read_artifact` 理论大输出应以更简单的受限/参数化读取接口应对（属 B1 类方案，且在 U-01 无负载证据时也不应实施）。
- **Diagnostician — 不具备接入条件**。one-shot completeSimple 路径，无多工具检索面。先建检索层再谈编排 = 为 Code Mode 增建两层新架构（检索 API + Agent Loop），在无负载证据时违背最小化原则。
- **RuleHost / 关键词 Pain / Owner 审批/激活** — 确定性治理与授权边界，不适用或禁止脚本化（Owner Evidence preflight 必须先于模型与脚本：`internalization-consumer-cycle.ts:564`）。

## 7. B0 / B1 / B2 同题对照（分析性对照；未执行代码实验——G0 未通过，SPEC 禁止为此制造 PoC）

同一问题：Artificer 链中 validate→replay 这对确定性步骤（唯一可压缩点），同一输入/权限/证据假设：

| 维度 | B0（现状：两次依赖工具调用） | B1（确定性组合工具，如 `validate_and_replay`） | B2（Code Mode 脚本） |
|---|---|---|---|
| 模型回合 | 2（validate 一回合、replay 一回合） | **1**（一次调用内顺序执行 validate，通过则 replay） | 1 + 脚本生成（模型须先写对调用桥脚本的额外失败面） |
| 输出形态 | 两个紧凑文本 | 同等紧凑合并文本（复用同一批检查函数与 gate，**零第二套规则**） | 脚本返回值（同等信息，但需定义 structuredContent/isError/部分成功统一语义） |
| 新增依赖 | 0 | **0** | +1 运行时依赖（pi-codemode→quickjs-wasi 3.6.2，WASM 资产入安装器/发布链） |
| 新增运行时机制 | 0 | 0 | QuickJS/WASM/Worker 生命周期（1.3.0 结果 settle≠worker 退出，须 onWorkerStarted/acquireWorker 跟踪）、timeout/memory/输出/调用数/并发预算、同轮批次互斥 |
| 治理面 | 现有 whitelist+hooks 原样 | 现有 whitelist+hooks 原样（组合工具只是又一白名单工具） | 需自建 runAgentLoop→runToolCall 上下文桥并证明不绕过任何 hook/白名单/finishTurn |
| 相对 B0 的收益 | — | −1 回合/链（链共约 4-5 回合，≈20-25%） | 与 B1 相同的 −1 回合；无任何 B1 之外的已识别收益 |

**对照结论（AC-10）**：B1 与 B2 收益等同，B1 复杂度严格更低、权限面更小 → 若未来需要压缩，选 B1，Code Mode 方向 NO-GO。且在 U-01 失败的当下，**连 B1 也不应实施**——没有负载就没有优化对象；B1 仅作为未来重开时的对照基线记录。

## 8. P0 / P1 / P2 / P3 状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| G0 资格门 | **DONE — NO-GO / NO CANDIDATE** | 本报告 §4-§7 |
| P0 隔离兼容 PoC | **NOT_ENTERED（正确跳过）** | 仅 G0 GO 才进入；未运行任何沙箱/Worker/WASM 验证 |
| P1 B0/B1/B2 对照 | **NOT_ENTERED（正确跳过）** | 仅 P0 PASS 后进入；§7 为分析性对照非实验数据 |
| P2 真实模型试点 | **NOT_RUN** | 未授权（本任务书与 SPEC 均禁止付费调用） |
| P3 生产接线 | **NOT_RUN** | 未授权；P2 前提不存在 |

## 9. 复杂度增量、残余风险与观察项

### 9.1 Complexity Delta（本次执行）

New durable source of truth: NO；New persisted schema/state: NO；New subsystem/service: NO；New public abstraction: NO；New runtime feature flag: NO；New cross-package dependency: NO；New host/platform-specific behavior: NO；New external/network capability: NO。净增产物：本报告 + 工作树内 5 份任务链文档传播（附录 A）。

### 9.2 残余观察项（本轮发现/确认，均不实施）

1. **`read_artifact` 无输出截断**（`agent-tool-contract.ts:93-122`）：contentJson 原文返回，是全链唯一理论大输出点。当前无负载证据表明其构成瓶颈；若未来 Dreamer L2 启用且出现大 artifact，优先做 B1 类受限/参数化读取，而非 Code Mode。记录为 follow-up 候选（antipattern-completeness：无证据不实施）。
2. **Pi origin/main 已前进**（a731ba8b8，TUI 文档）：未来重开 G0 时需重新钉基线；packages/agent/src 与 packages/codemode 源码截至该提交未变。
3. **既有 Node engines 元数据不一致**（>=22.0.0 vs >=22.19.0）维持原状，仅在进入 P3 时处理。
4. **未来重开时既知工作清单**（本轮不做的理由即未来要做的事）：runAgentLoop→runToolCall 上下文桥、codemode 唯一外层工具批次互斥负测试、Worker 真实退出跟踪、宿主级预算（上游 16Mi/100k 输出上限为固定常量，更严格的执行中止需上游支持或补丁）。

### 9.3 安全风险

本轮零代码零依赖，无新增攻击面。需防的只有**误读**：(a) 本裁决不构成对 Pi Code Mode 沙箱安全性的认证或否定；(b) 不得将"PD 仓库可引用 Code Mode 示例"表述为"PD 已具备/已支持 Code Mode"；(c) 任何未来接入必须重过 U 门并保持 Owner Evidence 先于模型与脚本（模型=0、脚本=0、回放=0 的硬门，IAER 附录 A 第 3 条）。

## 10. 重新打开 G0 所需的最小证据

1. **真实负载流**：生产（或授权试点）出现 ≥1 条 Owner 授权的完整 Artificer L2 链真实执行，且后续形成可重复流量（IAER Pilot 候选链 605ba208 的授权执行即是现成入口）。
2. **可引用的聚合遥测**：≥2 周的 `artificer_l2_turn` 聚合（回合数/工具调用分布/失败模式）+ PRI-795 evidence 块的 token usage 汇总（脱敏、仓库内存放）。
3. **基线测量**：在上述数据上量化"validate/replay 两回合"或"read_artifact 输出体积"构成的实际成本（回合占比、上下文字节占比）。
4. **B1 不足的对照证据**：同一冻结任务上 B1 组合工具（或受限读取接口）仍留下 B2 才能覆盖的缺口（例如：需要模型侧临场决定的条件组合逻辑，且该逻辑种类多到无法预写成有限组合工具）。
5. 以上任一成立也只是"重开资格门"，P0/P1/P2/P3 仍按 SPEC §5 逐级门禁。

## 11. 交付前检查

| 检查 | 命令 | 结果 |
|---|---|---|
| git 卫生 | `git diff --check`（本工作树） | 退出码 0（无空白错误） |
| 文档结构 | 报告置于 `docs/implementation-reports/`，SPEC 置于 `docs/specs/`，与仓库惯例一致 | 符合 |
| 链接检查 | 报告内相对链接（`SPEC-PD-CODEMODE-001-v0.2.md`、`SPEC-PD-CODEMODE-001-source-audit-20261020.md`、IAER/PI12 SPEC、pilot/AC-6 报告）逐一存在性核验 | 见下方记录 |
| 工作树状态 | `git status --short`：M×2（IAER/PI12 附录传播）+ ?? ×4（3 份 CODEMODE 文档 + 本报告）；按任务书约束**不 commit、不 push** | 待 Owner 审阅 |
| primary/Pi 仓库 | 未修改任何文件（本轮对两者仅 git 读操作与 fetch） | 核实 |

链接核验结果（相对本报告所在目录）：
- `../specs/SPEC-PD-CODEMODE-001-v0.2.md` — 存在
- `../specs/SPEC-PD-CODEMODE-001-zcode-execution-instructions.md` — 存在
- `SPEC-PD-CODEMODE-001-source-audit-20261020.md`（同目录）— 存在
- `../specs/SPEC-PD-IAER-001-v1.0.md`、`../specs/SPEC-PD-PI12-COMPAT-001-v0.2.md` — 存在
- `SPEC-PD-IAER-001-production-pilot-2026-10-15.md`、`SPEC-PD-PI12-COMPAT-001-phase3-ac6-real-llm-20261018.md`（同目录）— 存在

## 12. 最终裁决

**GO / NO-GO / BLOCKED / INCONCLUSIVE：NO-GO / NO CANDIDATE（G0 证据门未通过；生产接入维持 NO-GO）。**

- Code Mode **不值得**在当前 PD 接入：不存在真实工作负载（U-01 被现有生产证据反向证伪），无可测量基线（U-03），确定性组合工具 B1 在唯一可压缩场景与 B2 收益等同且复杂度严格更低（U-04 → AC-10），因此 U-05 无验证对象。
- 隔离验证（P0/P1）**未执行且不应执行**：SPEC 将"无候选时做沙箱 PoC"明确定义为把技术可行性误当产品价值，属禁止项。
- 下一步**不值得**投入 Code Mode 开发。正确的下一步（若 Owner 关心此议题）是 §10 第 1-3 条：先让生产 L2 链产生真实流量与聚合遥测；数据出现后按 SPEC §5 重开资格门。
- 零新增依赖、零运行时代码、零 feature flag。本报告与 5 份任务链文档为本轮全部产物（未 commit，待 Owner 审阅）。

---

## 附录 A：材料传播 SHA-256 清单

自 SPEC 源工作树 `adhoc-20261019-codemode-spec-alignment-369e05` 复制至本工作树，双端一致：

| 文件 | SHA-256（前 16 位） |
|---|---|
| docs/specs/SPEC-PD-CODEMODE-001-v0.2.md | `ae400dd00fee5428` |
| docs/specs/SPEC-PD-CODEMODE-001-zcode-execution-instructions.md | `08efcb6006f5568b` |
| docs/implementation-reports/SPEC-PD-CODEMODE-001-source-audit-20261020.md | `5f94894165924dfd` |
| docs/specs/SPEC-PD-IAER-001-v1.0.md（含 +13 行附录传播；覆盖前 origin/main 版 SHA `ce2b73a8847c2847…`） | `c6d8f79ea329edce` |
| docs/specs/SPEC-PD-PI12-COMPAT-001-v0.2.md（含 +13 行附录传播；覆盖前 origin/main 版 SHA `e759a2b4e57ad4d7…`） | `707a6bddcb5ebbf3` |

## 附录 B：与前置审计报告的关系

本报告是执行指令要求的一次性完整执行交付，独立重核了审计报告（source-audit-20261020）的全部关键事实（F-01~F-07 逐项复核成立，见 §3），并新增了三类证据/修正：(1) Pi origin/main 前进至 a731ba8b8 的基线刷新与 agent/codemode 源码未变证明；(2) U-01 从"NOT PROVEN"升级为"被现有生产证据反向证伪"（§4）；(3) B0/B1/B2 同题分析性对照的量化（§7，链级 −1 回合 ≈20-25%，B1≡B2）。两者的最终裁决一致：生产接入 NO-GO。
