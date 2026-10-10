# PD v2 Phase 1 实宿主验收报告（收口）——PARTIAL

> 日期：2026-10-10（Asia/Shanghai）
> 验收对象：PR #1957（merge commit d5732f84，2026-10-08T14:26:14Z）
> 安装身份：安装运行时 = origin/main 同版（core 1.290.0 / host-runtime 0.8.0 / principles-disciple 2.1.0 / codex-adapter 0.5.0 / console 0.1.0，root 2.3.0）；已核实安装产物含全部 Phase 1 模块
> 宿主版本：OpenClaw 2026.9.9 (bcfc888)；codex-cli 0.162.0（r2/r3 复核时实测已为 0.162.1，见 §7 基线行）
> 持久化说明：按 2026-10-07 Owner 裁定（docs/audit 不跟踪），本报告与证据索引保存于既有持久交付位置 docs/implementation-reports/；工作底稿（含完整命令记录）为本地不跟踪文件。
> 验收 PR：#1977（BDD 资产；本报告随该 PR 入库并在 PR 描述链接）
>
> **r2 复核基线（2026-10-10 第二轮，本报告 §7 的来源）**：分支基线 origin/main `ba39b469`（2026-10-10T14:58:28+08:00）；已核实 d5732f84（#1957）与 4e383420（#1977）均为当前 HEAD 祖先。仓库工作区版本 core 1.291.0 / host-runtime 0.8.1 / codex-adapter 0.5.1 / principles-disciple 2.1.0 / console 0.1.0 / root 2.3.1。OpenClaw 侧安装运行时同上版；**Codex 侧安装产物不是同版**——插件 pin 为 `runtime-version.json` 的 core 1.287.6 / host-runtime 0.7.11 / codex-adapter 0.4.7（见 §7 B-2）。宿主版本：codex-cli 0.162.1。

## 0. 结论（按 Owner 复核纠正后的表述）

**Phase 1 判定 PARTIAL。** prompt 通道的真实治理链（pain → 诊断 → Gate B → intake → 内化 → Console 审批 → 激活）与投递-自述证据在真实宿主成立；四问查询与 Owner 结果入口的契约在真实路由上验证。强制证据链未执行（BLOCKED 于规则内化阶段），Codex 真实 CLI 会话 NOT RUN，Owner 结果的实宿主提交未完成——因此不仅拦截链待补，**即便拦截链补完也不能直接升级 COMPLETE**：必须按全部六条完成标准（含另一宿主真实接入、Owner 结果实宿主提交）重新判定。

**r2/r3 复核（§7）后的判定不变，但三条缺口的性质已改变**：B-1 的根因由"模型反复省略"改判为**确定性 gate oracle 与同一 run 意图契约的冲突**，r3 再用真实 run 输入 × 生产方法把冲突钉到更窄的事实上——模板的写目标取自 Owner 标注正例 `case-positive-6`，而那条证据是 `ls {"path":"."}`，于是 oracle 要求 block 的路径是字符串拼出来的 `..bak`；是否同时违背 **Owner 意图**记为 Unknown（Owner 原文只约束受保护路径，逐字冲突只存在于链 B 的 Scribe 派生句）。提示词义务缺口已修复并活证（r3 又收紧一次措辞，v9 → v10，校验器一字未改）；B-2 由 NOT RUN 改判为**真实 Codex CLI 会话已接入**（五个 hook 事件全部 Completed、真实模型输出、真实工具写入），同时暴露一个新缺口——**按官方插件安装的 Codex 宿主今天没有 Phase 1 证据面**；N-1 对 B-1 的依赖已用源码证实。判定仍为 PARTIAL，且升级条件比 r1 更明确（§7.5）。

## 1. 真实宿主已验证证据（全部可复核，无人工插表）

### 1.1 治理链（真实流程；测试裁决由 Owner 在验收任务中授权）

| 环节 | 方式 | 证据身份 |
|---|---|---|
| 真实 Agent 会话 | 隔离网关 OpenAI 兼容端点（`POST /v1/chat/completions`，与 webchat 同代码路径） | 会话 402c0f59（受保护写入请求）、7fc4d1cb（事故叙述）、b52e9cb9（SMOKE_OK 冒烟） |
| pain 入账 | `pd pain record --host openclaw --session 7fc4d1cb...` | trajectory.db pain_events id=2（user_correction, score 70, canonical_pain_id=pain_host_79143661…） |
| 诊断 | `pd diagnose run`（真实 LLM 管线 router/distiller/rootcause） | 3 候选生成；此前无会话绑定的 pain 被 Gate B 真实拒绝（confidence 0.40 < 0.5） |
| 入账 | Gate B 凭会话 trace 放行；`pd candidate intake` | 候选 f116754d / 1f9ec447(rule) / 5a68dc03 全部 consumed |
| 内化 | auto-consumer + run-once（dreamer/philosopher/scribe 真实 LLM） | 各阶段 succeeded；scribe 工件 validated |
| Owner 审批 | 真实 Console API `POST /api/v1/approvals/:id/approve`（隔离 Console 3199） | apr_prompt_pi-art-scribe-f116754d... → approved，decidedBy=operator |
| 激活 | approval-completion → dispatcher | act_prompt_0a54f406-42a0-42d4-a46b-53215d051622_fba2e245...（prompt / prompt_activate） |

### 1.2 证据链（真实落库；查询经真实 Console）

真实沙箱 state.db `intervention_evidence_records`（跨多次网关/Console 重启存续）：

- delivery：`openclaw|delivery|agent_context|402c0f59-...`（agent_context · submitted · attempted）
- application：`openclaw|application|agent_claimed|402c0f59-...`（agent_claimed · self_reported，claimText 为 Agent 原话）

**事实描述（不含归因）**：在被注入原则的会话中观察到 Agent 停止写入（目标目录不存在）并产生了合规格式的自述；两者均被证据链捕获。该观察**没有对照证据**（无"未注入原则/无该原则"的同场景基线），因此只能证明"观察到了该行为与该自述"，**不能证明原则改变了行为**。

