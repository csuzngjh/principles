# PRI-1140 冻结案例清单与事前标注 v0.1

状态：**已冻结（2026-11-09T03:40Z，候选实现与比较运行之前）**
归属：PRI-1140（AA Selector，M）。依据：SPEC v0.6 §2/§4/§8.1、`PD-AA-EVAL-CASES-DRAFT-v0.1.md`。
性质：**离线本地重放的评价输入。零真实模型调用；不证明行为改善；fixture 案例不计入 L2。**

## 0. 冻结纪律

1. 本文件在**候选实现和任何比较运行之前**写定。事前标注只依据当时已核实的 Native 代码语义（`packages/host-runtime/src/active-principle-prompt.ts`、`packages/openclaw-plugin/src/index.ts` 的 `resolveAdaptivePriorityForHook`、`packages/openclaw-plugin/src/hooks/adaptive-activation-config.ts`）和 SPEC 判据，不含候选输出。
2. 每例标注四栏：**关键机会**（该轮存在的可改变决定）、**必需原则**（最终装配必须保留的内容）、**可省内容**（允许裁剪的候选及依据）、**未知**（缺证据的维度）。
3. 候选输出出来之后不得回改本文件的标注；比较结果记录在独立文件，与本文件的差异即复盘证据。
4. 全部案例为 `fixture`，通过真实存储（`SqliteConnection`/`SqliteActivationStateStore`/`SqlitePIArtifactStore`）和真实共享装配入口 `buildActivePrinciplePromptContext` 重放；不 mock 装配入口本身。

## 1. 场景锚点（沿用候选场景卡，未另行冻结）

| 项 | 值 |
|---|---|
| 宿主/模式 | OpenClaw embedded 本地 prompt 路径，共享装配入口 |
| 决策场景 | 对可观察交付物的**首次对外验收完成宣告** |
| 事前信号 | 用户消息首行固定标记 `[PD-AA:delivery-review:v1]`（由既有验收任务模板带入）；或受控准入（本轮重放不覆盖） |
| 目标原则 | 「交付前以可观察证据自检」类原则（fixture 正文），治理侧同一 `principleId` 允许存在修订版次 |

## 2. 夹具工作区与重放口径

- 夹具 state.db 含：目标原则两个版次（`art-v1/act-old` 已停用、`art-v2/act-new` 现行，同 `principleId`，模拟既有 prompt-replacement 修订流）＋若干普通现行候选（混合 owner / system_policy 授权）＋可选的干扰候选。
- **Native 臂**：现行代码语义——把映射钉死的 `(artifactId, activationId)` 直接交给 `buildActivePrinciplePromptContext({ adaptivePriority: PIN })`（= 今天 `resolveAdaptivePriorityForHook` 的行为）。
- **候选臂**：新解析逻辑——按配置的 `principleId` 在当前现行授权集合中解析出至多一条激活，再交给**同一个**共享装配入口。
- 信号门（sentinel / controlled admission / trigger / workspace 作用域）两臂相同，由插件层单测覆盖；重放层比较的是装配结果。
- `mandatoryPrincipleIds` 沿用生产现状（OpenClaw 调用方不传 → 空集），不做生产外的新假设。
- 预算口径：与生产相同的 `promptBudget` 输入；预算单位是**字符**（chars，即 `budgetChars`/`injectedCharCount` 的口径）。Token 报告为估算值 `floor(chars / 4)`（粗略拉丁文本近似，仅作参考，不作为判定货币）；判定货币是 chars 与逐字节文本比对。选择耗时用 `process.hrtime.bigint()` 测 provider 解析＋装配墙钟。

## 3. 冻结案例（16 例）

类目覆盖：交付 A1–A7（含目标已存在 A2、预算相关 A3）、普通执行 B1–B2、阶段切换 C1–C2、预算不足 D1–D2、信号不明 E1–E2、重放确定性 F1。

### A 组：交付验收轮（sentinel 在场，映射在场）

