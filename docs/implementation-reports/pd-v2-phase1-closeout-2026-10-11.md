# PD v2 Phase 1 收尾实宿主验收报告（2026-10-11）

> 状态：**已交付 · 评审修复轮（2026-10-11）** — 最终判定 §7：Phase 1 保持 **PARTIAL**；评审指出的当前范围代码与报告问题已修复（§2/§4/§6），正式可审批候选尚不存在（§8）。
> 工作分支：`ai/adhoc-20261011-p1-closeout-pdv2-p1-closeout`（worktree `D:\Code\_worktrees\principles\adhoc-20261011-p1-closeout-pdv2-p1-closeout`，writer=zcode）
> 前序：`docs/implementation-reports/pd-v2-phase1-host-acceptance-2026-10-10.md`（r1/r2/r3）、`docs/implementation-reports/pd-v2-phase1-b1-diagnosis-2026-10-11.md`（r1–r4 + §12/§13 实施记录，#1982 已并）
> 隔离环境：沙箱 `D:\Code\_pdtest\p1-closeout\sandbox`、网关 18796（`C:\Users\Administrator\.pd-p1test\openclaw-state-p1c`）、Console 3200（沙箱）/3201（codex-ws）、Codex `C:\Users\Administrator\.pd-p1test\codex-home-p1c` + `D:\Code\_pdtest\p1-closeout\codex-ws`。历史沙箱 `D:\Code\_pdtest\p1-acceptance\*` 全程只读，未写入任何记录。

## 0. 结论

**Phase 1 判定 PARTIAL（维持）。** 本轮在真实隔离环境完成（a）五次内化链执行（四次完整对抗循环 + 一次传输失败），把失败面从「派生配对缺口」推进到「修复轮信息保真 + 评判 kind 语义」两项已修复的代码缺陷，并产出链 4 R2 这一条**通过其确定性重放集合**的诊断原型规则；（b）Codex 宿主按其实际支持范围完成真实接入验证（新 pin 隔离安装、真实 CLI 会话、hook 通路、legacy 工具采集落库）。

**独立复核（2026-10-11，PR #1986 review）后的重要修正**：链 4 原型**不是**符合 Owner 意图的规则（零读取时可放行未读目标；读过无关文件后新建文件被阻止；已读取不等于已获 Owner 确认；非 write 的 protected ls 被放行），其重放集合只有 2 个 Artificer 正例 + 5 条模板（host-alias 跳过、Owner 负例不在该集合）；沙箱至今 0 approvals / 0 activations / 0 个 rule 工件——**正式可审批对象尚不存在**，「只剩 Owner 批准」的上一版表述撤回。剩余工作 = 在修复后代码上产生语义证据充分的正式 rule 候选（含覆盖 Owner 全部正负例的重放与逐场景核对），之后才进入 Owner 审批。GJ-01 与 Owner Outcome 未执行。决策状态见 §8。

## 1. 版本清单（A1 要求逐项记录）

| 组件 | 版本 | 来源 | 用途 |
| --- | --- | --- | --- |
| 仓库 main | `814d49d1`（#1983，core 1.291.2 含 #1982 配对修复） | origin/main | 本轮基线 |
| worktree 构建（内化链 CLI/core/prompt） | `37fc780c` → `13a8e593` 之间的构建快照随链演进（§4「代码态」列逐链标注） | worktree `npm run build` | **内化链运行代码**（链 1/2 = v10 基线 + #1982；链 3/4 = +v11；链 5 = +v11+v7；终态 `13a8e593`） |
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
| **评审修复轮（2026-10-11 二轮）**：facts 去政策化（v12）+ 评判真实映射权威（v8）+ caseInput 分预算共享上界 | `de1f20e0` 及其修正 commit | 本 PR | internalization 79/1170 PASS（负对照先行：旧代码 3 断言红）；报告 §4/§6/§7/§8 同步修正 |

## 3. 环境缺陷发现与修复（本轮新发现）

### 3.1 隔离网关工作区反斜杠吞噬（已修复，本轮自身配置错误）