真实 Console 四问：`GET /api/v1/receipts/evidence-audit?type=principle&id=...` 在真实数据上返回 status=ok、deliveries=1、applications=1（agent_claimed 含原话）、6 条能力声明（outcome_observation=unknown）；查询跨多次网关/Console 重启成立（重启耐久实证）。

### 1.3 工程验证（明确标注：非实宿主证据）

- 本 PR 新增 BDD `docs/specs/features/receipt/intervention-evidence.feature`（6 场景全绿）：四问分列、agent_claimed/runtime_verified 边界、pending 关联诚实、同源重放幂等+连接重启查询、Owner 结果契约（actor 服务端注入、runtime 证明字段 400）、前证据库降级不创建。夹具经真实 ingress+normalizer（满足 main 最新 hardening）。
- PR #1957 既有 16/16 运行时验证（真实 gate hook + 真实规则 + 真实 codex dist 子进程）仍为工程链证据基线。

## 2. SPEC §13 验收矩阵

| 条目 | 状态 | 证据/缺口 |
|---|---|---|
| 13.1 Goal/Scope（只记事实） | 已验证（工程+真实） | 全链无评分/自动治理字段；四问空区=未观察非未发生 |
| 13.2 三层边界 | 已验证（真实） | 治理链全程走既有服务；evidence ledger 独立表 |
| 13.3 身份/关系 | 已验证（工程+真实） | 自然键+快照 digest；pending/corrections（BDD）；血缘守卫拒跨会话样本（实宿主实证） |
| 13.4 生命周期/权威 | 已验证（工程+真实） | 真实 agent_claimed 与 runtime_verified 分列（BDD）；争议/更正路径 BDD+单测 |
| 13.5 投递契约 | 已验证（工程+真实投递侧） | delivered 需确认边界（normalizer 规则）；真实投递=submitted/attempted |
| 13.6 能力契约 | 已验证（真实） | 真实查询返回 6 条声明（outcome_observation=unknown）；Codex unsupported/unknown 如实 |
| 13.7 本地账本/失败 | 已验证（工程） | busy=0、失败回滚、readonly 不建库；写失败不改工具决定 |
| 13.8 四问 | 已验证（真实+工程） | 真实 Console 查询真实数据；BDD 四场景 |
| 13.9 Golden Journey | **部分——见 §3 BLOCKED** | 投递-自述链真实；拦截链未执行 |
| 13.10 迁移边界 | 已验证（工程） | flag off 零写入；legacy 计数 API 回归绿 |

## 3. BLOCKED / NOT RUN（含恢复步骤）

### B-1 强制证据链（gate 拦截 → runtime_verified → Episode/Effect → Owner 结果实宿主提交）：**BLOCKED**

> r2 修订见 §7.1：失败根因由"模型反复省略 v2 校验契约"改判为"确定性 gate oracle × 同 run 意图契约的冲突"；省略类失败已通过补提示词义务消除。r3 再修订见 §7.1：该冲突的生产复现改用真实 run 输入 × `generateV2CasesFromArtificer`，冲突面收窄为"模板写目标取自一条 `ls` 观测"，且"是否违背 Owner 意图"改记 Unknown。本节保留为 r1 当时的判定记录。
>
> **r3 对本节"恢复步骤 ①"的修正**：换更强指令遵循模型或重启本地引擎**不能**解除 B-1。省略类失败已消除（4 个 artificer run succeeded），剩下的失败在同一条**确定性模板**用例上，与模型无关；同一组证据重跑仍会落在同一个 block/allow 不匹配上。解除路径见 §7.1 的三条候选（取证状态见该表，且不构成穷尽集）：**派生行为已证实，责任边界（实现缺口 vs 治理决策）尚待核查**——本轮不据此要求 Owner 改变政策。


- **事实陈述**：当前只能确认阻塞发生在**规则内化阶段**（run-rulehost 对抗循环 6 次真实尝试失败）。强制证据链（gate 拦截之后的全部写入路径）**尚未执行过**——因此不能对"强制证据链基础设施无缺陷"作出任何断言；其真实缺陷（如有）只会在 B-1 解除后暴露。
- 失败模式（均有落库记录）：① L2 总预算 300s 超时（模型慢；--timeout-ms 900000 可缓解）；② 网关 auto-consumer 与循环抢跑 artificer 任务（task-driven runner 无 pack 先写先赢；停网关可消除）；③ 模型产出未满足 v2 Artificer 校验契约（RuleCode evidenceRefs 须精确引用 Owner 标注样本，DeepSeek-V4-Flash 反复省略）；④ AMD 端点 429 限流。已排除：管线布线（dreamer/philosopher/scribe 全 succeeded）、Gate B、审批、激活均真实走通；有一次 artificer run 成功产出实现代码但循环后续环节仍降级。
- 恢复步骤：① 恢复可用模型通道（本地 qwen3.8-27b 引擎重启，或更强指令遵循模型）后重跑 `pd runtime internalization run-rulehost --pain-id pain_host_79143661... --behavior-examples D:\Code\_pdtest\p1-acceptance\behavior-examples.json --timeout-ms 900000 --confirm`；② 循环通过 → Console 批准 → code_tool_hook 激活；③ 重放 GJ 会话写 protected/ 路径，采集拦截链证据；④ Console 提交 Owner 结果；⑤ 重新执行完整验收判定。

### B-2 Codex 真实 CLI 会话：**NOT RUN（环境能力）**

> r2 改判见 §7.2：本节两条阻塞理由（AMD 端点不支持 Responses、凭据不可用）已被实测推翻，真实 Codex CLI 会话已跑通；缺口改记为安装 pin 无 Phase 1 证据面。本节保留为 r1 判定记录。

- ① codex ≥0.162 移除 `wire_api="chat"`，自定义 provider 须支持 Responses API（AMD 端点不支持；本地引擎验收中途下线）；② Owner gpt-6.1-sol 走 OpenAI 订阅凭据，克隆到隔离环境违反凭据隔离；真实配置直跑会污染 Owner `~/.codex/pd-workspace`。
- 已验证的 Codex 真实面：真实安装的 pd-hook 产物（dist 子进程全契约）在 #1957 验收 16/16 中通过；能力矩阵如实声明（self_report=Unsupported、enforcement=Unknown，PRI-780 产品事实）。
- 恢复步骤：Owner 以订阅凭据在含测试区 pd-workspace 指向的隔离 CODEX_HOME 跑 `codex exec`；或等待支持 Responses 的本地/测试通道。