| caseId | 场景 | 事前标注（关键机会 / 必需原则 / 可省内容 / 未知） | 预期 Native（钉死身份） | 预期候选（principleId 解析） |
|---|---|---|---|---|
| A1 | 映射钉现行激活，预算充足 | 关键机会：交付轮送达自检指令。必需：全部现行候选按预算保留，目标在场。可省：仅预算强制挤出的普通候选（既有算术依据）。未知：无 | prioritized / target_present | 同一目标 → 与 Native 相同文本（预期字节一致） |
| A2 | 目标已在 Native 装配内（预算宽裕） | 关键机会：同 A1。必需：目标＋现行候选。可省：同 A1。未知：无 | target_present，文本即 baseline | 同文（F-04 类比）：两臂差异=0，只记覆盖，不计内容增量 |
| A3 | 钉失效（Owner 修订后），预算充足 | 关键机会：同 A1——钉失效不应剥夺交付轮干预。必需：目标（现行版次）＋候选。可省：同 A1。未知：两臂文本是否逐字节一致（集合同、次序可能不同） | `target_unavailable` → 基线（现行版次作为普通候选按轮转可能入选） | 解析到 act-new → prioritized（目标置首，保证性覆盖） |
| A4 ★ | 钉失效＋预算紧张（基线轮转落下目标） | 关键机会：**关键覆盖改善点**——Native 系统性错过交付轮。必需：目标＋必需约束不丢。可省：预算强制挤出的普通候选（算术依据，逐例记录 displaced）。未知：无（轮转算术确定性） | 基线且 `droppedActivationIds` 含 act-new（关键机会错过） | prioritized 含目标；displaced 集按预算算术记录 |
| A5 | 候选失效：原则完全下线（0 现行激活） | 关键机会：无（目标不存在，普通 Native 即正确行为）。必需：现行候选。可省：同 A1。未知：无 | `target_unavailable` → 基线 | 解析失败 `principle_not_currently_authorized` → 无优先级 → 基线；两臂文本一致（回退安全） |
| A6 | 歧义：同原则两个现行激活 | 关键机会：有，但身份歧义须 Owner 处理，运行时不得猜。必需：现行候选不被裁剪。可省：无新增。未知：无 | 钉路径 `target_ambiguous` → **完整基线**（`{...nativeResult}`，active-principle-prompt.ts:537-539；同原则在基线内按 principleId 去重只出现一次） | 解析失败 `ambiguous_current_activations` → 无优先级 → 完整基线。两臂文本预期一致，仅报告字段不同（Native 带 `adaptivePacking.reason=target_ambiguous`，候选由 provider 记原因） |
| A7 | 授权/读取降级（夹具损坏一个 artifact 使 reader 出 warning） | 关键机会：同 A1，但证据读取不完整时必须回退。必需：候选完整性与告警外显。可省：无新增。未知：无 | 授权复核严格失败 → `authority_unavailable` → 基线减目标 | 解析严格失败（warnings>0 即拒）→ 无优先级 → 完整基线 |

### B 组：普通执行轮（无 sentinel）

| caseId | 场景 | 事前标注 | 预期 |
|---|---|---|---|
| B1 | 普通消息，映射在场 | 关键机会：无（普通轮应保持 Native）。必需：现行候选。可省：无。未知：无 | 两臂均在信号门即返回（不新增读取），基线 fair-rotation 文本逐字节一致；选择耗时应无实质差 |
| B2 | 标记在第二行（非首行） | 关键机会：无（信号不成立）。必需：现行候选。可省：无。未知：无 | `scene_not_matched`，两臂基线一致 |

### C 组：阶段切换

| caseId | 场景 | 事前标注 | 预期 |
|---|---|---|---|
| C1 | 实现→验收切换（第 k 轮出现 sentinel；映射钉现行） | 关键机会：第 k 轮。必需：两轮各自现行候选。可省：同 A1。未知：无 | 第 k−1 轮两臂一致；第 k 轮同 A1 |
| C2 | 验收→实现切换（sentinel 消失） | 关键机会：无。必需：现行候选。可省：无。未知：无 | 两臂基线一致 |

