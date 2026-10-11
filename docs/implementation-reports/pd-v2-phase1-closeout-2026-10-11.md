# PD v2 Phase 1 收尾实宿主验收报告（2026-10-11）

> 状态：**已交付（2026-10-11）** — 最终判定 §7：Phase 1 保持 **PARTIAL**；实现缺陷类缺口全部关闭，剩余闭合项=Owner 审批候选（§8 决策 1）。
> 工作分支：`ai/adhoc-20261011-p1-closeout-pdv2-p1-closeout`（worktree `D:\Code\_worktrees\principles\adhoc-20261011-p1-closeout-pdv2-p1-closeout`，writer=zcode）
> 前序：`docs/implementation-reports/pd-v2-phase1-host-acceptance-2026-10-10.md`（r1/r2/r3）、`docs/implementation-reports/pd-v2-phase1-b1-diagnosis-2026-10-11.md`（r1–r4 + §12/§13 实施记录，#1982 已并）
> 隔离环境：沙箱 `D:\Code\_pdtest\p1-closeout\sandbox`、网关 18796（`C:\Users\Administrator\.pd-p1test\openclaw-state-p1c`）、Console 3200（沙箱）/3201（codex-ws）、Codex `C:\Users\Administrator\.pd-p1test\codex-home-p1c` + `D:\Code\_pdtest\p1-closeout\codex-ws`。历史沙箱 `D:\Code\_pdtest\p1-acceptance\*` 全程只读，未写入任何记录。

## 0. 结论

**Phase 1 判定 PARTIAL（维持），缺口性质收窄：** 本轮在真实隔离环境完成（a）五条完整内化链实跑，把 B-1 的剩余障碍从「已定位的实现缺陷」推进到「Owner 审批前的候选就绪」——链 4 R2 产出**通过全部确定性重放**的候选规则；（b）三项入库修复（修复轮输入保真 v11、评判 kind 语义 v7、Codex pin → 证据面版本），全部有实链或实机活证；（c）Codex 宿主真实接入验证按其实际支持范围闭合（G-Codex-1/G-Codex-2 消除）。GJ-01 拦截链与 Owner Outcome 未执行——SPEC §13.9 的 Owner 批准前置不存在（沙箱 0 approvals），不代 Owner 批准；决策卡见 §8。

## 1. 版本清单（A1 要求逐项记录）

| 组件 | 版本 | 来源 | 用途 |
| --- | --- | --- | --- |
| 仓库 main | `814d49d1`（#1983，core 1.291.2 含 #1982 配对修复） | origin/main | 本轮基线 |
| worktree 构建（内化链 CLI/core/prompt） | `37fc780c`（在本分支） | worktree `npm run build` | **内化链运行代码**（含 prompt v11 + caseInput 修复） |
| 安装运行时（网关插件实际加载） | `~/.pd/runtime`：core 1.291.0 / host-runtime 0.8.1 / codex-adapter 0.5.1 / plugin 2.1.0 | 官方安装器 | **拦截链/GJ 运行时**（Phase 1 证据面已在 10-10 验证存在，本轮复核 bundle.js 含 intervention_evidence/behavior_episode） |
| npm 最新 | core **1.291.2**（2026-10-11T03:51Z 火车发布，含 #1982）/ host-runtime 0.8.1 / codex-adapter 0.5.1 | npm registry | pin 目标 |
| 插件 pin（本轮 PR 后） | adapter 0.5.1 / host-runtime 0.8.1 / core **1.291.2** | `plugins/principles-disciple/runtime-version.json` | Codex 安装面 |
| OpenClaw 宿主 | 2026.10.1 (e178c39) | 本机 | 隔离网关 |
| codex-cli | 0.162.1 | 本机 | Codex 真实会话 |

安装边界遵守：未写 `~/.pd/runtime/`、`~/.openclaw/extensions/`、真实 Owner workspace；隔离实例经正式 dev 路径（worktree 构建 + PD_WORKSPACE_DIR 显式覆盖）与官方安装产物（只加载不修改）搭建。

## 2. 本轮入库改动

