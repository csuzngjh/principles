# PRI-1122 单次通用模型动态选原则：离线实现与评价准备报告 v0.1

日期：2026-11-10（Asia/Shanghai）
Base：`3f6ab0d1a00ce0c775880d28f63232ab3704a31f`（= 开工时 `origin/main`，已含任务书基线 `7a58ebe4a`）
Head：本轮提交（见 PR / Linear 交接；报告不预填未产生的 sha）
状态：**离线实现完成；真实实测 NOT RUN（预算卡未批准）**

## 直接结论

本轮只交付“单次通用模型选择 + 现有共享装配”的隔离研究链路，不接生产 hook、不改 Native、不改 `adaptivePriorityProvider` 默认行为、不建通用 selector 框架。#2368 历史执行入口、样本哈希、批准记录与结果均未改动。

回答产品问题所需的真实对照**尚未执行**：预算卡 [PD-AA-PRI-1122-SINGLE-MODEL-BUDGET-CARD-v0.1.md](PD-AA-PRI-1122-SINGLE-MODEL-BUDGET-CARD-v0.1.md) 待 Owner 批准。因此本报告不给出覆盖增益、模型质量或成本结论，只给出可复核的接线证据与冻结对照。

## 复用点（未新增公共导出）

| 能力 | 来源 | 用法 |
| --- | --- | --- |
| 当轮授权候选 | `@principles/host-runtime` `readPromptActivationCandidates` | 真实 Runtime V2 Reader，`includeAuthority: true` |
| 最终装配 | `@principles/host-runtime` `buildActivePrinciplePromptContext` | 同一 Native 路径；动态追加传 `adaptivePriority` + `additiveOnly` + `mandatoryPrincipleIds` |
| 请求前重验 | `@principles/host-runtime` `revalidateAdaptivePrinciple` | 对模型看到的快照核对身份、正文、sha、authority、approver |
| 模型适配器 | `packages/principles-core` `PiAiRuntimeAdapter` | `maxRetries:0`、`maxRepairAttempts:0`、`free_form_only`、512 tokens |
| 结果契约 | `scripts/dev/adaptive-selector-lab/diagnostic.mjs` `validateSelection` / `hash` | 复用 `selected` / `none_applicable` / `uncertain` 与文本摘要校验 |
| 装配预算测量 | `@principles/core/runtime` `sharedDirectiveBaseChars` / `measureSharedDirectiveBlockChars` | 测试按真实块长度选预算，不放宽预算 |

新增文件仅为 lab 研究入口，未从任何 `packages/*` 导出：

- `scripts/dev/adaptive-selector-lab/orchestrator.mjs`
- `scripts/dev/adaptive-selector-lab/orchestrate.mjs`
- `scripts/dev/adaptive-selector-lab/orchestrator.test.mjs`

## 链路行为

1. **有界输入**：`currentInstruction`、`priorContext`（仅保留最新整条消息，最多 6 条 / 12000 字符）、候选（`c1..cn`）分层；评价答案、允许集合与授权决定不进入模型输入。
2. **候选上限**：超过 16 条或 12000 候选字符时**不截断**，返回 `candidate_cap_exceeded` / `candidate_chars_exceeded` 并回 Native，记录数量与原因。
3. **单次发送硬门**：机会开始时冻结截止；额度在实际发送前占用，失败也计数；`AbortSignal.any` 把取消/超时传给底层 `fetch`；第二次发送在出网前拒绝；过期结果即使结构合法也不应用。
4. **选择校验**：候选外引用、摘要不符、结构错误、同一 `principleId` 的歧义引用按协议失败；合法弃选与执行失败分开记录。
5. **装配校验**：先用请求前快照重验，再调用共享装配；若 `adaptivePacking.status` 为 `prioritized`，把 packer 的 `targetSnapshot` 与请求前快照逐字段比对（身份、正文、sha、authority、approvedBy）。不一致就丢弃增量。覆盖“重验刚通过、packer 下一次读取时目标又变了”。
6. **受控回退**：选择失败 / 依赖错误 → 保留本次 Native 基线；重验失败（撤销、换版、授权变化）→ 重读 Native（`reread_native_after_revalidation_failure`）；装不下或必保冲突 → 保留 packer Native 结果并明确 `selectedButNotPacked`。
7. **报告口径**：以 `additionalContext` 与最终入选身份为准，分开记录 `addedTarget`、`addedOther`、`lostNative`、顺序变化、必保保留、目标去重次数。已在 Native 的目标、拒绝追加、旧修订丢弃都不计入动态新增。

