# PD Adaptive Activation — PRI-1119 正常入口可行性（只读调查）

- 日期：2026-11-07
- 工单：PRI-1119（`In Progress`；PRI-1118 仍为 blocker）
- 分支：`ai/PRI-1119-g2-entry-feasibility`
- Base：`cdd0276508e510190f4e0ac9df527ab13ce5d739`（= `origin/main`；PR #2402 已 MERGED，merge commit 同值）
- 规范：`docs/specs/PD Adaptive Activation SPEC v0.6.md`（§7 L171、G1 L190、G2 L191、C04 L203）
- 性质：**只读调查 + 方案**。本轮 0 宿主回合、0 HTTP、0 模型调用、0 付费调用；未安装/升级、未写生产库、未改配置、未改预算/冻结证据/历史判定。

---

## 1. 结论

**入口可行性 = CONDITIONAL。G2 窗口按现状 = NO-GO。**

一句话：**正常入口真实存在、且在每个真实宿主轮次实际运行；但它不能可靠地把“指定的一条原则”送达，PD 自身也拿不到最终请求正文来做独立确认。**

拆成两个不同的问题，答案不同：

| 问题 | 结论 | 最强依据 |
|---|---|---|
| 普通真实任务能否通过正常入口注入“已授权、已激活”的原则？ | **GO（仅注入机制）** | 生产 8 天 238 次 prompt 构建均产生 `runtime_v2_prompt_activations_injected`；`runId` 为真实 UUID，`eligibleCount` 恒为 18 |
| 能否可靠激活“指定的一条”原则？ | **待场景样本核实（原 NO-GO 撤回）** | 97/238 = 40.8% 仅是该日志范围内的**目标注入比例**，不是交付场景覆盖率；预算在 2000/4000/15625/31250 间变化，丢弃条数不固定；fair rotation 不是随机分组或行为对照 |
| 能否独立确认“该请求正文里确有目标文本”？ | **NO-GO（现状）** | PD 只返回 `prependSystemContext` 片段，最终请求由宿主组装；仓库与安装产物中无请求正文/哈希捕获 |
| 能否把上述缺口改造成可用入口？ | **CONDITIONAL** | 存在两条最小修正路径（§7），均需 Owner 批准，且第二条落在 PD 边界之外 |

**不得**把受控实验（`controlledAdmission`，操作者冻结输入）当作普通真实入口的证据。也不把“缺原生 request ID”直接等同于“所有取证不可能”——三类证据能力分别见 §4。

---

## 2. 核实到的基线事实

| 项 | 值 | 证据来源 |
|---|---|---|
| 最新 main | `cdd027650` | `git rev-parse origin/main` |
| PR #2402 | `MERGED`，merge commit `cdd027650` | `gh pr view 2402 --json state,mergeCommit` |
| 仓库插件版本 | `2.7.1` | `packages/openclaw-plugin/package.json` |
| npm 发布版本 | `2.7.1` | `npm view principles-disciple version` |
| 已安装插件版本 | `2.6.4`（mtime 2026-11-06T14:34:54+08:00） | `~/.openclaw/extensions/principles-disciple/package.json` |
| OpenClaw | `2026.11.1 (4ffdd20)` | `openclaw --version` |
| 宿主模式 | gateway `local`；单 agent `main` | `~/.openclaw/openclaw.json` |
| 主模型 | 配置主模型 = `zai/glm-5.3-flash`（外部付费）；**实际运行漂移**：样本窗口（10-30..11-06）runtime 主要使用 `amd-radeon-cn` 本地网关模型（`DeepSeek-V4-Flash` / `Qwen3.8-Flash-Next`），`zai/glm-5.3-flash` 仅 2 run（见 provider 取证报告 §1） | `openclaw.json` `agents.entries.main.model` + `trace.metadata` 逐 run 统计 |
| 本地 provider | `ninfer` / `lmstudio` / `llamacpp` | 同上（provider keys） |
| 生产 prompt 开关 | `features.prompt.enabled=true` | `D:/.openclaw/workspace/.pd/config.yaml` L5-L7 |
| 生产 `adaptiveActivation` | **未配置**（config.yaml 无该键） | 同上全文检索 `adaptive` = 0 命中 |
| 生产 active prompt activations | 32 条 activation / 18 条 active prompt | `.pd/state.db`（只读） |
| 其中 validated + approved | 14 条 | 同上联表 `pi_artifacts`/`approvals` |