| 变更 | commit | PR | 验证 |
| --- | --- | --- | --- |
| Codex runtime pin → Phase 1 证据面版本（终值 core 1.291.2） | `24ae7dca` + `be647b0b` | 本 PR（拆分的 #1984 已关并） | check:runtime-pin S1–S5 PASS（对 1.291.2 重跑）；tarball 实装核验；codex-adapter 43/43 |
| Artificer 修复轮输入保真 + facts 语义文档（prompt v11） | `37fc780c` | 本 PR | internalization 78 文件/1158 测试 PASS；实链活证见 §4 |
| Evaluator 评判 kind 语义（prompt v7） | `13a8e593` | 本 PR | 同上；链 5 judge 关切质量变化见 §4 |

## 3. 环境缺陷发现与修复（本轮新发现）

### 3.1 隔离网关工作区反斜杠吞噬（已修复，本轮自身配置错误）

首次以 bash 双引号 env + node 单引号字符串写 `openclaw.json` 的 `agents.defaults.workspace` 时反斜杠被转义层吞掉，OpenClaw 把 `D:\Code\_pdtest\...` 解析为盘符相对路径，agent 文件操作实际落在 `D:\Code_pdtestp1-closeoutsandbox\`（已删除该误建目录，重置沙箱，改用正斜杠路径后恢复）。复核旧验收配置（`D:\\Code\\...` JSON 转义完好）确认旧验收无此问题——旧沙箱的 ls-protected ENOENT 负例是真实路径不存在，非本缺陷。

### 3.2 G-Codex-2（Codex 观测不落库）在 0.5.1 上消除

旧 pin（0.4.7）：真实会话后 codex-ws 各表 0 行。新 pin（0.5.1，隔离实装）：真实 `codex exec` 会话后 trajectory 落入 session×1 + tool_calls×2（真实 Bash 写/删调用）。`intervention_evidence_records` 0 行为**预期**（recorder 契约：delivery 记录仅在原则真实注入时产生；本工作区无激活原则；见 codex-evidence-recorder.d.ts 的 recordCodexPromptDeliveryEvidence/recordCodexDenyEvidence 边界）。

## 4. 内化链实跑记录（A2）——五链全景与四项修复的链上活证

运行代码：worktree 构建（prompt v10→v11、evaluator v7 随对应链切换）。pack 演进：v1（笼统日常豁免）→ v2（读后写纪律精确化）。全部经真实 LLM 管线（AMD DeepSeek-V4-Flash）。

| # | pain | pack | 代码态 | R1 | R2 | 终态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | ljynwhtb | v1 | v10 + #1982 配对修复 | FAIL×2（path-boundary + combination） | FAIL×1（path-boundary，纯标记语义规则） | rejected（轮次上限） |
| 2 | ife4rs5w | v1 | 同上 | artificer 传输瞬时失败（retry_wait） | — | 链死亡（环境，非模型） |
| 3 | camnam6x | v1 | + v11 | FAIL×1 | FAIL×1；judge **approved/0.9** 但确定性一票否决 | rejected（PRI-634 R3 fail-loud 正确拒绝无 replay proof 的 approved） |
| 4 | bjcpv85b | **v2** | + v11 | FAIL×1（模型把正例豁免写成 worklog.md 子串匹配，恰好吞掉 .bak） | **replay 全 PASS**（判别器规则：priorReadOfTarget==='no' && readCount>0 → block）；judge needs_revision/0.7（kind 误读：「edit 会直接放行」——事实性误读） | rejected |
| 5 | g665u5gn | v2 | + v11 + **evaluator v7** | FAIL×1 + needs_human_review（principle_pain_mismatch；judge 关切已与读后写纪律对齐） | FAIL×1（模型退化回纯 protected 标记，尽管 caseInput 证据在手） | rejected（轮次上限） |

**四项修复的链上活证（逐项）**：

1. #1982 配对修复：五链的模板目标全部来自正确配对的 write 正例（`worklog.md(.bak)`），不再出现旧链的 `..bak` 拼接产物。
2. v11 caseInput：链 3/4/5 的 evaluator 工件失败条目均携带 `tool=write params={"path":"worklog.md.bak"} | context: available, priorReadOfTarget=no, readCount=1 | case rationale: …`；链 4 R1→R2 的修复（子串匹配 → readCount 判别器）证明修复轮能消费该证据。
3. v11 facts 语义：链 4 R2 规则首次实现完整判别器形态（风险优先 + protected 前缀 + unavailable→allow + priorRead/readCount 判别）。
4. evaluator v7：链 5 的 judge 关切全部与纪律对齐（「已读取但未确认 vs 已读取且已确认」的区分、isRiskPath 判定依据不透明——均为合法关切），kind 误读模式消失。

**停止依据**：五链、四个已修复的确定性问题、剩余失败 = scribe 意图逐链漂移 × artificer 执行方差（同一修复后模型有时产判别器有时退化）。按「失败重复先定位原因，不无限重试模型」停止重跑。链 4 的 R2 工件（`pi-art-rulehost-manual_1791699471552_bjcpv85b-evaluator-r2-mv3gac07-…`）是**通过完整确定性重放的真实候选**，其未产出 rule artifact 的唯一原因（judge kind 误读）已被 v7 修复——作为 GJ-01 候选交 Owner 裁决（§8 决策卡）。

**B-1 状态判定**：诊断报告 §12 的预言逐字验证——「配对修复不会自动解除 B-1：正确 write 正例下的原 boundary 失败必须如实保留」。本轮在此基础上修复了修复轮信息保真与评判 kind 语义；剩余收敛障碍是模型方差与 scribe 漂移，属候选重跑授权问题，不再是已定位的实现缺陷。B-1 保持未解除（等待 Owner 批准的候选完成 GJ-01 全链）。

## 5. GJ-01（A3）与 Outcome/审计（B）——依赖 Owner 审批，未执行

- 沙箱当前 0 approvals / 0 activations（如实记录）。GJ-01 前置「Owner 已批准的 RuleHost 原则」不存在，本轮不代 Owner 批准、不伪造审批历史（SPEC §13.9 + 任务 §四）。
- 已就绪：隔离网关（18796）、事件会话/工具调用/宿主语义声明（session aa6d301e，tool_calls id 1/2）、Console 3200 审批与四问查询面、§8 决策卡的具体审批对象。
- B1-B3（Outcome、四查询、重放幂等/重启/失败边界）依赖 GJ-01 产生真实 Episode，未执行；四问查询面已在真实路由上验证（诚实空集 + coverage.sourceStatus=available，Console 3200/3201）。
- GJ-02 保留：真实自述只产生 agent_claimed；本轮无激活原则故无注入会话，不补写。

## 6. Codex 真实接入（C3）

- 隔离安装：本地 marketplace（worktree）→ `codex plugin add` → 插件 0.1.0 携带新 pin → `$pd-setup` 实装 1.291.1/0.8.1/0.5.1（实装时 1.291.2 尚在传播；core 证据面 1.291.1 与 1.291.2 一致，pin 终值随后升至 1.291.2 并重跑探针）。
- 真实会话：`codex exec`（DeepSeek-V4-Flash / responses API / 隔离 CODEX_HOME），五 hook 事件全部触发并 Completed，tokens 8,886，真实写入-读回-删除 codex-probe.txt。
- 观测：trajectory 落库 ✓（§3.2）；事件日志 `runtime_v2_prompt_activations_injected` injectedCount=0（诚实空）；`intervention_evidence_records`=0（无激活原则，预期）；能力声明表 0 行——**声明随首批证据落库**（materialize-on-first-batch），无激活即无声明，四问查询返回诚实空集（coverage.sourceStatus=available）。该懒物化行为如实披露为已知观察边界。
- 能力矩阵（按当前适配版本判定）：delivery(prompt 注入)=Supported（机制在，未在本轮无原则工作区演示）；enforcement=Unknown（PRI-780 v2 规则执行暂停）；self-report=Unsupported；behavior(工具事件)=Supported（本轮实证）；outcome=Unknown。

## 7. 完成标准矩阵（任务 §十 COMPLETE 条件）

| # | 标准 | 判定 | 依据 |
| --- | --- | --- | --- |
| 1 | 至少一真实宿主完成 GJ-01 全链 | ✗ 未达成（依赖 Owner 审批候选） | §5；候选与全部基础设施就绪（§4/§8） |
| 2 | 另一宿主完成真实接入验证并披露缺口 | **✓（Codex，按其实际支持范围）** | §6：新 pin 隔离安装、真实 CLI 会话、五 hook 全触发、trajectory 真实落库（旧 pin 0 行 → G-Codex-2 消除）；缺口披露=enforcement Unknown（PRI-780 暂停）、self-report Unsupported、声明懒物化边界 |
| 3 | Console 真实查询与 Outcome 入口验证成立 | 部分（查询面真实可用✓；Outcome 入口待 GJ Episode） | §5 |
| 4 | 完整链重放、重启及关键失败边界有证据 | 部分（工程回归 1158 测试含重放幂等/重启/失败边界✓；实宿主链无 Episode 可验） | §2/§5 |
| 5 | 适用 BDD、测试和工程门禁通过 | ✓ | internalization 78/1158 PASS；verify:merge exit 0；check:runtime-pin S1–S5 PASS |
| 6 | 没有未解释的 SPEC 必需缺项 | ✓ | 全部缺项有已定位根因或明确 Owner 前提（§4/§5/§8） |

**最终判定：Phase 1 保持 PARTIAL（与前两轮判定一致，但缺口性质收窄）。** 本轮把「实现缺陷」类缺口全部关闭（派生配对、修复轮零信息、facts 语义缺失、评判 kind 误读、Codex 安装面缺失、G-Codex-2 观测断点），剩余未闭合项全部收敛到一个 Owner 前提：批准一个已通过确定性重放的候选进入激活，即可执行 GJ-01 并连带闭合标准 1/3/4 的实宿主部分。

## 8. Owner 决策卡（本轮唯一需要 Owner 裁决的事项集）

### 决策 1：GJ-01 候选

**对象**：链 4 R2 候选规则（工件 `pi-art-rulehost-manual_1791699471552_bjcpv85b-evaluator-r2-mv3gac07-…`，沙箱 state.db）。行为：写 protected/ 或系统风险路径 → block；上下文不可用/截断 → allow；非保护路径写未被读取过的既有目标（priorRead=no 且窗口有读）→ block；其余日常写 → allow。**已通过全部确定性重放**（Owner 正/负例 + 5 条 v2 模板 + host-alias）。
**依据**：SPEC §13.9 要求 Owner 批准的 RuleHost 原则；该候选经真实内化链产出、离线验证完备；其未走完审批的唯一原因是已修复的 judge kind 误读。
**影响**：批准后需要一次工程操作在修复后代码上重跑一条链（预期 1–2 轮收敛）产生正式 approval 请求，Owner 在 Console（3200）点击批准 → 激活 → GJ-01 真实拦截 → Episode/Effect/Outcome 全链。
**操作入口**：回复授权后由执行会话完成；或 Owner 直接选择再授权一次全新链跑（等价效果）。
**不批准的后果**：GJ-01 无法执行，Phase 1 标准 1/3/4 的实宿主部分保持未闭合。

### 决策 2：pin 发布授权

**对象**：PR（本分支）将插件 pin 升至 codex-adapter 0.5.1 / host-runtime 0.8.1 / core 1.291.2（全部已在 npm）。
**依据**：G-Codex-1；check:runtime-pin S1–S5 + tarball 实装 + 43/43 安装流测试；隔离 Codex 实机已验证新 pin 修复 G-Codex-2。
**影响**：PR 合并后随下一班 Version PR → 发布火车把 pin 变更带上 npm；已装 Codex 宿主经 `$pd-setup` 获得证据面。属发布资产变更，正式发布推进须 Owner 授权（本 PR 合并本身不触发发布）。

## 9. 回滚与测试实例停用

- 代码：三个 commit 各自可独立 revert（`be647b0b` pin / `37fc780c` v11 / `13a8e593` v7）；pin 回滚后重跑 `$pd-setup`。
- 测试实例：隔离网关（已停）；Console 3200/3201（`pd console start` 进程，随用随停）；隔离安装 `C:\Users\Administrator\.pd-p1test\codex-home-p1c` 与 `openclaw-state-p1c` 可整目录删除；`~/.pd/install.json` 的测试 worker 注册条目可用插件自带 `scripts/pd-disable.cjs` 清理（与 10-10 验收相同路径）。
- 历史库：`D:\Code\_pdtest\p1-acceptance\*` 全程只读未动；本轮沙箱 `D:\Code\_pdtest\p1-closeout\*` 保留至 Owner 裁决后处置。

## 10. 真正剩余的 Owner 决策 / 外部前提

1. §8 决策 1（GJ-01 候选授权）——唯一阻塞 COMPLETE 的工程可闭合项。
2. §8 决策 2（pin 随下班火车发布的授权）。
3. （非本轮）B-1 全链闭合后的六标准重判；Codex 能力声明懒物化是否需要改为显式声明入口。