## 可读的“起草 → 交付”装配示例（离线、假传输）

合成任务：上一条是“先完成草稿，暂不进入验收”，当前指令是“请交付验收：这次改动已经全部完成了吗？”。候选顺序 `SCOPE → BIG → DELIVERY → TESTS`，Native 采用 legacy FIFO（`roundKey` 缺省）：

- Native 在 `BIG` 处停止，正文只含 `SCOPE`（770 字符），**没有**交付验收原则。
- 假模型只返回引用 `c3`（`DELIVERY`），摘要由编排器按候选正文校验。
- 真实共享装配把目标前置：`DELIVERY` 装入，`SCOPE` 仍在，`BIG` 仍装不下，最终 909 字符，`+139`。
- 结果：`outcome=dynamic_added`、`addedTarget=true`、`lostNative=[]`、`mandatoryPreserved=true`、`targetDirectiveCount=1`、`model.sends=1`。

这不是真实模型结论，只证明“模型只给引用时，PD 仍用真实 Reader 与共享装配生成正文，并保全 Native 原集合”。

## 测试与结果

命令与退出码：

```text
node --test scripts/dev/adaptive-selector-lab/orchestrator.test.mjs   exit 0
node --test scripts/dev/adaptive-selector-lab/                        exit 0
```

| 范围 | 通过 | 失败 | 跳过 |
| --- | --- | --- | --- |
| 新增 orchestrator 定向测试 | 14 | 0 | 0 |
| lab 全量（含历史 29 项） | 43 | 0 | 0 |

新增测试覆盖：

1. 语义选择改变装配（`dev-04` 型起草→交付；Native 漏目标、可安全追加、原集合全保留）。
2. 无适用原则弃选，Native 正文逐字节一致，历史引用与当前指令不进入正文。
3. 授权与请求隔离：候选外引用、上一轮摘要、撤销、换版、授权变化、迟到响应均不进入当前正文。
4. 去重与预算：Native 已覆盖只一份；紧预算时正文与 Native 一致且明确“选中但没装进去”（`mandatory_constraint_displaced`）。
5. 失败可恢复：超时取消到达 `fetch`、畸形输出、装配依赖错误；Native 0 次发送、动态最多 1 次、第二次出网前拒绝。
6. 额外接线：重验通过但 packer 再读已换版 → 单凭 ID 匹配也拒绝；候选上限 → 不截断、回 Native。

## 冻结对照准备

文件：[PD-AA-PRI-1122-SINGLE-MODEL-FROZEN-CASES-v0.1.json](PD-AA-PRI-1122-SINGLE-MODEL-FROZEN-CASES-v0.1.json)

- dev 8 例、eval 4 例，事前分开；允许集合、应弃选、禁止错误与装配区间已冻结。
- 复用 PRI-1141 合成 dev-01..06 与真实错例（dev-02 过度适用保持原判，不改写成成功）。
- 必含：`dev-04`/`eval-02`（Native 漏掉且可安全追加）、`dev-08`（Native 漏掉但预算挡住）、`dev-07`/`eval-04`（Native 已覆盖）、`dev-01`（任务延续）、`dev-06`/`eval-01`（历史/引用伪指令）、`dev-02`/`eval-03`（无适用原则）。
- 两臂共享输入、授权快照、轮次条件与装配预算；仅比较 Native 与单次通用模型。

## 报告四项（实测 NOT RUN）

| 项 | 状态与口径 |
| --- | --- |
| 覆盖 | **NOT RUN**。未执行真实两臂，不填覆盖数、动态新增、无关新增或误选率。离线测试只证明报告字段能区分这些类别。 |
| 归因 | **NOT RUN**。离线已能区分：候选池漏召回 / 模型选错或弃选 / 选对但重验或预算挡住。真实归因需批准后的 12 例。 |
| 成本 | **NOT RUN**。每例正文字符可由离线输出给出；真实请求数、耗时、模型用量与实际费用未测，费用记 `unknown`。 |
| 证据层级 | 正文确为 PD 共享装配输出；宿主实际请求、及时送达、指令遵循与行为改善**均未验证**。 |

## 复杂度增量

```text
New durable source of truth: NO
New persisted schema/state: NO
New subsystem/service/background process: NO
New public abstraction/interface: NO（仅 lab 内部函数）
New runtime feature flag: NO
New cross-package dependency: NO（复用已发布的 @principles/core、@principles/host-runtime）
New host/platform-specific behavior: NO
New external/network capability: NO（仅 lab 入口在显式批准标志 + 凭据存在时才会发起；本轮未调用）
```