### D 组：预算不足

| caseId | 场景 | 事前标注 | 预期 |
|---|---|---|---|
| D1 | 目标单独装不下（oversized） | 关键机会：同 A1，但目标物理装不下时不得硬塞。必需：现行候选按算术保留。可省：无。未知：无 | 两臂均 `target_does_not_fit` → 基线，文本一致 |
| D2 | 预算极紧（目标装得下、挤出若干普通候选），钉现行 | 关键机会：同 A1。必需：目标＋必需约束；**不得无界挤出**。可省：预算强制挤出集（逐例记录）。未知：无 | 两臂均 prioritized、挤出集按同一算术，文本一致 |

### E 组：信号不明

| caseId | 场景 | 事前标注 | 预期 |
|---|---|---|---|
| E1 | 自然语言交付请求、无标记（「请交付验收…」） | 关键机会：语义上可能存在，但**事前确定性信号不成立**（C01：不凭一般关键词推定）。必需：现行候选。可省：无。未知：该机会是否算"漏触发"——本回合不判，归场景卡边界 | 两臂基线一致 |
| E2 | agent-to-agent 消息带标记 | 关键机会：无（非用户交互）。必需：现行候选。可省：无。未知：无 | `isAgentToAgent` 排除，两臂基线一致 |

### F 组：重放确定性

| caseId | 场景 | 事前标注 | 预期 |
|---|---|---|---|
| F1 | A4 原样重放 3 次 | 关键机会：同 A4。必需：同 A4。可省：同 A4。未知：无 | 三次输出逐字节一致；重放不改变 state.db（只读） |

## 4. 判定线（比较前冻结）

1. **失败（候选拒绝）**：任一例出现——未授权注入（装配了授权不可判定/已停用身份的正文）、必需内容丢失（现行候选非预算强制性地消失）、已知关键机会退化（A4 类场景候选臂目标反而缺席）。
2. **保留候选**：关键覆盖改善（A4 类：Native 错过、候选送达）且其余例关键覆盖不降、成本可接受（非交付轮零额外读取；交付轮至多一次只读解析，耗时与注入 chars 逐例报告）；或关键覆盖持平且开销实际下降。
3. **保留 Native**：持平、退化或证据不足。
4. 逐例比较维度：最终装配文本（sha256 + 逐字节 diff 摘要）、关键覆盖（目标在最终文本内的完整性，用既有 `injectedExpectations.bodyComplete` 口径）、无关注入（included 集差异）、注入量（chars；token 为 `floor(chars/4)` 估算，仅参考）、选择耗时（provider 解析＋装配墙钟 ms）。
5. 与既有案例草案的关系：A2↔F-04（同文）、B1↔F-03（原本做对）、A4↔F-01 的机会结构、F-02/F-05/F-06/F-07/F-08 为行为层案例，**不在本回合装配重放的可判定范围内**，不做行为结论。

## 5. 已知边界

- 受控准入（PRI-1152 隔离宿主）路径本轮不改、不重放；R1/R2 为历史真实运行记录，仅作背景。
- `mandatoryPrincipleIds` 生产调用方为空集是现状事实，卡片如实记录，不在本票扩权。
- 本清单不冻结生产映射值；生产启用另行授权（SPEC §7）。

## 6. 修订记录

- 2026-11-09T03:52Z（**冻结后、任何候选代码与比较运行之前**）：更正 A6「预期 Native」列的事实错误。原写「基线减目标（withoutTarget）」，与代码不符：`active-principle-prompt.ts:537-539` 对同原则多现行激活返回 `{...nativeResult}`（完整基线）而非 `withoutTarget`。同步更正 A6「预期候选」列为「两臂文本预期一致」。四栏事前标注（关键机会/必需原则/可省内容/未知）未改。A7 经同一核对确认 Native 走 :546 → `withoutTarget('authority_unavailable')`，原写正确。