安装产物能力抽查（`~/.openclaw/extensions/principles-disciple` 全量 bundle）：

| 标记 | 命中数 | 含义 |
|---|---:|---|
| `runtime_v2_prompt_activations_injected` | 3 | 安装版有正常注入与观测事件 |
| `adaptiveActivation` | 1 | 安装版有单目标映射配置读取 |
| `PD-AA:delivery-review:v1` | 3 | 安装版有场景标记 |
| `currentUserMessageId` | 4 | 安装版读取原生身份字段 |
| `PD_AA_ADMISSION_FILE` / `PD_AA_ADMISSION` | **0 / 0** | 安装版**没有** controlled admission 回退路径 |

---

## 3. 精确调用链（普通真实任务，现状）

```
OpenClaw gateway (local)  agent=main
  └─ hook: before_prompt_build
     packages/openclaw-plugin/src/index.ts#L459-L462  注册
     packages/openclaw-plugin/src/index.ts#L463-L476  resolveHookWorkspaceDir（失败即跳过，不注入）
        └─ handleBeforePromptBuild
           packages/openclaw-plugin/src/hooks/prompt.ts#L348
           ├─ ctx: workspaceDir / sessionId / runId / trigger   (prompt.ts#L353-L364)
           ├─ PromptActivationReader(wctx.workspaceDir).readActivatedPrinciples()
           │     prompt.ts#L649-L652
           │     core/runtime-prompt-activation-reader.ts#L26-L40  打开工作区 SQLite，listPromptActivations()
           │     core/runtime-prompt-activation-reader.ts#L41-L71  查 pi_artifacts → 解析 principle
           │                                                      → approvals 推导 owner/system_policy 授权
           ├─ filterPromptActivations
           │     principles-core/src/runtime/activation/prompt-activation-reader-contract.ts#L54-L60
           │     仅过滤 channel=prompt / action=prompt_activate / deactivatedAt=null（**无 allowlist**）
           ├─ 预算与轮转
           │     prompt-activation-reader-contract.ts#L140  legacy_fifo_prefix_v1 / fair_rotation_v1
           │     #L153-L156 droppedActivationIds
           │     budget = 4000 chars（生产事件样本 budget=4000）
           ├─ 组装 prependSystemContext / prependContext / appendSystemContext
           │     prompt.ts#L1188-L1192  返回给宿主
           └─ 观测事件（非自适应 journal）
                 prompt.ts#L889-L933  recordRuntimeActivationsInjected
                 字段：hostKind/eventId/sessionId/workspaceDir/runId/principleIds/activationIds/
                       artifactIds/injectedCount/injectedCharCount/budget/selectionPolicy/eligibleCount/
                       rotationStartIndex/selectionRoundOrdinal/droppedActivationIds/预算溯源字段
```

**这条链路里没有的三件事（逐条已核实）：**

1. **没有最终重验**：`revalidateAdaptivePrinciple` 只在 `adaptiveOutcome?.targetBodySha256` 分支调用（`prompt.ts#L1113-L1156`）；普通路径不调用。原则正文在装配时读取一次，装配后不再复核 revision/授权/失效。
2. **没有请求正文**：PD 只产出片段，最终请求由宿主组装。事件只记录 PD 贡献的 ID 与字符数（`injectedCharCount`），不记录合并后的请求体，也不记录其哈希。全仓 `bodySha256` / `promptSha256` / `promptHash` / `requestBody` 检索 = 0 命中。
3. **没有自适应 journal**：`recordAdaptiveDelivery` 仅在 `adaptiveInvocationId` 存在时写入（`prompt.ts#L1173-L1186`）；普通路径没有 `hookInvocationId`，也没有 `submission` 的独立确认（自适应分支同样固定 `submission: 'unknown'`，`prompt.ts#L1179`）。