### N-1 Owner 结果实宿主提交：**NOT RUN**（依赖 B-1 的 Episode；路由契约已由 BDD 在真实路由代码上验证）。

### N-2 边界验证分工：重放/冲突/停用后重放/写失败翻转/降级区分 = 工程回归；实宿主可直接观察的边界（自述区分、submitted≠delivered、四问空区、重启查询、能力披露）= 真实运行。停用后历史重放保留原关联：工程覆盖，实宿主未单独演练（依赖 B-1）。

## 4. 环境事实与过程披露

> r2 追加披露（Codex 沙箱 bypass 用法、web_search 开关、隔离泄漏误判的否证过程、install.json 测试条目遗留）见 §7.2；不改变本节"真实 Owner workspace 零写入"的结论，该结论在 r2 已被内容检索复核。

- 隔离合规：测试数据全部位于 `D:\Code\_pdtest\p1-acceptance` 与 `C:\Users\Administrator\.pd-p1test`；机器级 `PD_WORKSPACE_DIR` 在所有调用中显式覆盖，真实 Owner workspace 零写入。
- 无手工插表：治理链全部经真实 CLI/服务/Console API；证据全部经共享 ingress+normalizer。
- 既有产品行为记录（不修，留档）：Gate B 对无 trace manual pain 拒绝（设计）；philosopher/evaluator 默认关闭使 run-rulehost 首跑被拒；openclaw CLI 前端在本机对部分子命令挂起（网关形态正常，已按网关 API 驱动绕开）。
- 遗留备份：`~/.codex/pd-workspace/*.backup-before-evtest-cleanup` 待 Owner 择期删除。
- 本报告无任何真实凭据；隔离网关 token 为测试自造值。

## 5. 完成标准对照（任务 §八六条）

> r2 重判见 §7.5（标准 2 的取证已改变，其余不变；总判定仍 PARTIAL）。本节保留为 r1 判定记录。

| # | 标准 | 状态 |
|---|---|---|
| 1 | 至少一宿主真实完整链 | ✗（投递-自述链真实；拦截链 BLOCKED=B-1） |
| 2 | 另一宿主真实接入验证并披露缺口 | 部分（pd-hook 真实产物验证+能力矩阵诚实；真实 CLI 会话 NOT RUN=B-2） |
| 3 | Console 查询与 Owner 结果提交真实可用 | 查询真实可用✓；结果提交入口真实可用（真实路由+BDD），实宿主提交 NOT RUN=N-1 |
| 4 | 重放、重启及关键失败边界 | ✓（重启真实；其余工程回归） |
| 5 | BDD 与规定检查通过 | ✓（BDD 6/6；verify:merge exit 0） |
| 6 | SPEC 无未解释必需缺项 | ✓（矩阵 §2 逐项有据） |

**升级 COMPLETE 的重新判定条件（按 Owner 纠正第 1 点）**：B-1 解除且拦截链+Owner 结果实宿主提交完成、B-2 解除（Codex 真实会话或 Owner 认可的替代证明）、六条标准逐条重新取证后，方可重新判定；任一未闭即维持 PARTIAL。

## 6. 证据索引（复核入口）

| 证据 | 位置 |
|---|---|
| 治理/证据主库 | `D:\Code\_pdtest\p1-acceptance\sandbox\.pd\state.db`（activations / approvals / principle_applications / intervention_evidence_records / intervention_capability_declarations） |
| 轨迹与 pain | `D:\Code\_pdtest\p1-acceptance\sandbox\.state\trajectory.db`（user_turns / tool_calls / pain_events） |
| 事件日志 | `D:\Code\_pdtest\p1-acceptance\sandbox\.state\logs\events_2026-10-09.jsonl`、`events_2026-10-10.jsonl` |
| 关键身份 | 激活 act_prompt_0a54f406-42a0-42d4-a46b-53215d051622_fba2e245...；审批 apr_prompt_pi-art-scribe-f116754d...；会话 402c0f59 / 7fc4d1cb / b52e9cb9；pain canonical_pain_id=pain_host_79143661...；候选 f116754d / 1f9ec447 / 5a68dc03 |
| Console 复核 | 隔离 Console（3199，loopback）`GET /api/v1/receipts/evidence-audit?type=principle&id=<原则id>` |
| 内化失败记录 | state.db tasks/runs：task_kind=artificer 的 6 组失败 run（timeout / pack_missing / validation / 429） |
| BDD | `docs/specs/features/receipt/intervention-evidence.feature` + `packages/pd-console/tests/bdd/intervention-evidence.steps.test.ts`（本 PR） |
| 隔离环境配置 | `C:\Users\Administrator\.pd-p1test\openclaw-state\openclaw.json`（网关 18795）、`...\codex-home\config.toml`（隔离 CODEX_HOME） |

## 7. r2/r3 复核（2026-10-10 第二、三轮）：三条缺口的重新取证与改判

> r3（同日第三轮，按 Owner 复核意见）只做三件事：把 §7.1 的"生产复现"换成**真实 run 输入 × 生产方法**的取证；删除 helper 豁免里的 `backup`（未经生产验证的扩写）；把"Owner 必须三选一"降级为**待取证的候选路径**。oracle、gate、生产生成器、Owner 意图均未改动，判定仍为 PARTIAL。
>
> **r3 独立复核后的文本修正（同日，纯文档、零代码改动）**：① §7.1 三方一致性结论不再断言"这不是实现缺口而是治理缺口"——真实生成流程同时收到 Owner pack 与 Scribe intent（`artificer-runner.ts:819-851`、`artificer-prompt-builder.ts:535-559`），"写工具选用了 `ls` 正例路径"这一实现缺口**尚未被排除**；② 09:09:55 那条 `ls` 链不再推断"整轮 gate 未跑"，改标为**未确认**（§7.1）。B-1 仍未解除，Phase 1 仍为 PARTIAL。

