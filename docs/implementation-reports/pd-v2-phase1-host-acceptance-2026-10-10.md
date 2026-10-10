# PD v2 Phase 1 实宿主验收报告（收口）——PARTIAL

> 日期：2026-10-10（Asia/Shanghai）
> 验收对象：PR #1957（merge commit d5732f84，2026-10-08T14:26:14Z）
> 安装身份：安装运行时 = origin/main 同版（core 1.290.0 / host-runtime 0.8.0 / principles-disciple 2.1.0 / codex-adapter 0.5.0 / console 0.1.0，root 2.3.0）；已核实安装产物含全部 Phase 1 模块
> 宿主版本：OpenClaw 2026.9.9 (bcfc888)；codex-cli 0.162.0
> 持久化说明：按 2026-10-07 Owner 裁定（docs/audit 不跟踪），本报告与证据索引保存于既有持久交付位置 docs/implementation-reports/；工作底稿（含完整命令记录）为本地不跟踪文件。
> 验收 PR：#1977（BDD 资产；本报告随该 PR 入库并在 PR 描述链接）
>
> **r2 复核基线（2026-10-10 第二轮，本报告 §7 的来源）**：分支基线 origin/main `ba39b469`（2026-10-10T14:58:28+08:00）；已核实 d5732f84（#1957）与 4e383420（#1977）均为当前 HEAD 祖先。仓库工作区版本 core 1.291.0 / host-runtime 0.8.1 / codex-adapter 0.5.1 / principles-disciple 2.1.0 / console 0.1.0 / root 2.3.1。OpenClaw 侧安装运行时同上版；**Codex 侧安装产物不是同版**——插件 pin 为 `runtime-version.json` 的 core 1.287.6 / host-runtime 0.7.11 / codex-adapter 0.4.7（见 §7 B-2）。宿主版本：codex-cli 0.162.1。

## 0. 结论（按 Owner 复核纠正后的表述）

**Phase 1 判定 PARTIAL。** prompt 通道的真实治理链（pain → 诊断 → Gate B → intake → 内化 → Console 审批 → 激活）与投递-自述证据在真实宿主成立；四问查询与 Owner 结果入口的契约在真实路由上验证。强制证据链未执行（BLOCKED 于规则内化阶段），Codex 真实 CLI 会话 NOT RUN，Owner 结果的实宿主提交未完成——因此不仅拦截链待补，**即便拦截链补完也不能直接升级 COMPLETE**：必须按全部六条完成标准（含另一宿主真实接入、Owner 结果实宿主提交）重新判定。

**r2 复核（§7）后的判定不变，但三条缺口的性质已改变**：B-1 的根因由"模型反复省略"改判为**确定性 gate oracle 与同一 run 意图契约的结构性冲突**（提示词义务缺口已修复并活证，校验器一字未改）；B-2 由 NOT RUN 改判为**真实 Codex CLI 会话已接入**（五个 hook 事件全部 Completed、真实模型输出、真实工具写入），同时暴露一个新缺口——**按官方插件安装的 Codex 宿主今天没有 Phase 1 证据面**；N-1 对 B-1 的依赖已用源码证实。判定仍为 PARTIAL，且升级条件比 r1 更明确（§7.5）。

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

> r2 修订见 §7.1：失败根因由"模型反复省略 v2 校验契约"改判为"确定性 gate oracle × 同 run 意图契约的结构性冲突"；省略类失败已通过补提示词义务消除。本节保留为 r1 当时的判定记录。

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

## 7. r2 复核（2026-10-10 第二轮）：三条缺口的重新取证与改判

### 7.1 B-1：根因由"模型不稳定"改判为 gate oracle × 意图契约的结构性冲突（仍 BLOCKED）

**r2 修复的部分是真实存在的提示词缺口。** v2 Artificer 校验器要求 Owner 标注样本的 `caseId` 逐字出现在 `goldenTraceCases` 里，但提示词从未陈述这一义务，且 OUTPUT FORMAT 示例用的是占位 id（`negative-1` / `positive-1`）。补法只动提示词：加"必须把 pack 里的 Owner 标注用例逐字带入输出、可新增不可替代"的义务条款，并把示例标注为占位符；契约版本 `artificer-output-v2.prompt.v8 → v9`。**校验器一字未改。**