### 3.1 输入与身份来源

| 事实 | 来源 | 可靠性 |
|---|---|---|
| 当前模型可见用户输入 | `event.prompt`（`prompt.ts#L398-L400` 注释明确：`event.messages` 是已准备的历史，只用于 lineage/轮次索引） | 宿主提供，真实 |
| `sessionId` | hook `ctx.sessionId` | 真实；生产 `assistant_turns`/`tool_calls` 100% 有 session |
| `runId` | hook `ctx.runId` | 真实；`assistant_turns.run_id` 4316/4316 |
| `currentUserMessageId` / `requestId` | `event` 自有属性（`index.ts#L371-L373`） | **embedded 不提供**（`index.ts#L381-L384` 注释：`Embedded OpenClaw supplies no native message identity`） |
| 请求级 ID | 无 | 不存在 |
| 行动 ID | `tool_calls.tool_use_id` | **0/22438 全空**；行动只能靠 `tool_name + params_json + created_at` |

### 3.2 哪个宿主模式能提供这些事实

- 生产在跑的就是 OpenClaw embedded / gateway `local` / 单 agent `main`。正常入口在该模式下工作，且可观测。
- embedded **不提供** `requestId` / `currentUserMessageId`，所以单目标映射的 `hasNativeIdentity` 判定为 false，必须走 controlled admission 回退（`index.ts#L378-L399`）。
- 安装版 2.6.4 **没有** controlled admission（§2 标记 0 命中）→ 单目标映射在已安装环境**不可用**。
- 仓库/发布 2.7.1 有 controlled admission，但它是“操作者冻结输入 + 一次性消费”，属于受控实验路径，不是普通真实任务入口。

---

## 4. 三类证据能力（分列，不合并推断）

| 能力 | 现状 | 证据 | 对 G1/C04 的含义 |
|---|---|---|---|
| **身份**（session/run/turn） | **可用**（turn 级） | 事件含 `sessionId`+`runId`；`assistant_turns.run_id` 4316/4316 | 能把“哪一轮”钉住；不能钉住“哪一次 HTTP 请求” |
| **内容**（原则 ID / 正文） | **部分可用** | 事件含 `principleIds/activationIds/artifactIds`；artifact 正文可从 `state.db` 重算 | 能证明“PD 选了这条原则”；**不能证明“宿主把它放进了最终请求”** |
| **顺序**（送达 vs 行动） | **弱可用** | 事件 `ts` 与 `tool_calls.created_at` 同机时钟；无共享 request ID；`tool_use_id` 0/22438 | 只能给“同机时间先后”，不能给“同请求因果顺序” |

SPEC 对这三种能力的取值分别是 confirmed / returned / unknown（C04 L203）。按当前材料：

- 身份 → `confirmed`（turn 级）；
- 内容 → `returned`（PD 返回值级），非 `confirmed`；
- 顺序 → 同机时间级，缺共享 ID → **unknown**（不得用另一侧时间补齐）。

---

## 5. “指定一条原则”的可靠性实证（只读，不改任何状态）

目标原则（当前 active、`validated`、`approval.status=approved`）：

```
principleId   = 产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性
activationId  = act_prompt_产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性
artifactId    = pi-art-scribe-21bc6e76-ed9c-45a9-afef-eeeae6c30831-prompt-run_scribe-21bc6e76-ed9c-45a9-afef-eeeae6c30831-prompt_2
revision_epoch= 0
activatedAt   = 2026-09-25T15:36:19.050Z
content_json length = 2173（候选排序口径，非正文精确字节数）
```

统计口径：`events_YYYY-MM-DD.jsonl` 中 `runtime_v2_prompt_activations_injected`，按 `data.activationIds` 是否包含该 activationId（注入）与 `data.droppedActivationIds` 是否包含（丢弃）。快照时间 2026-11-07T03:07Z（本地 11:07）；生产仍在运行，计数会随时新增轮次而增长。