### 7.1 B-1：根因改判链——"模型不稳定" → "gate × 意图契约冲突" → r3：**模板目标路径取自一条 `ls` 观测**（仍 BLOCKED）

**r2 修复的部分是真实存在的提示词缺口。** v2 Artificer 校验器要求 Owner 标注样本的 `caseId` 逐字出现在 `goldenTraceCases` 里，但提示词从未陈述这一义务，且 OUTPUT FORMAT 示例用的是占位 id（`negative-1` / `positive-1`）。补法只动提示词：加"必须把 pack 里的 Owner 标注用例逐字带入输出、可新增不可替代"的义务条款，并把示例标注为占位符；契约版本 `artificer-output-v2.prompt.v8 → v9`。**校验器一字未改。**

**r3 又改了一次同一句话，因为 v9 把 gate 说过头了。** `ArtificerRunner.fetchAndParseOutput`（EP002-R4，`artificer-runner.ts:883-917`）在校验**之前**把所有"沿用 pack caseId"的条目从权威 pack 机械恢复，因此 pack 存在时 `<field> was rewritten` 对 Owner 标注用例**永远不会触发**；v9 却把它写成模型可能收到的拒收信息。r3 的措辞改为陈述实际拒收向量：**缺失或更名 caseId → `was omitted`**；同 ID 条目的字段改动不进入比较（恢复后 gate 看到的是 pack 的字节），模型自写的用例用**新 caseId**，仍按原样接受完整校验。义务本身没有放宽，契约版本 `v9 → v10`，提示词文本测试同步收紧（新增 `not.toContain('was rewritten')`）。校验器仍一字未改。

活证（沙箱 `state.db` runs 表，UTC 时间，修复时刻落在两组之间）：

| 阶段 | artificer run | 结果 |
|---|---|---|
| 修复前 | 00:57:47 / 01:11:40 / 01:57:47 / 08:27:51 | 4 个 run `failed`，reason 逐字相同：`Validation failed: Owner-labelled example case-negative-5 was omitted; Owner-labelled example case-positive-6 was omitted` |
| 修复后 | 08:54:51 / 09:03:02（run A 两轮）、09:24:26 / 09:35:31（run B 两轮） | 4 个 run `succeeded`，`was omitted` 在库内停止出现 |

即两次连续 `run-rulehost` 的全部 artificer round 都通过了 v2 输出契约；run B 的 CLI 前端日志逐字记录 `"degradationReason":"max_rounds_exhausted_after_2"`（PRD 硬上限 2 轮，非缺陷）。

**剩余阻塞不是模型质量。** 三次 evaluator 对抗重放（A-r1 09:02:01、B-r1 09:33:13、B-r2 09:42:42）失败在**同一条确定性用例**上：

```
caseId=v2-path-boundary  expectedDecision=block  actualDecision=allow
reasonCode=replay_decision_mismatch
```

**生产派生复现（r3 重做）。** r2 曾用一条 `node -e` 直连底层模板函数 `generateV2ContextAdversarialCases({toolName:"ls", targetPath:".", canonicalKind:"other"})` 来"复现"——**该主张不成立，已删除**：生产入口不是那个函数，而是 `EvaluatorRunner.generateV2CasesFromArtificer`（`evaluator-runner.ts:2988-3069`），它先解析工具名，再在 `:3054-3062` 对**非 write 工具整批跳过模板**（发 `non_write_canonical_kind_for_v2_adversarial_cases` 遥测并返回 `[]`）。用 `ls` 手工喂底层函数恰好演示的是生产根本不会走的那条路。

r3 改为按生产顺序调用真实方法：加载未改动的编译产物 `packages/principles-core/dist/runtime-v2/internalization/evaluator-runner.js`，以 `parseArtificerArtifact → extractPositiveCases → generateV2CasesFromArtificer`（即 `:2160 / :2183 / :2200` 的同一序列）处理沙箱 `pi_artifacts.content_json` 里的四个真实 Artificer 工件；只有 `emitEvent` 的遥测端口换成收集器（`base-peer-runner.ts:351-364` 需要 `eventEmitter`），三个方法体一字未改，DB 与 dist 全程只读。

| Artificer 工件（真实） | affectedTools[0] | 生产分支 | 生成的 v2 用例 | 消费它的 evaluator run |
|---|---|---|---|---|
| 08:54:51（链 A r1） | `write` | write-template | 5 条；`v2-path-boundary` = `{"path":"..bak"}` → **block** | 09:02:01 失败于该用例 |
| 09:03:02（链 A r2） | `ls` | **skipped**（canonicalKind=`other`） | `[]` | 09:09:55 输出**没有 adversarialResult**：v2 模板未生成，消费者未持久化 replay 结果，**整轮 gate 执行情况尚未确认** |
| 09:24:26（链 B r1） | `write` | write-template | 同上 5 条 | 09:33:13 失败于同一用例 |
| 09:35:31（链 B r2） | `write` | write-template | 同上 5 条 | 09:42:42 失败于同一用例 |

三个失败 run 的输出里 `adversarialCases` 字段**均缺失**（生产 `:2637` 因此取 `llmCases=[]`），合并集只剩模板 + PRI-741 host-alias 用例；失败用例 `v2-path-boundary` 只可能来自确定性模板，这一点现在由生产方法本身证实。

对 09:09:55 那条 `ls` 链只能证明两点：**该 run 的 v2 模板未生成**（生产方法实测 `[]`）与**消费者输出里没有 `adversarialResult`**。`executeDeterministicReplay` 还会合并 host-alias 与 LLM 用例，本轮没有该 run 的明确 skip reason，也没有它的完整合并用例集，因此**不能推断整轮 gate 未执行**——该结论记为未确认。

**目标路径从哪来（r3 新证，也是更硬的根因）。** 模板的 `targetPath` 取 `positiveCases[0].params.path`（`resolveCasePathParam` 同时接受 `path` 与 `file_path`）。沙箱 6 个成功的 Artificer 工件里，正例**第一条永远是 Owner 标注的 `case-positive-6`**，而它是 `ls {"path":"."}`——来自 trajectory `tool_calls` id=6（session 402c0f59，"列出工作目录"这一步）。模型自写的写动作正例（`workspace/readme.md`、`src/app.js`、`workspace/notes.txt`、`workspace/file.txt`）永远排在其后，**从不参与派生**。于是 oracle 把"写 `.`+`.bak`（字符串拼接出的 `..bak`）"当作被测目标并要求 block。