## 回滚

代码回滚用 `git revert`；无生产 wiring、无数据库迁移、无配置默认值变更、无安装目录写入，回滚不涉及运行时状态。真实模式需显式批准标志、批准记录与凭据，本轮未发起调用。已产生的认领与台账保留作证据，不清理、不重置。

## 未执行检查（NOT RUN）

- 真实 `glm-5.3-flash` 调用与 12 例两臂实测：**NOT RUN**，等待预算卡批准。
- 生产 hook / OpenClaw 插件 / 安装包 / 生产库：未触碰。
- Gateway v5、低成本决策模型、Working Set、异步刷新、多原则组合、跨宿主接入：留待后续，不在本轮。
- 真实宿主送达、及时性、遵循与行为改善：未验证。

## 后续决定（仅一个）

若预算获批且结果显示：候选池漏召回 → 先修候选覆盖；选对但装不进去 → 交回预算/替换策略；确有值得保留的新增 → 用同一基准比较低成本决策模型、门控或两阶段；无实质收益 → 按本轮证据收口并说明瓶颈。不自动加样本、换模型、换宿主或重跑 Gateway。

## 增补 v0.2（2026-11-10）：真实分支收紧、一次性认领、假传输越界验收

### 1. 真实分支只吃冻结批次

- `--mode approved` 是本轮唯一的真实分支。它出现在命令行之外的一切输入都来自冻结批次：案例 ID 集合、当前指令、事前上下文、分片取自 `PD-AA-PRI-1122-SINGLE-MODEL-FROZEN-CASES-v0.1.json`；候选顺序、roundKey 模式与预算规则取自 `PD-AA-PRI-1122-SINGLE-MODEL-RUN-MANIFEST-v0.1.json`。
- `--workspace`、`--current-input`、`--prior`、`--round-key`、`--budget-chars`、`--fixture-response`、`--approval` 任一出现即 `REAL_BRANCH_ARGUMENT_FORBIDDEN`，在解析阶段就拒绝。固定批准标志 `--execute-approved-20261110` 只是显式执行开关，不携带任何批准数据。
- 清单记录冻结案例文件的 SHA-256；文件漂移即 `MANIFEST_DRIFT`，运行卡版本不符即 `RUN_CARD_VERSION_MISMATCH`，案例集合不一致即 `CASE_LIST_DRIFT`，全部发生在认领与发送之前。
- 独立批准记录 `docs/specs/APPROVAL-PRI-1122-SINGLE-MODEL-v0.2.json` 沿用仓库既有批准文件形态（`schemaVersion` / `approvedBy` / `approvedAt` / `approvalEvidence` / `cardVersion` / `manifestSha256`，另加请求上限），拒绝码为 `APPROVAL_RECORD_MISSING` / `APPROVAL_RECORD_INVALID`。批准绑定的是**实际清单**的完整 SHA-256；因此同时改案例文件与清单内记录的哈希、但保留旧批准，仍会在认领之前被拒。
- 预算不写死数字：按冻结规则（`base + 已保留块 + 目标块 ± slack/缺额`）在真实工作区上测量解析，装配默认值一旦变化会被测试直接暴露，而不是悄悄用旧预算。
- 冻结批次新增装配控制项 `fixture_oversized_control` 并记录修正原因（`amendments`）。它只决定 legacy FIFO 的停止位置，不是可选目标；控制项被选为目标按协议错误处理。
- 原有 14 条回归与离线 CLI（自定义工作区 + `--fixture-response`）保留不变；`fixture-workspace.mjs` 只是把测试里的夹具播种与块测量提取为共享模块，行为未变。

### 2. 一次性认领与累计请求记账（复用 #2368 机制）

| 项 | 行为 |
| --- | --- |
| 边界顺序 | 实际清单与批准记录比对 → `wx` 独占认领 → 才允许第一次发送 |
| 认领 | `APPROVAL-PRI-1122-SINGLE-MODEL-v0.2-CLAIM.json` 以 `wx` 独占创建，写入运行卡版本、清单 SHA-256、冻结案例 SHA-256、12 次上限、案例 ID 列表、批准记录 SHA-256 与批准引用 |
| 重复执行 | 认领文件已存在 → `APPROVAL_ALREADY_CLAIMED`，出网前拒绝 |
| 并发执行 | 同一认领路径，只有一方获得 `wx`，另一方出网前拒绝 |
| 每机会发送 | 1 次；第二次尝试 → `REQUEST_BUDGET_EXHAUSTED` |
| 累计上限 | 12 次；第 13 次 → `REQUEST_BUDGET_EXHAUSTED` |
| 失败记账 | 发送前先写台账（`results.json`），失败、超时、畸形输出同样计数 |
| 截止 | 每机会 10 秒；截止后即使返回合法 JSON 也不应用；取消信号转发到底层 `fetch` |
| 停止条件 | 传输失败累计 2 次即停，剩余案例记为未运行 |