| 日期 | 注入事件数（每次 prompt 构建/run） | 注入 | 丢弃 |
|---|---:|---:|---:|
| 2026-10-31 | 46 | 17 | 29 |
| 2026-11-01 | 33 | 0 | 33 |
| 2026-11-02 | 33 | 2 | 31 |
| 2026-11-03 | 53 | 30 | 23 |
| 2026-11-04 | 17 | 0 | 17 |
| 2026-11-05 | 25 | 17 | 8 |
| 2026-11-06 | 26 | 26 | 0 |
| 2026-11-07 | 5 | 5 | 0 |
| **合计** | **238** | **97（占本日志范围 40.8%）** | **141（59.2%）** |

注入 + 丢弃 = 238，全部事件都有明确归属（没有“既未注入也未记录丢弃”的第三态）。但 238 是**日志范围内的事件数**，不是“交付场景数”：其中大量事件来自心跳/自主续跑，不等于用户交付请求。

预算并非固定 4000：窗口内 `budget` 分布为 2000×157、4000×46、15625×33、31250×2；`eligibleCount` 恒为 18，不同轮次的 `injectedCount` 为 4/5/8/9/14/16/18 不等（对应丢弃 14/13/10/9/4/2/0 条）。单个 `eligibleCount=18 / injectedCount=16` 样本不足以推断“所有轮次固定丢两条”。

**结论（修订）**：97/238 只能报告为“该日志范围内的目标注入比例”。它既不是交付场景覆盖率，也不构成“指定原则不可靠”的因果证据；`fair_rotation_v1` 是公平轮转，不是随机分组或行为对照。**“单目标不可靠、必须先建单原则工作区”降级为待场景样本核实的判断，不再是本轮默认结论；每轮必注入也不是本次研究的默认要求。**

这不是缺陷报告，而是设计事实：`filterPromptActivations` 没有任何 allowlist / 单目标限制（`prompt-activation-reader-contract.ts#L54-L60`），配置里也没有这类开关（生产 config.yaml `adaptive` = 0 命中）。

---

## 6. 最小缺口清单

| ID | 缺口 | 为什么是缺口 | 现状可否绕过 |
|---|---|---|---|
| **G-A** | 目标注入比例 97/238（仅日志范围），预算 2000–31250 可变 | 是否构成“交付场景漏注入”**待场景样本核实**；已核实的唯一明确交付机会（报告任务）在可观测轮次均注入目标 | 先做只读样本清单（已完成），不默认工作区迁移 |
| **G-A2** | 新工作区无法通过官方路径种入既有 artifact | `pd artifact` 只有 `show`；`pd runtime activation dispatch` 要求该工作区已有 artifact；无 artifact 导入命令 | 只能走该工作区自身的诊断→提案→Owner 批准流程（得到的是**新**原则/revision），或改动生产工作区的 18 条激活（治理变更，爆炸半径大） |
| **G-B** | 无最终请求正文证据 | PD 只返回片段；宿主组装最终请求；G1/C04 要求“独立比对同一请求正文” | PD 边界内**不可能**自证；必须宿主/provider 侧只读观测 |
| **G-C** | 无请求级身份 | embedded 无 `requestId`/`currentUserMessageId`；`tool_use_id` 0/22438 | 只能到 turn 级；顺序退化为同机时钟 |
| **G-D** | 版本能力差 | 已安装 2.6.4 无 controlled admission；仓库/发布 2.7.1 有 | 需官方安装/升级（未授权），且 controlled admission 本身仍属受控实验路径 |
| **G-E** | 普通路径无最终重验 | `revalidateAdaptivePrinciple` 仅单目标分支调用 | 读取到装配之间无失效/改版复核；窗口内若改原则正文，旧正文可能被带入 |

**最小缺口（阻断 G2 的部分）**：**G-B**（无最终请求正文证据）是当前唯一硬阻断；G-A 降级为待场景样本核实，本轮只读样本未发现可证实的“交付场景漏注入”。G-C/G-D/G-E 是“证据降级/能力缺失”，可记录为 unknown，不单独阻断。