- gate 侧：`v2-path-boundary` 的 expectedDecision 由 `v2-adversarial-cases.ts:211-222` 的 helper 段决定，`isHelperPath`（`:122-125`）只认 `tmp`/`temp`/`draft` 三个路径段；`rule-reliability-validation.ts:129` 的 `v2TemplateOracleExpectedDecision` 使 v2 模板失败一律 in-scope。
- 用同一生产方法、只替换正例路径做分支取证（不是替换样本以宣称阻塞解除——真实链仍是 block 分支）：

```
real     .                                 → v2-path-boundary {"path":"..bak"}                  block
tmp      D:/pd-work/tmp/check-rule.mjs     → {"path":"D:/pd-work/tmp/check-rule.mjs.bak"}       allow
temp     D:/pd-work/temp/check-rule.mjs    → allow
draft    D:/pd-work/draft/check-rule.mjs   → allow
backup   D:/pd-work/backup/check-rule.mjs  → block      ← r2 把它写成豁免段之一，是错的
backups  D:/pd-work/backups/check-rule.mjs → block
plain    D:/pd-work/src/app.mjs            → block
```

**意图侧证据必须分链看（r2 把两链合并引用了）。**
- 链 B（scribe 09:21:29）`intentContract.validationExpectation` 末句逐字为「…**对普通非受保护路径不触发冗余确认**」，与同一链两次模板 run 要求的 block 直接冲突。
- 链 A（scribe 08:53:57）的 `validationExpectation` **没有**这句话；其 `targetBehavior` 把触发集枚举为"目标路径带 protected/secret/private/guard 等标识时"，冲突只能从枚举集**推断**，不构成逐字矛盾。
- Owner 自己的话只在 `behavior-examples.json.ownerDesiredOutcome`（"AI 在写入任何受保护路径（如 protected/）之前，必须先解析并向 Owner 确认精确目标路径，未经确认禁止执行写入"）里，**对普通路径未作任何断言**；`intentContract` 是 Scribe 的 LLM 产物而非 Owner 文本。
- 所以 r2 那句"gate × Owner 意图的结构性冲突"要降级：可证的是 **gate × Scribe 派生句（链 B）逐字冲突**，以及 **gate 的目标路径取自一条 `ls` 观测**；"是否违背 Owner 意图"记为 **Unknown**。

**三方的来源与一致性（r3 只读核查，逐个到代码/落库取证）。**

| 对象 | 来源（权威） | 一致性判定 |
|---|---|---|
| Owner pack（`case-negative-5` / `case-positive-6`） | Owner 经 `--behavior-examples` 手工提供的 `behavior-examples.json`，由 `rulehost-pipeline-runner.ts:438-469` 直接作为 `behaviorExamplePack` 传入；`ownerDesiredOutcome` 是 `validateBehaviorExamplePack` 的强制字段（`behavior-example-pack.ts:198-200`）。用例的 toolName/params 回指 `trajectory.db` `tool_calls` id=5/id=6 | 与 trajectory **一致**（逐字核对通过）；与 `ownerDesiredOutcome` 文本**无冲突**——后者只约束受保护路径 |
| `intentContract`（5 个字段） | Scribe 的 LLM 产物，Artificer 任务的 `dependencyTaskIds` 逐条指向对应 scribe 任务（链 A `…-scribe-mv25qonf`、链 B `…-scribe-mv26q38u`，取自 `tasks.diagnostic_payload.pi_metadata`） | **不是 Owner 原文**。链 B 末句把"不干预域"写成了断言，Owner pack 里并无此断言 → 属派生层自行添加，一致性 = **Unknown**（无 Owner 文本可比对） |
| v2 模板用例（`v2-path-boundary`） | 确定性代码，`targetPath = positiveCases[0].params.path`（`extractPositiveCases` 保序，Owner 正例恒在首位） | 与 pack **一致**（用的就是 Owner 标注证据），但与链 B 的 intent 断言**逐字冲突** |

结论：**已证实该链将 `write` 工具与 `ls` 正例路径组合派生模板；这是否属于实现缺口，以及是否需要治理决策，尚待核查。现有三条候选路径不构成穷尽集。** 需要说明的是"三方互不引用"这句 r3 措辞过强：真实生成流程把 Owner pack 与 Scribe intent **一起**送进同一次生成（`artificer-runner.ts:819-851` 把 `intentContract` 与 `behaviorExamplePack` 同时传给 `buildPrompt`；`artificer-prompt-builder.ts:535-559` 再一起组装进 `promptInput`），模板随后从 Artificer 输出派生。因此"写工具选用 `ls` 样本路径"可能涉及**样本选择、工具匹配、模板适用域**的实现缺口，本轮证据只排除了"模型省略/质量"一类原因，**没有排除这些实现层可能**，也不能据此要求 Owner 改变政策。后续任务应独立核查真实样本的工具匹配与模板适用范围。

**停止依据（按任务纪律）**：两次完整链路、同一条确定性用例、3 次同因失败——相同失败重复出现即先定位原因，不再无界重试。全程未删引用要求、未降低校验、未延长超时/预算制造绿灯，未改 gate，未代 Owner 批准或激活任何原则。

**候选解除路径（r3：待取证，不是"必须三选一"）。** r2 把它写成"解除需 Owner 三选一"，措辞过强——其中两条的前提证据还没取到，列为候选并标注取证状态；任何一条被选中前都不动 gate、不动校验器、不动 Owner 意图。

