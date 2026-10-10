# PD v2 Phase 1 实宿主验收报告（收口）——PARTIAL

> 日期：2026-10-10（Asia/Shanghai）
> 验收对象：PR #1957（merge commit d5732f84，2026-10-08T14:26:14Z）
> 安装身份：安装运行时 = origin/main 同版（core 1.290.0 / host-runtime 0.8.0 / principles-disciple 2.1.0 / codex-adapter 0.5.0 / console 0.1.0，root 2.3.0）；已核实安装产物含全部 Phase 1 模块
> 宿主版本：OpenClaw 2026.9.9 (bcfc888)；codex-cli 0.162.0
> 持久化说明：按 2026-10-07 Owner 裁定（docs/audit 不跟踪），本报告与证据索引保存于既有持久交付位置 docs/implementation-reports/；工作底稿（含完整命令记录）为本地不跟踪文件。
> 验收 PR：#1977（BDD 资产；本报告随该 PR 入库并在 PR 描述链接）

## 0. 结论（按 Owner 复核纠正后的表述）

**Phase 1 判定 PARTIAL。** prompt 通道的真实治理链（pain → 诊断 → Gate B → intake → 内化 → Console 审批 → 激活）与投递-自述证据在真实宿主成立；四问查询与 Owner 结果入口的契约在真实路由上验证。强制证据链未执行（BLOCKED 于规则内化阶段），Codex 真实 CLI 会话 NOT RUN，Owner 结果的实宿主提交未完成——因此不仅拦截链待补，**即便拦截链补完也不能直接升级 COMPLETE**：必须按全部六条完成标准（含另一宿主真实接入、Owner 结果实宿主提交）重新判定。

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

- **事实陈述**：当前只能确认阻塞发生在**规则内化阶段**（run-rulehost 对抗循环 6 次真实尝试失败）。强制证据链（gate 拦截之后的全部写入路径）**尚未执行过**——因此不能对"强制证据链基础设施无缺陷"作出任何断言；其真实缺陷（如有）只会在 B-1 解除后暴露。
- 失败模式（均有落库记录）：① L2 总预算 300s 超时（模型慢；--timeout-ms 900000 可缓解）；② 网关 auto-consumer 与循环抢跑 artificer 任务（task-driven runner 无 pack 先写先赢；停网关可消除）；③ 模型产出未满足 v2 Artificer 校验契约（RuleCode evidenceRefs 须精确引用 Owner 标注样本，DeepSeek-V4-Flash 反复省略）；④ AMD 端点 429 限流。已排除：管线布线（dreamer/philosopher/scribe 全 succeeded）、Gate B、审批、激活均真实走通；有一次 artificer run 成功产出实现代码但循环后续环节仍降级。
- 恢复步骤：① 恢复可用模型通道（本地 qwen3.8-27b 引擎重启，或更强指令遵循模型）后重跑 `pd runtime internalization run-rulehost --pain-id pain_host_79143661... --behavior-examples D:\Code\_pdtest\p1-acceptance\behavior-examples.json --timeout-ms 900000 --confirm`；② 循环通过 → Console 批准 → code_tool_hook 激活；③ 重放 GJ 会话写 protected/ 路径，采集拦截链证据；④ Console 提交 Owner 结果；⑤ 重新执行完整验收判定。

### B-2 Codex 真实 CLI 会话：**NOT RUN（环境能力）**

- ① codex ≥0.162 移除 `wire_api="chat"`，自定义 provider 须支持 Responses API（AMD 端点不支持；本地引擎验收中途下线）；② Owner gpt-6.1-sol 走 OpenAI 订阅凭据，克隆到隔离环境违反凭据隔离；真实配置直跑会污染 Owner `~/.codex/pd-workspace`。
- 已验证的 Codex 真实面：真实安装的 pd-hook 产物（dist 子进程全契约）在 #1957 验收 16/16 中通过；能力矩阵如实声明（self_report=Unsupported、enforcement=Unknown，PRI-780 产品事实）。
- 恢复步骤：Owner 以订阅凭据在含测试区 pd-workspace 指向的隔离 CODEX_HOME 跑 `codex exec`；或等待支持 Responses 的本地/测试通道。

### N-1 Owner 结果实宿主提交：**NOT RUN**（依赖 B-1 的 Episode；路由契约已由 BDD 在真实路由代码上验证）。

### N-2 边界验证分工：重放/冲突/停用后重放/写失败翻转/降级区分 = 工程回归；实宿主可直接观察的边界（自述区分、submitted≠delivered、四问空区、重启查询、能力披露）= 真实运行。停用后历史重放保留原关联：工程覆盖，实宿主未单独演练（依赖 B-1）。

## 4. 环境事实与过程披露

- 隔离合规：测试数据全部位于 `D:\Code\_pdtest\p1-acceptance` 与 `C:\Users\Administrator\.pd-p1test`；机器级 `PD_WORKSPACE_DIR` 在所有调用中显式覆盖，真实 Owner workspace 零写入。
- 无手工插表：治理链全部经真实 CLI/服务/Console API；证据全部经共享 ingress+normalizer。
- 既有产品行为记录（不修，留档）：Gate B 对无 trace manual pain 拒绝（设计）；philosopher/evaluator 默认关闭使 run-rulehost 首跑被拒；openclaw CLI 前端在本机对部分子命令挂起（网关形态正常，已按网关 API 驱动绕开）。
- 遗留备份：`~/.codex/pd-workspace/*.backup-before-evtest-cleanup` 待 Owner 择期删除。
- 本报告无任何真实凭据；隔离网关 token 为测试自造值。

## 5. 完成标准对照（任务 §八六条）

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