---

## 7. 最小修正方案（只给方案，不实施）

### 7.1 方案 A（候选底座，非默认下一步）：专用真实工作区 + 单一 active prompt 原则

**改动属性**：0 代码、0 新平台；一次配置/治理操作。

- 调用链不变（§3），只是 `filterPromptActivations` 输入变成 1 条 → `eligibleCount=1`、`injectedCount=1`、`droppedActivationIds=[]`。
- 输入：该工作区 `state.db` 内一条 `validated` + `approved` 的 prompt activation。
- 输出：每轮 `runtime_v2_prompt_activations_injected`，`activationIds` 恒为目标；无请求正文证据（G-B 未解）。
- 成本：0 新增模型调用；需要一次治理流程（诊断→提案→Owner 批准→dispatch）。
- 失败回退：若 `eligibleCount>1` 或 `droppedActivationIds` 非空 → 该轮记 `delivery=unknown`，不补记；若 `artifact_not_validated` 警告 → 不注入，窗口暂停。
- 验收：连续 N 轮事件 `injectedCount=1` 且 `activationIds` 命中目标；Examiner 独立复核事件原文。
- 回滚：`pd runtime activation deactivate`（官方命令，`--dry-run` 可先验）。

**待 Owner 决定的两点**（不得由执行者自定）：
1. 是否允许在该工作区走一次完整治理流程以产出被指定原则的**新 revision**（而不是复用生产工作区的 artifact）；
2. 该工作区绝对路径（见观察方案 §2）。

### 7.2 方案 B（补 G-B）：宿主/provider 侧只读请求观测

**改动属性**：PD 边界之外的小范围接线或配置切换；需 Owner 明确批准。

三个子选项，按侵入性排序：

| 子选项 | 做法 | 输入 | 输出 | 成本 | 风险 |
|---|---|---|---|---|---|
| B1 本地 OpenAI-compatible provider 请求日志 | 专用工作区改用 `lmstudio`/`ninfer`/`llamacpp` 之一，开启其请求日志 | 宿主发往本地 provider 的请求 | `{ts, requestBody, requestId?}` | 本地算力；0 付费 | **改变模型与实际行为**；日志是否含完整 body **未核实**（待实施任务只读验证） |
| B2 provider 边界只读 tap | 在专用环境的 provider 适配层记录请求摘要 | `{sessionId?, runId?, sentAt, promptSha256, promptBytes}` | 请求级摘要 | 小范围新接线 | 触碰宿主/provider 层；需保证只读、脱敏、有界 |
| B3 外部代理抓包 | 不推荐 | — | — | 中 | 凭据暴露面、合规风险 |

**验收（B 类共同）**：同一次真实任务内，(1) tap 记录的 `promptSha256` 对应正文包含目标原则正文的哈希；(2) `sentAt` 早于该机会的首个关键行动 `tool_calls.created_at`；(3) Examiner 独立复核，不用模型自述。
**回滚**：关闭 tap / 恢复 provider 配置；不影响 Native 注入路径。

### 7.3 明确不做

- 不通过手工改 `.pd/state.db`、不复制生产 `.pd` 目录来“造”一个单原则工作区（P4 单一真源 / 数据清理守则）。
- 不手工覆盖安装目录、不使用 2.7.1 的私有 build 替换已安装 2.6.4。
- 不把 `controlledAdmission` 的“冻结输入”包装成普通真实入口。
- 不在本轮切换宿主模式、provider 或模型。

---

## 8. 成立与不成立的替代路径（防误判）