| 路径 | 动作 | 取证状态 | 代价 |
|---|---|---|---|
| (a) 改 oracle 口径 | 为 `v2-path-boundary` 增加与 helper 段豁免同族的"意图声明不干预域"豁免 | **Unknown** — 会影响哪些既有 v2 规则未统计（需跨 run 取证，不在本任务范围） | 动确定性 gate，需 ADR + Owner 批准，波及所有 v2 规则 |
| (b) 改意图契约侧 | Scribe 在 `validationExpectation` 中对 `.bak` 兄弟路径明确"须确认" | **部分** — 冲突文本已逐字定位（仅链 B）；但 `intentContract` 是 LLM 产物，改上游提示能否稳定产出该句 = Unknown | 不动 gate；需重跑整条内化链 |
| (c) 换证据 | 用真实宿主新采集一组正例，其路径落在**已证的** helper 段（`tmp`/`temp`/`draft`；**不含 `backup`/`backups`**）内重跑 Golden Journey | **机制已证** — 生产方法实测该分支下 `v2-path-boundary` expectedDecision=allow | gate 与校验一字不动；被演示的行为断言随之变化 |

明确排除的取巧法：把 `affectedTools` 首位排成非 write 工具（链 A r2 的 `ls` 就是这样）会让 v2 模板整批跳过，消费者输出里也没有 `adversarialResult`（该 run 的整轮 gate 执行情况**尚未确认**，见上文）——那是**没有证据**，不是通过；本轮不把它当作任何缺口的解除，也不得为制造绿灯而重排。

**顺带发现（未实现，作 follow-up 候选）**：① run B 的规则把 `context.version !== 2 → allow` 放在 `isRiskPath()` 之前，违反提示词已陈述的 ADVERSARIAL GUARD CONTRACT（风险路径无论如何 block）——现有 5 条模板没有"context 不可用 + 风险路径"用例，故 gate 抓不到；② 失败 run 不落 `output_payload`（诊断不可见）；③ `trajectory.db pain_events.text` 存在 GBK 乱码。①②已作为 **ERR-157**（`docs/process/error-management/records/patterns/P-20261010T092439Z-x4r7na.md`，提示词↔校验器义务不对称）入库并在 EP-03 卡片加 Must-check。

### 7.2 B-2 改判：**真实 Codex CLI 会话已接入**（r1 两条阻塞理由被实测推翻）

真实证据（隔离 `CODEX_HOME=C:\Users\Administrator\.pd-p1test\codex-home`，`PD_WORKSPACE_DIR=D:\Code\_pdtest\p1-acceptance\codex-ws`，codex-cli 0.162.1）：

| 会话 | 结果 |
|---|---|
| `01a12535-69f2-…`（17:47） | 真实模型输出，tokens 7,649，EXIT=0；五个 PD hook 事件（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop）全部触发并 Completed；写文件被 Codex 自身策略拒绝 |
| `01a1253b-4b13-…`（17:53） | 同上，tokens 12,163，EXIT=0；**真实创建 `pd-codex-accept.txt`（17 字节，内容 PD-P1-ACCEPT-B2）并由会话内 cat 回显** |

所以 r1 记录的"AMD 端点不支持 Responses API"不成立：`wire_api="responses"` 在该端点真实可用并有实际成功输出（不是配置或探测状态）。凭据合规：未复制任何 `auth.json`；隔离 config.toml 只写 `env_key` 名称与已授权测试 provider 的 key；全程只打印密钥存在性与长度。

通道与沙箱事实（如实披露）：

- 该端点对 `DeepSeek-V4-Flash` 拒绝 native web search，须 `-c web_search=disabled`；`config.toml` 里 `tools.web_search=false` 不是有效开关（会话 1 即因此 EXIT=1）。
- `sandbox: read-only` 下 Codex 自身策略拒绝写（`CreateProcess … rejected: blocked by policy`）；0.162.1 的 `codex exec` 已无 `-s workspace-write`，`-c sandbox_mode=workspace-write` 也不生效（banner 仍 read-only）。为取得一次真实成功的工具写入，最后一次会话在**空的一次性 scratch 目录** `codex-proj` 上使用 `--dangerously-bypass-approvals-and-sandbox`（并沿用 `--dangerously-bypass-hook-trust`）。绕开的是 Codex 自身沙箱，不是 PD 的 gate——PD hook 全程照常触发。

**新缺口 G-Codex-1（标准 2 未完整闭合的原因）**：按官方插件安装的 Codex 宿主今天**没有 Phase 1 证据面**。插件 pin（`runtime-version.json`）= codex-adapter 0.4.7 / host-runtime 0.7.11 / core 1.287.6；对安装 dist 全量检索 `intervention_evidence` / `behavior_episode` / `codex-evidence-recorder` → **0 命中**（codex-adapter 17 个 js + host-runtime 30 个 js）。仓库 HEAD 有 `packages/codex-adapter/src/codex-evidence-recorder.ts`（0.5.1），即该能力目前只存在于未安装源码。升级 pin 属发布资产变更，须 Owner 裁决。

**新缺口 G-Codex-2（未定论，不当作已证实缺陷）**：该真实会话在沙箱工作区未留下任何观测——`codex-ws/.pd/state.db` 与 `.state/trajectory.db` 各表全 0 行，`.state/logs/` 目录不存在；但两库的 `-shm/-wal` 在 17:53–17:54 被更新，说明 hook 确实连到了指定工作区。安装 dist 里 PostToolUse 的落库路径是 `production-pain-evidence.js:248 → events.recordToolCall()`，0.4.7 的实现只 `appendEventLogLine`（jsonl）而不写 trajectory 表；`admission.js:buildLiveToolCandidate` 在 `toolUseId` 为 null 时返回 null，而会话 rollout 含 `turn_id`（29 次）却无 `tool_use_id`——这是最可能的分支，但缺少 hook stdin 原始 payload 的直接证据（取得它需改动安装插件文件，已被边界禁止）。记为未定论。

**隔离取证含一次自我纠正（如实记录）**：初见 `D:\.openclaw\workspace` 在 17:54 被写，疑为泄漏；内容检索否证——Owner 工作区 `state.db` / `trajectory.db` 中不存在该 Codex 会话 id 或测试标记（`pd-codex-accept` / `PD-P1-ACCEPT-B2`），事件日志亦无；`signal-health.json` 的 `observerLastSuccessAt=2026-10-10T09:45:25.018Z` 与 `SYSTEM_*.log` 的 09:54:10Z 条目是 Owner 自身在跑的网关 observer / internalization consumer 的周期写（时间戳属其自身 2 分钟调度）。结论：真实 Owner workspace 零测试写入。