首次以 bash 双引号 env + node 单引号字符串写 `openclaw.json` 的 `agents.defaults.workspace` 时反斜杠被转义层吞掉，OpenClaw 把 `D:\Code\_pdtest\...` 解析为盘符相对路径，agent 文件操作实际落在 `D:\Code_pdtestp1-closeoutsandbox\`（已删除该误建目录，重置沙箱，改用正斜杠路径后恢复）。复核旧验收配置（`D:\\Code\\...` JSON 转义完好）确认旧验收无此问题——旧沙箱的 ls-protected ENOENT 负例是真实路径不存在，非本缺陷。

### 3.2 G-Codex-2（Codex 观测不落库）在 0.5.1 上消除

旧 pin（0.4.7）：真实会话后 codex-ws 各表 0 行。新 pin（0.5.1，隔离实装）：真实 `codex exec` 会话后 trajectory 落入 session×1 + tool_calls×2（真实 Bash 写/删调用）。`intervention_evidence_records` 0 行为**预期**（recorder 契约：delivery 记录仅在原则真实注入时产生；本工作区无激活原则；见 codex-evidence-recorder.d.ts 的 recordCodexPromptDeliveryEvidence/recordCodexDenyEvidence 边界）。

## 4. 内化链实跑记录（A2）——五次执行的全景

运行代码：worktree 构建（代码态逐链标注）。pack 演进：v1（笼统日常豁免）→ v2（读后写纪律精确化）。全部经真实 LLM 管线（AMD DeepSeek-V4-Flash）。

| # | pain | pack | 代码态 | R1 | R2 | 终态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | ljynwhtb | v1 | v10 + #1982 配对修复 | 执行✓；replay FAIL×2（path-boundary + combination）；judge needs_revision/0.62 | 执行✓；replay FAIL×1（path-boundary，纯标记语义规则）；judge needs_revision/0.62 | rejected（轮次上限） |
| 2 | ife4rs5w | v1 | 同上 | **artificer 传输瞬时失败（retry_wait），无 evaluator 执行** | — | 链死亡（环境）。**不是完整执行链** |
| 3 | camnam6x | v1 | + v11 | 执行✓；replay FAIL×1；judge needs_revision/0.72 | 执行✓；replay FAIL×1；judge **approved/0.9**——确定性重放一票否决（PRI-634 R3 fail-loud 正确拒绝无 replay proof 的 approved） | rejected |
| 4 | bjcpv85b | **v2** | + v11 | 执行✓；replay FAIL×1（正例豁免写成 worklog.md 子串匹配）；judge needs_revision/0.68 | 执行✓；**replay passed=true**（见下方集合说明）；judge needs_revision/0.7（kind 误读，已由 v7 修复该误读模式） | rejected |
| 5 | g665u5gn | v2 | + v11 + **evaluator v7** | 执行✓；replay FAIL×1；judge needs_revision/0.62 + needs_human_review（principle_pain_mismatch；关切与读后写纪律对齐） | 执行✓；replay FAIL×1（模型退化回纯 protected 标记）；judge needs_revision/0.62 | rejected（轮次上限） |

**四项代码修复的链上活证（逐项，均为真实执行证据）**：

1. #1982 配对修复：各链模板目标均来自正确配对的 write 正例（`worklog.md(.bak)`），无旧链 `..bak` 拼接产物。
2. v11 caseInput：链 3/4/5 evaluator 工件失败条目携带完整输入摘要；链 4 R1→R2（子串匹配 → 判别器）证明修复轮能消费该证据。（评审轮又修复了长参数挤掉 context 的预算缺陷——见 §2。）
3. v11 facts 语义：链 4 R2 规则首次实现判别器形态。**评审轮修正**：该判别器只是 readCount 启发式，不等价于 Owner 要求的确认/新建例外（见下方局限表）。
4. evaluator v7→v8：链 5 judge 关切与纪律对齐（kind 误读消失）；评审轮进一步发现 v7 条款自身断言了错误映射（writeTools≠全部 write），v8 改为投影真实宿主语义映射。

**链 4 R2 原型的准确定性（评审轮修正）**：

- 其 replay passed=true 的**确切集合**：2 个 Artificer 正例 + 5 条 v2 模板。**不含** Owner 标注负例（host 真实 write 负例使 host-alias 生成跳过）、不含 pack 的 protected 只读访问场景。Artificer L2 replay 调用不等于逐 case 覆盖证据。
- 独立复核用正规 synthetic input + hardened VM 复现的规则行为对照（可复现，非新宿主事实）：

| 诊断场景 | 链 4 R2 规则结果 |
| --- | --- |
| 既有未读目标，窗口 0 读取 | allow（漏拦截） |
| 读过无关文件后新建 worklog | block（误拦截新建） |
| 已读取但未经 Owner 确认的既有目标 | allow（确认语义缺失） |
| 非 write 的 protected ls | allow（范围外放行） |

- **结论**：它是保留价值的**诊断原型**（证明判别器形态可通过确定性重放），不是符合 Owner 意图的规则，不是审批就绪对象。工件状态：pending principle 中间工件（completionIntent needs_revision）；沙箱 0 approvals / 0 activations / 0 个 rule 工件。
- 上一版「实现缺陷全部关闭」「唯一原因是 judge kind 误读」「只剩 Owner 前提」「预计 1–2 轮收敛」表述**全部撤回**。剩余工作不是单次批准，而是产生正式候选的完整工程链：修复后代码 + 覆盖 Owner 全部正负例（含 protected 只读）的重放 + 逐场景语义核对 → formal rule artifact → Console 审批。

**停止依据**：五次执行、四个已修复的代码缺陷（配对/修复轮零信息/facts 语义/judge 误读——后者含其自身二次缺陷 v7→v8）、剩余失败 = scribe 意图漂移 × 模型执行方差 × 原型语义缺口。按「失败重复先定位原因，不无限重试模型」停止重跑。**B-1 保持未解除。**

## 5. GJ-01（A3）与 Outcome/审计（B）——依赖 Owner 审批，未执行

- 沙箱当前 0 approvals / 0 activations（如实记录）。GJ-01 前置「Owner 已批准的 RuleHost 原则」不存在，本轮不代 Owner 批准、不伪造审批历史（SPEC §13.9 + 任务 §四）。
- 已就绪：隔离网关（18796）、事件会话/工具调用/宿主语义声明（session aa6d301e，tool_calls id 1/2）、Console 3200 审批与四问查询面。可审批对象尚不存在（§8）：进入 GJ-01 前须先走 §8 决策 1 列出的正式候选工程路径（覆盖 Owner 全部正负例与 protected 只读场景的重放、逐场景语义核对、formal rule artifact）。
- B1-B3（Outcome、四查询、重放幂等/重启/失败边界）依赖 GJ-01 产生真实 Episode，未执行；四问查询面已在真实路由上验证（诚实空集 + coverage.sourceStatus=available，Console 3200/3201）。
- GJ-02 保留：真实自述只产生 agent_claimed；本轮无激活原则故无注入会话，不补写。

## 6. Codex 真实接入（C3）——分层记录（评审轮修正）

| 层 | 状态 | 证据与边界 |
| --- | --- | --- |
| ① 真实 CLI + hook 接入 | **已验证** | `codex exec`（DeepSeek-V4-Flash / responses / 隔离 CODEX_HOME），五 hook 事件全部触发并 Completed，tokens 8,886，真实写入-读回-删除；隔离安装链 = 本地 marketplace（worktree）→ `codex plugin add` → `$pd-setup` 实装（实装时 core 1.291.1，pin 终值 1.291.2 随后重跑探针核验） |
| ② legacy trajectory 工具采集 | **已验证** | 真实会话后 codex-ws trajectory：session×1 + tool_calls×2（Bash success；旧 pin 0 行 → 采集断点在 0.5.x 消除）。这是 legacy 采集通路，**不是** Phase 1 证据批次 |
| ③ Phase 1 Delivery/Application/Episode/Effect | **未实证（0 行）** | `intervention_evidence_records`=0、注入事件 injectedCount=0（诚实空）：本工作区无激活原则 → 无注入 → recorder 契约下无 delivery/deny 记录可产生。**非空批次经 ingress 的完整通路本轮未验证**，保持未实证状态，不以空集反推通路健康 |
| ④ 能力声明与覆盖状态 | **0 行；recorder 契约为准** | `intervention_capability_declarations`=0（无首批证据即无声明——懒物化边界如实披露）；已实装 recorder 源码声明 behavior_observation=**unknown**（Episode 仅由归属 gate 干预产生，当前 enforcement 暂停）。**不把工具轨迹升为 Phase 1 behavior Supported**；prompt delivery 未演示 → Unknown（机制存在于 recorder 契约，另行说明） |

能力矩阵（按当前适配版本与实装 recorder 契约判定）：delivery(prompt 注入)=**Unknown**（机制在、未实证）；enforcement=**Unknown**（PRI-780 v2 规则执行暂停）；self-report=Unsupported；behavior_observation=**Unknown**（recorder 契约声明；legacy trajectory 采集是独立事实，见 ②）；outcome=Unknown。

发布状态区分：pin 更新（本 PR）≠ 已发布（需 Version PR 火车）≠ 已安装（`~/.pd/runtime` 当前仍为旧组合）；隔离实装版本（core 1.291.1 @ 实装时刻）≠ 本 PR 代码。

## 7. 完成标准矩阵（任务 §十 COMPLETE 条件；评审轮修正后）

| # | 标准 | 判定 | 依据 |
| --- | --- | --- | --- |
| 1 | 至少一真实宿主完成 GJ-01 全链 | ✗ 未达成 | §5；正式可审批对象尚不存在（§4 准确定性） |
| 2 | 另一宿主完成真实接入验证并披露缺口 | **部分达成（按已验证范围）** | ①② 层已验证（§6）：真实 CLI/hook 接入 + legacy 工具采集落库；缺口如实披露 = Phase 1 证据面未实证非空批次（③）、能力声明 0 行且 recorder 契约 behavior_observation=unknown（④）、enforcement Unknown。**不声称证据面闭合** |
| 3 | Console 真实查询与 Outcome 入口验证成立 | 部分（查询面真实可用✓；Outcome 入口待 GJ Episode） | §5 |
| 4 | 完整链重放、重启及关键失败边界有证据 | 部分（工程回归覆盖✓；实宿主链无 Episode 可验） | §2/§5 |
| 5 | 适用 BDD、测试和工程门禁通过 | ✓ | internalization 79/1170 PASS；verify:merge exit 0；check:runtime-pin S1–S5 PASS |
| 6 | 没有未解释的 SPEC 必需缺项 | ✓ | 全部缺项有已定位根因或明确前提（§4/§5/§8/§10） |

**最终判定：Phase 1 保持 PARTIAL。** 本轮修复了评审指出的全部当前范围代码问题（facts 政策化、judge 假映射、caseInput 预算、报告夸大、Codex 分级），但**实现缺口并未全部关闭**：正式可审批的 rule 候选尚不存在，链 4 原型存在已列明的语义局限（§4 对照表），scribe 漂移与模型方差未治理。到 COMPLETE 仍需：正式候选工程链 → Owner 审批 → GJ-01 → Outcome/审计闭环 → 六标准重判。

## 8. Owner 决策状态（评审轮修正后）

### 决策 1：GJ-01 —— **当前无可审批对象，本轮不提交批准请求**

链 4 R2 是诊断原型（§4 对照表列明四处语义局限），**不提交 Owner 批准**；复检确认的沙箱事实：0 approvals / 0 activations / 0 个 rule 工件。到 GJ-01 的工程路径（后续工作，非本轮）：

1. 在修复后代码（v12 + v8 + caseInput 预算）上重跑链；
2. 重放集合必须覆盖 Owner 全部正负例与 protected 只读场景（当前链的 host-alias 跳过与负例缺席需先解决）；
3. 逐场景核对规则行为与 pack 语义（含 §4 四个对照场景的反向断言）；
4. 产出 formal rule artifact（completionIntent 非 needs_revision）→ Console 审批 → 激活 → GJ-01。

scribe 意图漂移与模型方差是这条路径上的已知风险，可能需要多于一轮。

### 决策 2：pin 发布授权（不变）

**对象**：本 PR 将插件 pin 升至 codex-adapter 0.5.1 / host-runtime 0.8.1 / core 1.291.2（全部已在 npm）。
**依据**：G-Codex-1；check:runtime-pin S1–S5 + tarball 实装 + 43/43 安装流测试；隔离 Codex 实机验证 legacy 工具采集恢复（§6 ②）。
**边界**：pin 使已装 Codex 宿主获得证据面代码，但 §6 ③ 的非空证据通路仍属未实证；正式发布推进须 Owner 授权（本 PR 合并不触发发布）。

## 9. 回滚与测试实例停用

- 代码：功能单元各自可 revert——pin = `24ae7dca`+`be647b0b` 两 commit（revert `be647b0b` 仅退回 1.291.1，完整回滚 pin 需两者）；v11 = `37fc780c`；v7 = `13a8e593`。pin 回滚后重跑 `$pd-setup`。
- 测试实例：隔离网关（已停）；Console 3200/3201（`pd console start` 进程，随用随停）；隔离安装 `C:\Users\Administrator\.pd-p1test\codex-home-p1c` 与 `openclaw-state-p1c` 可整目录删除；`~/.pd/install.json` 的测试 worker 注册条目可用插件自带 `scripts/pd-disable.cjs` 清理（与 10-10 验收相同路径）。
- 历史库：`D:\Code\_pdtest\p1-acceptance\*` 全程只读未动；本轮沙箱 `D:\Code\_pdtest\p1-closeout\*` 保留至 Owner 裁决后处置。

## 10. 真正剩余的 Owner 决策 / 外部前提

1. 决策 2（pin 随下班火车发布的授权）——本 PR 合并后的发布推进。
2. GJ-01 路径（§8 决策 1）的启动授权：属后续工程工作（正式候选链），完成后才有可审批对象。
3. （非本轮）B-1 全链闭合后的六标准重判；Codex 能力声明懒物化是否需要改为显式声明入口；scribe 漂移与模型方差的治理方式。