| 说法 | 判定 | 理由 |
|---|---|---|
| “受控实验已成功，所以真实入口可用” | **不成立** | controlled admission 需要操作者冻结输入 + 一次性消费；不是普通任务 |
| “没有原生 request ID，所以所有取证都不可能” | **不成立** | 身份到 turn 级可用（runId 100%）；内容到 PD 返回值级可用；只有请求级内容/顺序不可用 |
| “事件里有 principleIds，就等于请求里送达了” | **不成立** | 事件记录的是 PD 贡献片段，不是宿主最终请求 |
| “假 provider 指定的工具行动可算 Agent 自主改善” | **不成立** | SPEC 与既有案例口径：模型自述、receipt、被指定行动均不作为自主改善证据 |
| “安装版 2.6.4 与仓库 2.7.1 等价” | **不成立** | 安装版无 controlled admission（0 命中） |
| “把其他 17 条激活停用就能单目标” | **技术上可行但不授权** | 生产治理变更；爆炸半径覆盖全部 Owner 批准原则；本轮禁止写生产库/改治理 |

---

## 9. 证据索引

| ID | 类型 | 位置 |
|---|---|---|
| evidence-code-entry | CODE | `packages/openclaw-plugin/src/index.ts#L459-L476` |
| evidence-code-hook | CODE | `packages/openclaw-plugin/src/hooks/prompt.ts#L348-L364,L649-L652,L889-L933,L1113-L1156,L1173-L1186` |
| evidence-code-reader | CODE | `packages/openclaw-plugin/src/core/runtime-prompt-activation-reader.ts#L26-L71` |
| evidence-code-filter | CODE | `packages/principles-core/src/runtime/activation/prompt-activation-reader-contract.ts#L54-L60,L140,L153-L156` |
| evidence-native-identity | CODE | `packages/openclaw-plugin/src/index.ts#L371-L399` |
| evidence-events | RAW | `D:/.openclaw/workspace/.state/logs/events_2026-10-31..2026-11-07.jsonl` |
| evidence-state-db | RAW | `D:/.openclaw/workspace/.pd/state.db`（只读；32 activation / 18 active prompt / 14 validated+approved） |
| evidence-trajectory | RAW | `D:/.openclaw/workspace/.state/trajectory.db`（只读；`assistant_turns.run_id` 4316/4316；`tool_calls.tool_use_id` 0/22438） |
| evidence-installed | RAW | `C:/Users/Administrator/.openclaw/extensions/principles-disciple`（2.6.4；controlled admission 0 命中） |
| evidence-config | RAW | `D:/.openclaw/workspace/.pd/config.yaml`（`features.prompt.enabled=true`；无 `adaptiveActivation`） |
| evidence-host-config | RAW | `C:/Users/Administrator/.openclaw/openclaw.json`（gateway local；agent main；配置主模型 `zai/glm-5.3-flash` + `modelPolicy.allow` 含 `amd-radeon-cn` 系列本地模型；runtime 实际以 `amd-radeon-cn` 为主，见 provider 取证报告 §1 配置-运行漂移） |
| evidence-spec | SPEC | `docs/specs/PD Adaptive Activation SPEC v0.6.md#L171,L190,L191,L203` |

只读脚本（不提交）：`.tmp/pri-1119/{inspect-state,candidates,trajectory-aggregate}.cjs`。

---

## 10. 未验证 / 未运行

| 项 | 状态 | 原因 |
|---|---|---|
| 本地 provider 日志是否含完整请求体 | **UNKNOWN** | 未启动 provider、未查看日志格式；留给实施任务只读核实 |
| 专用工作区是否可由官方流程产出目标 revision | **UNKNOWN** | 未执行治理流程；需 Owner 决定范围 |
| 安装版 2.6.4 的单目标映射行为 | **NOT_RUN** | 未配置 mapping、未发起宿主回合 |
| G1 / C04 签收 | **NOT_CLAIMED** | G-B 未解 |
| G2 窗口 | **NOT_STARTED** | 无 Owner 授权；本轮禁止 |
| 新增宿主/模型调用 | **0** | 本轮边界 |

---

## 11. 边界声明

本轮仅只读：未写生产库、未改生产配置、未操作安装目录、未安装/发布、未改实验预算、未改冻结证据、未改历史判定、未重启/切换宿主模式、未新增模型或 HTTP 调用。未覆盖他人检查点与 `LATEST.json`。