**遗留**：隔离安装写过 `~/.pd/install.json` 测试条目，可用插件自带 `scripts/pd-disable.cjs` 清理；`~/.codex/pd-workspace/*.backup-before-evtest-cleanup` 仍在，待 Owner 择期删除。

### 7.3 N-1 维持 NOT RUN（依赖已由源码证实，非推测）

`packages/pd-console/src/server/routes/evidence-outcomes.ts` 的封闭字段集只接受 `episodeKey / observationSummary / feedbackText`，且需要一个**已存在的 Behavior Episode**；而 `behavior_episode` 只由 `packages/openclaw-plugin/src/core/intervention-evidence-recorder.ts` 在 gate block / auto-correct 路径产生（episodeKey 形如 `openclaw|episode|<session>|<toolKey>`）。沙箱现状：仅 1 条 prompt 激活（`act_prompt_0a54f406-…`）、无 code_tool_hook 规则工件、`intervention_evidence_records` 只有 delivery（agent_context / submitted / attempted）与 application（agent_claimed）两行且 `episode_key` 为空。在禁止手工插表的前提下，N-1 只能等 B-1。

### 7.4 本轮入库改动与验证

改动面（全部在 `packages/principles-core` + 错误记录 + 本报告）：artificer 提示词义务条款与示例占位标注、契约版本 v9 → v10、义务文本单测收紧（不再断言 `was rewritten`）、ERR-157 记录与 ERROR_PATTERN_INDEX 映射、changeset（`@principles/core` patch）。

r3 相对 r2 的净改动面（4 个文件 + 1 条新记录）：`artificer-prompt-builder.ts`（v10 + 义务条款重写）、`artificer-prompt-builder.test.ts`（版本 pin 两处 + 义务断言改为可达向量并加 `not.toContain('was rewritten')` 负控）、本报告（删失实主张、两分支生产表、来源一致性表、§7.7 复现方法、恢复步骤 ① 修正）、`.changeset/pdv2-p1-artificer-echo-obligation.md`（v9 → v10 描述）、`error:record add-occurrence` 新增 `OCC-20261010T113513Z-ngbyyt`（ERR-157 修正走 occurrence，pattern 正文按记录维护规则不改）。

验证：

- `npm run error:record validate` → `OK: 157 patterns, 288 occurrences`（exit 0）
- `npm run check:error-handbook` → `OK: 117 active / 40 archived, 288 occurrences (83 structured), 14 routing cards`（exit 0，即 merge gate）
- `npm run error:context`（diff 模式）→ HIGH 5 张（EP-03/EP-14/EP-02/EP-05/EP-09）、MEDIUM 1（EP-01）、LOW 3（EP-06/EP-08/EP-10），逐条对账见 PR 描述
- `npx vitest run src/runtime-v2/internalization`（本地，`@principles/core`）→ **77 files / 1146 tests 全绿**，exit 0（含 `artificer-prompt-builder.test.ts` 36 tests）
- `npm run verify:merge` → **exit 0**，2026-10-10 19:54:57–19:57:39（本地，`NODE_OPTIONS=--max-old-space-size=8192`），`npm run lint` 段 **0 errors / 36 warnings（均为既有告警）**，未跳过任何规则或文件

门跑实况（如实记录，不粉饰为一次通过）：r2 曾出现 eslint 在默认 4 GB V8 堆上限处崩溃（`FATAL ERROR: Ineffective mark-compacts near heap limit`，约 61 s 处，heap ≈4030 MB）——那是 lint 进程的内存上限问题，不是 lint 判定失败；加 8 GB 后同一命令可重复 0 errors。r3 沿用 8 GB 环境变量一次跑通（exit 0），**该环境边际未在本轮修复**，仍记为 follow-up；本轮没有把它包装成"已解决"。

### 7.5 六条完成标准 r2/r3 重判

| # | 标准 | r1 | r2 | 依据 |
|---|---|---|---|---|
| 1 | 至少一宿主真实完整链 | ✗ | **✗**（拦截链仍 BLOCKED；r3 把根因钉到"模板写目标取自一条 `ls` 观测"，是否违背 Owner 意图 = Unknown） | §7.1 / §7.7 |
| 2 | 另一宿主真实接入验证并披露缺口 | 部分 | **部分（显著推进）**：真实 Codex CLI 会话✓、五事件 hook 通路✓；缺口如实披露=G-Codex-1（安装 pin 无证据面）+ G-Codex-2（观测未落库，未定论） | §7.2 |
| 3 | Console 查询与 Owner 结果提交真实可用 | 查询✓ / 提交 NOT RUN | 不变：查询✓，实宿主提交仍 NOT RUN（依赖证据 §7.3） | §7.3 |
| 4 | 重放、重启及关键失败边界 | ✓ | ✓ | r1 §5 |
| 5 | BDD 与规定检查通过 | ✓ | ✓（BDD 6/6；本轮改动另需 PR 检查绿） | §7.4 |
| 6 | SPEC 无未解释必需缺项 | ✓ | ✓（13.9 仍为"部分"，缺项有生产级根因，解除路径为**待取证候选**而非三选一） | §7.1 / §7.7 |

**总判定：仍为 PARTIAL。** r2 的净变化不是"更接近 COMPLETE"的档位变化，而是把 B-1 从"待重试的稳定性问题"改判为"gate 设计与上游意图文本的冲突"，并把 B-2 从"环境能力不可能"改判为"已接入 + 两个具体缺口"。r3 再把这个冲突收窄并已用生产方法证实：模板的写目标来自 Owner 标注的 `ls` 证据（`case-positive-6` = `ls {"path":"."}`），于是要求对字符串拼接出的 `..bak` 写入 block；三个失败 run 的失败用例都由模板派生（生产方法证实，非底层函数直连）。意图侧只有链 B 逐字冲突，链 A 只能推断，"是否违背 Owner 意图"整体记 Unknown。同时把"Owner 必须三选一"降级为三条**取证状态各不同**的候选路径（§7.1）。升级 COMPLETE 仍须：B-1 按某条候选路径补齐前提后真实跑通拦截链、N-1 实宿主提交、G-Codex-1 由 Owner 裁决（升级 pin 或认可的替代证明）、六条逐条重新取证。