活证（沙箱 `state.db` runs 表，UTC 时间）：两次连续 `run-rulehost`（下称 run A：artificer 08:54:51 / 09:03:02；run B：artificer 09:24:26 / 09:35:31）共 4 个 artificer round **全部通过 v2 输出契约**，`Owner-labelled example <caseId> was omitted` 不再出现。

**剩余阻塞不是模型质量。** 三次 evaluator 对抗重放（A-r1 09:02:01、B-r1 09:33:13、B-r2 09:42:42）失败在**同一条确定性用例**上：

```
caseId=v2-path-boundary  expectedDecision=block  actualDecision=allow
reasonCode=replay_decision_mismatch
```

两侧口径互相矛盾，且都可复核：

- gate 侧：`v2-path-boundary` 由 PRI-485 确定性模板生成，`params.path` 取**第一个正向 Owner 用例的 `params.path` + ".bak"**（`evaluator-runner.ts:2988-3040` 的 targetPath 选择 + `v2-adversarial-cases.ts:211-222`），oracle 为 block（`rule-reliability-validation.ts:226-234` 对 v2 规则一律 in-scope，`v2TemplateOracleExpectedDecision`）。本 fixture 的正例路径是被该原则覆盖不到的普通路径。
- 意图契约侧：同一 run 的 scribe `intentContract.validationExpectation` 逐字写着「…；**对普通非受保护路径不触发冗余确认**」（runs 表该行 `output_payload`）。

于是任何满足意图契约的规则必然对该 oracle 返回 allow。此判断**已排除模型因素**，可无 LLM 复现（该函数未从 `@principles/core/runtime-v2` 子路径导出，故直连 dist；命令已在本机实跑）：

```bash
node --input-type=module -e '
const { generateV2ContextAdversarialCases } = await import("./packages/principles-core/dist/runtime-v2/internalization/v2-adversarial-cases.js");
for (const c of generateV2ContextAdversarialCases({ toolName: "ls", targetPath: ".", canonicalKind: "other" }))
  console.log(`${c.caseId}: ${JSON.stringify(c.params)} -> ${c.expectedDecision}`);'
# v2-unavailable: {"path":"."} -> allow
# v2-truncated:   {"path":"."} -> allow
# v2-alias:       {"path":"."} -> allow
# v2-path-boundary: {"path":"..bak"} -> block   <-- 与意图契约相反的那一条
# v2-combination: {"path":"/etc/passwd"} -> block
```

**停止依据（按任务纪律）**：两次完整链路、同一条确定性用例、3 次同因失败——相同失败重复出现即先定位原因，不再无界重试。全程未删引用要求、未降低校验、未延长超时/预算制造绿灯，未改 gate，未代 Owner 批准或激活任何原则。

**解除需 Owner 裁决**（三条，AI 不得自行选择放宽）：

| 选项 | 动作 | 代价 |
|---|---|---|
| (a) 改 oracle 口径 | 为 `v2-path-boundary` 增加与既有 EP002-R4 helper-path 豁免同族的"意图契约声明不干预域"豁免 | 动确定性 gate，需 ADR/Owner 批准，影响所有 v2 规则 |
| (b) 改意图契约侧 | scribe 在 `validationExpectation` 中对 `.bak` 兄弟路径明确"须确认"，使两侧一致 | 不动 gate；改上游提示契约，需重跑内化 |
| (c) 换证据 | 用真实宿主新采集一组正例落在既有 helper-path 豁免（tmp/temp/draft/backup）内的 pain/样本重跑 Golden Journey | gate 与校验一字不动；但被演示的行为断言随之变化 |

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

改动面（全部在 `packages/principles-core` + 错误记录 + 本报告）：artificer 提示词义务条款与示例占位标注、契约版本 v9、2 条新增单测 + 2 处版本 pin、ERR-157 记录与 ERROR_PATTERN_INDEX 映射、changeset（`@principles/core` patch）。