### 3. 假传输越界验收（全部 0 次真实请求）

| 场景 | 拒绝码 | 实际请求数 |
| --- | --- | --- |
| 未批准（无批准标志） | `EXPLICIT_APPROVAL_REQUIRED` | 0 |
| 有批准标志但无批准记录 | `APPROVAL_RECORD_MISSING` | 0（且不写认领文件） |
| 冻结案例文件漂移 | `MANIFEST_DRIFT` | 0（且不写认领文件） |
| **同时改案例文件与清单内记录的哈希、保留原批准** | `APPROVAL_RECORD_INVALID`（`approval is not bound to this manifest sha256`） | **0（且不写认领文件）** |
| 命令行覆盖冻结字段（7 个 flag 各一次，含 `--approval`） | `REAL_BRANCH_ARGUMENT_FORBIDDEN` | 0（且不写认领文件） |
| 同一批准重复执行 | `APPROVAL_ALREADY_CLAIMED` | 0（首批 12 次已计入） |
| 同一批准并发执行 | 一方 `APPROVAL_ALREADY_CLAIMED` | 合计 12，没有第二次批量 |
| 第 13 次发送 | `REQUEST_BUDGET_EXHAUSTED` | 12，未新增 |
| 传输失败 | `NETWORK_OR_PROTOCOL_ERROR` | 1，且已计入额度 |

同一批假传输还验证了冻结计划确实产生预期 Native 形态：`dev-04` Native 只有 `act-fixture_preserve`（停在超大控制项），`dev-08` Native 为 `preserve + explicit_goal`，`eval-02` 与 `dev-04` 同形。否则正例与负例都失去意义。

### 4. 真实执行状态（dev / eval 分开）

| 分片 | 计划 | 已执行 | 失败 | 未运行 |
| --- | --- | --- | --- | --- |
| dev | 8 | 0 | 0 | 8 |
| eval | 4 | 0 | 0 | 4 |
| 合计 | 12 | 0 | 0 | 12 |

真实模型实测仍为 **NOT RUN**：预算卡 v0.2 未批准，本轮没有发起任何真实调用。

### 5. 测试命令与结果

```text
node --test scripts/dev/adaptive-selector-lab/approved-run.test.mjs   exit 0
node --test scripts/dev/adaptive-selector-lab/                          exit 0
```

| 范围 | 通过 | 失败 | 跳过 |
| --- | --- | --- | --- |
| 新增 approved 分支测试 | 10 | 0 | 0 |
| lab 全量（历史 29 + orchestrator 14 + approved 10） | 53 | 0 | 0 |

### 6. 复杂度增量（增补部分）

```text
New durable source of truth: NO（认领与台账是 lab 运行证据，不是生产真相源）
New persisted schema/state: NO（单个认领 JSON + 单次运行目录）
New subsystem/service/background process: NO
New public abstraction/interface: NO（lab 内部函数）
New runtime feature flag: NO
New cross-package dependency: NO
New host/platform-specific behavior: NO
New external/network capability: NO（仅被批准分支，本轮 0 次调用）
```

### 7. 回滚与额度收口

- 代码回滚用 `git revert` 即可：manifest 与 cases 只是 lab 输入，没有生产 wiring、数据库迁移、配置默认值变更或安装目录写入。
- 认领文件与逐请求台账**保留作证据，不要清理**：它们记录批准引用、清单哈希、冻结案例哈希、批准记录哈希与每一笔请求。
- 已认领的批次即使失败或中途停止，也按**实际台账**收口；不重置、不忽略已用额度。
- 删除认领文件**不是**恢复额度的方式。再次运行必须取得新批准（新的批准记录绑定新的卡版本或清单 SHA-256）；同一批准只能被执行一次。

### 8. 仍未执行

- 真实 12 例两臂实测：**NOT RUN**，等待预算卡 v0.2 批准。
- 宿主启用、Gateway v5、低成本决策模型：不在本轮。