### 7.6 r2/r3 证据索引增补

| 证据 | 位置 |
|---|---|
| Codex 真实会话 rollout | `C:\Users\Administrator\.pd-p1test\codex-home\sessions\2026\10\10\rollout-2026-10-10T17-53-25-01a1253b-….jsonl`（含 turn_id、无 tool_use_id） |
| Codex 会话完整日志（脱敏） | `D:\Code\_pdtest\p1-acceptance-r2\logs\codex-exec-1..5.log`（含 hook 事件行、EXIT 行） |
| Codex 真实写入产物 | `D:\Code\_pdtest\p1-acceptance\codex-proj\pd-codex-accept.txt` |
| Codex 沙箱工作区 | `D:\Code\_pdtest\p1-acceptance\codex-ws`（`.pd/state.db`、`.state/trajectory.db` 各表 0 行、无 `.state/logs/`） |
| 安装 pin 与能力取证 | `…\codex-home\plugins\cache\principles\principles-disciple\0.1.0\runtime-version.json`；`…\plugins\data\principles-disciple-principles\runtime\node_modules\@principles\{codex-adapter,host-runtime}\dist`（grep 命中数见 §7.2） |
| B-1 失败/通过记录 | 沙箱 `state.db` runs 表：artificer 08:54:51 / 09:03:02 / 09:24:26 / 09:35:31（契约通过）；evaluator 09:02:01 / 09:33:13 / 09:42:42（`v2-path-boundary` block/allow）；scribe 行 `output_payload`（意图契约原句） |
| 提示词修复 | `packages/principles-core/src/runtime-v2/internalization/artificer-prompt-builder.ts`（`ARTIFICER_PROMPT_CONTRACT_VERSION = 'artificer-output-v2.prompt.v10'`；v8→v9 补义务、v9→v10 收回 `was rewritten` 过度声明）+ 同目录 `__tests__/artificer-prompt-builder.test.ts` |
| r3 生产派生复现 | `D:/pd-probe-pdv2-r3/derivation-report.json`（脚本 `probe-derivation.mjs` / `probe-echo-history.mjs` / `probe-pack-intent.mjs`，只读探针，未入库；数字见 §7.7） |
| Owner 标注证据来源 | `D:\Code\_pdtest\p1-acceptance\behavior-examples.json`（`positiveToolCallIds:[6]`）→ `trajectory.db` `tool_calls` id=6（`ls {"path":"."}`，success）；`sourceNegativeToolCallId:5` → id=5（`ls {"path":"protected"}`，ENOENT） |
| ERR | `docs/process/error-management/records/patterns/P-20261010T092439Z-x4r7na.md`（ERR-157）+ `ERROR_PATTERN_INDEX.md` EP-03；r3 修正走 `add-occurrence`（`records/occurrences/P-20261010T092439Z-x4r7na/OCC-20261010T113513Z-ngbyyt.md`），记录维护规则下 pattern 正文不改，故该卡"missing **or reworded**"一句保持原样，修正口径以 occurrence 为准 |

### 7.7 r3 生产复现方法（可重跑；结果表见 §7.1）

本节只记录**怎么证的**，数字与分支结论在 §7.1，避免同一张表两处漂移。

被调用的生产序列（未改动的编译产物 `packages/principles-core/dist/runtime-v2/internalization/evaluator-runner.js`）：

```
parseArtificerArtifact(contentJson)        # evaluator-runner.ts:2160 → 2808-2831
  → extractPositiveCases(parsed.goldenTraceCases)   # :2183 → :2885
  → generateV2CasesFromArtificer(parsed.affectedTools, positives, taskId, runId)  # :2200 → 2988-3069
                                             #   :3047 canonicalKind
                                             #   :3054-3062 非 write → 整批跳过 + 遥测，返回 []
                                             #   :3064 转调底层模板
```

输入取自沙箱 `pi_artifacts.content_json`（4 个真实 Artificer 工件）与 `runs.output_payload`（4 个真实 evaluator run）。替换的只有遥测端口：`Object.create(EvaluatorRunner.prototype)` + `config.runnerName` / `resolvedOptions.{owner,agentId}` + 一个把 `emitTelemetry` 收进数组的桩（`base-peer-runner.ts:351-364` 是唯一的 `eventEmitter` 消费点）。三个方法体一字未动，`oracle`、`gate`、DB、dist 全程只读。

跳过分支的逐字遥测（链 A r2 的 `ls`）：

```
eventType=evaluator_v2_adversarial_cases_skipped
reason=non_write_canonical_kind_for_v2_adversarial_cases
toolName=ls  canonicalKind=other
nextAction=verify_artificer_target_tool_is_write_kind_or_supply_custom_adversarial_cases
```

两个取证坑（如实记录，因为它们决定了结论有效性）：

1. 做 helper 段边界探针时必须替换 **`extractPositiveCases` 返回的第一条正例**。第一版脚本改的是 `goldenTraceCases[0]`，而那是负例 `case-negative-5`，于是 `positives[0]` 没被碰过，tmp 与 backup 得到完全相同的结果——看起来像"豁免无效"，其实是替换没生效。改对以后才观察到 §7.1 的 allow/block 分布。
2. r2 的"生产复现"是直接 `node -e` 调底层 `generateV2ContextAdversarialCases`，绕开了 `:3054-3062` 的 kind gate，**主张作废**（§7.1 已删除该表述）。底层调用只能证明模板自身的算术，不能证明生产会去调它。

证据产物（本地，未入库——只读探针，非交付工件）：`D:/pd-probe-pdv2-r3/derivation-report.json`（完整输出）、`probe-derivation.mjs`、`probe-echo-history.mjs`（回显义务的历史活证）、`probe-pack-intent.mjs`（Owner pack ↔ Scribe intent 一致性）、`dump-runs.mjs`、`schema.mjs`。