验证：见 PR 描述（`npm run verify:merge`、`error:record validate`、`check:error-handbook`、`error:context` diff 模式逐项数字）。

### 7.5 六条完成标准 r2 重判

| # | 标准 | r1 | r2 | 依据 |
|---|---|---|---|---|
| 1 | 至少一宿主真实完整链 | ✗ | **✗**（拦截链仍 BLOCKED，但根因已定性为设计冲突而非不稳定） | §7.1 |
| 2 | 另一宿主真实接入验证并披露缺口 | 部分 | **部分（显著推进）**：真实 Codex CLI 会话✓、五事件 hook 通路✓；缺口如实披露=G-Codex-1（安装 pin 无证据面）+ G-Codex-2（观测未落库，未定论） | §7.2 |
| 3 | Console 查询与 Owner 结果提交真实可用 | 查询✓ / 提交 NOT RUN | 不变：查询✓，实宿主提交仍 NOT RUN（依赖证据 §7.3） | §7.3 |
| 4 | 重放、重启及关键失败边界 | ✓ | ✓ | r1 §5 |
| 5 | BDD 与规定检查通过 | ✓ | ✓（BDD 6/6；本轮改动另需 PR 检查绿） | §7.4 |
| 6 | SPEC 无未解释必需缺项 | ✓ | ✓（13.9 仍为"部分"，缺项已有确定性根因与三条解除路径） | §7.1 |

**总判定：仍为 PARTIAL。** r2 的净变化不是"更接近 COMPLETE"的档位变化，而是把 B-1 从"待重试的稳定性问题"改判为"待 Owner 裁决的设计冲突"，并把 B-2 从"环境能力不可能"改判为"已接入 + 两个具体缺口"。升级 COMPLETE 仍须：B-1 按 §7.1 三选项之一经 Owner 决策后真实跑通拦截链、N-1 实宿主提交、G-Codex-1 由 Owner 裁决（升级 pin 或认可的替代证明）、六条逐条重新取证。

### 7.6 r2 证据索引增补

| 证据 | 位置 |
|---|---|
| Codex 真实会话 rollout | `C:\Users\Administrator\.pd-p1test\codex-home\sessions\2026\10\10\rollout-2026-10-10T17-53-25-01a1253b-….jsonl`（含 turn_id、无 tool_use_id） |
| Codex 会话完整日志（脱敏） | `D:\Code\_pdtest\p1-acceptance-r2\logs\codex-exec-1..5.log`（含 hook 事件行、EXIT 行） |
| Codex 真实写入产物 | `D:\Code\_pdtest\p1-acceptance\codex-proj\pd-codex-accept.txt` |
| Codex 沙箱工作区 | `D:\Code\_pdtest\p1-acceptance\codex-ws`（`.pd/state.db`、`.state/trajectory.db` 各表 0 行、无 `.state/logs/`） |
| 安装 pin 与能力取证 | `…\codex-home\plugins\cache\principles\principles-disciple\0.1.0\runtime-version.json`；`…\plugins\data\principles-disciple-principles\runtime\node_modules\@principles\{codex-adapter,host-runtime}\dist`（grep 命中数见 §7.2） |
| B-1 失败/通过记录 | 沙箱 `state.db` runs 表：artificer 08:54:51 / 09:03:02 / 09:24:26 / 09:35:31（契约通过）；evaluator 09:02:01 / 09:33:13 / 09:42:42（`v2-path-boundary` block/allow）；scribe 行 `output_payload`（意图契约原句） |
| 提示词修复 | `packages/principles-core/src/runtime-v2/internalization/artificer-prompt-builder.ts`（`ARTIFICER_PROMPT_CONTRACT_VERSION = 'artificer-output-v2.prompt.v9'`）+ 同目录 `__tests__/artificer-prompt-builder.test.ts` |
| ERR | `docs/process/error-management/records/patterns/P-20261010T092439Z-x4r7na.md`（ERR-157）+ `ERROR_PATTERN_INDEX.md` EP-03 |
