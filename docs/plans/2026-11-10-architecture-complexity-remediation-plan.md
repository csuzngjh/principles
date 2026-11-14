# PD 架构复杂度整改实施计划（2026-11-10）

- 性质：**计划文档**。Rev.3（2026-11-11）。5A/5B 已合入主干，Rev.2 的"本轮只改文档，不改产品代码"已不适用。
- 依据：
  - `docs/reports/PD_ARCHITECTURE_COMPLEXITY_REVIEW_20261110.md`（下称"评审报告"）
  - `docs/reports/PD_ARCHITECTURE_REMEDIATION_PLAN_INDEPENDENT_REVIEW_20261110.md`（下称"独立评审"，裁定 CONDITIONAL）
- 5A 已实施并合入：PR [#2478](https://github.com/csuzngjh/principles/pull/2478)，3 文件、零对外契约变更，2026-11-10 合入。
- **口径声明**：所有行数标注 `total`（`Get-Content` 行数）或 `non-blank`（`Measure-Object -Line`）。前一版混用了两种口径，本版逐处标注。
- **执行顺序见 §10**（本版已重排，不再沿用 5 → 3 → 1）。

---

## 0. 对独立评审的逐条回应

独立评审给出 4 条"必须修改项"（M1–M4）、8 条批次/口径修改（M5–M12）、5 条可选优化（O1–O5）。逐条处理如下。**没有一条沉默地不采纳**。

### 0.1 采纳（4 条必须修改项）

| 编号 | 结论 | 落到本计划的哪一节 | 复核证据 |
|---|---|---|---|
| M1 事故 #2 归因 | **采纳**。根因在 core `validateRuntimeProfile` 的字段拷贝，不在 4 个 loader | §3 重写；3A 升为 Phase 3 唯一必做批；3B/3C 降为可选；3E 延后 | `pd-config-validate.ts` 全文 `systemPrompt` 命中 **0**；入口 `validateRuntimeProfile:319` 委托 `validatePdLocalProfile`（定义自 `:219` 起），后者在 `:305-316` 逐字段白名单构造结果对象（`type/provider/model/apiKeyEnv/baseUrl/timeoutMs/maxRetries/maxTokens/reasoning`），无 `systemPrompt`；`pd-config-types.ts:113-117` 声明该字段，`pd-config-agent-binding.ts:277-278` 消费它 |
| M2 R4 不会先红 | **采纳**。改为"防复制漂移"守卫，并补一条本计划原先漏掉的真收口 | §2.5 R4 重写 | CLI `runtime-activation.ts:132` 与 console `ActivationsConsoleModel.ts:214` 各有一份 `collectRuleCodeEventEntries`；两者分别在 `:167`、`:272` 调用同一个 core `summarizeRuleCodeShadowEvents` |
| M3 S-R1 打错层 | **部分采纳 + 三处事实纠正**（见 §0.2）；两处真实歧义独立成批 | §4.2 试点重划；新增 §2B 批次 | 见 §0.2 |
| M4 只读端口 vs 写路径 | **采纳**，并给出三方案取舍（§4.3）；**后按 PRI-1207 修订：不新建端口，扩展现有 `RuntimeStateManager` + `storage-paths.ts`** | §4.3 端口边界重划 | console 源码 `readonly: false` 实测 **8 处 / 2 文件**（`ActivationsConsoleModel.ts` 6、`routes/feedback-reports.ts` 2） |

### 0.2 独立评审中，我用当前源码纠正的三处具体事实

这三处不影响它的结论方向，但会影响执行者"去哪里改"，必须写清。

**(a) read-model 缺 `state.db` 返回的不是 `clean`。**

独立评审 M3 写"`activation-compatibility-read-model.ts:66-70` `state.db` 不存在时返回 `status:'clean'`"。实际：

```ts
// activation-compatibility-read-model.ts:63-72
if (!fs.existsSync(stateDbPath)) {
  return { ok: true, status: 'no_state_db', findings: [], scannedActivations: 0,
    reason: 'state.db not found — …', nextAction: 'Nothing to do; …' };
}
```

`'no_state_db'` 是独立状态（类型定义在 `:31`：`'clean' | 'legacy_dependency' | 'no_state_db' | 'scan_failed'`），并且带了 `reason` 与 `nextAction`——这一处**已经是正确的**（rc-9）。

真正的问题是另一处：`:120` 的 `status: findings.length === 0 ? 'clean' : 'legacy_dependency'`，而循环里有 **5 个 `continue`**（`:93` 行不是 record、`:96` 缺 `artifact_id`/`content_json`、`:101` 嵌入 JSON 解析失败、`:103` 解析结果不是 record、`:105` 缺 `implementationCode`）。**被跳过的行不进入 findings，也不进入任何计数字段**，`scannedActivations` 只等于成功解析的 `sources.length`。所以 `clean` 的真实含义是"我能解析的那些行里没问题"，调用方无法区分"确实干净"与"8 行里有 3 行没解析"。

**修正后的目标**：`clean` 必须携带"已扫描行数 / 跳过行数"，跳过 > 0 时不得返回 `clean`。这比"改 `clean` 的字面值"更小、更准。

> **2026-11-10 Owner 裁定（supersedes 上面这句的落地方式）**：2B-a **只加增量计数器**（`skipped[]`），**不改 `clean` 语义**；`clean` 的重定义单列为一条决策，与 5B 一起排（见 §2B.5）。理由是计数器是纯增量、可独立回退，而改 `clean` 会让既有调用方把"可见性提升"读成"升级阻塞"。

**(b) "Console 模型层已返回 degraded + reason，缺的是页面不渲染"——只对一半。**

- 对 `state.db` 缺失 / 表缺失 / 悬挂引用三处，模型确实返回 `status:'degraded'` + `reason` + `nextAction`（`ActivationsConsoleModel.ts:307`、`:320`、`:566`）。
- 页面**确实渲染了**这个顶层 `degraded`：`ActivationPage.tsx:694-697` 把 `validated.reason` 写进 `degradedNote`，`:914-917` 渲染出来。所以这一层不是缺口。
- 真正的缺口是**逐行**的悬挂工件告警：模型在 `:451-453` 给该行加了 `enriched.warning`，但 `validators.ts` 的激活条目白名单里**没有 `warning` 字段**（全文 `warning` 命中中，`1793`/`1795`/`1825` 属"批准响应告警"，与激活条目无关），所以该字段在 UI 校验时被丢弃，页面里也搜不到 `item.warning` 的任何渲染。

**修正后的目标**：把逐行 `warning` 加入 wire 校验并渲染（或明确删掉这个死字段）。红测试写在 **UI 校验器 + 页面**，不写在模型层。

**(c) 行数口径不一致。**

- `validators.ts`：**3,934 total / 3,564 non-blank**。独立评审引用的 3,934 是 total。
- `runtime/index.ts`：**2,371 total / 2,147 non-blank**。独立评审引用的 2,147 是 non-blank。

两者都"对"，但混在同一张表里会让人以为桶文件比实际小 224 行。本版统一标注两个数。

### 0.3 采纳（M5–M12、O1–O5）

| 编号 | 处理 |
|---|---|
| M5 逆序可回退 + 拆 3D | 采纳。§2.3 / §3.3 / §4.3 批次表改为"逆序可回退"；3D 拆 `3D-read` / `3D-write`；1C 拆 `1C-read` / `1C-write`；新增 §7"逆序回退对照"逐条列出真实依赖 |
| M6 触面与人日 | 采纳。Phase 1 非 core 产线文件 **42**（已复算，见 §4.4）；总额见 §6 |
| M7 测试侧收敛机制 | 采纳。§4.4 新增"测试收敛机制"三条，并把"有意接受的边界"写清 |
| M8 1D 与 1F 冲突 | 采纳。1D 改为"独立库登记表 + 豁免测试"，1F 只禁"未登记连接" |
| M9 core I/O seam 登记 | 采纳。1A 验收加 `io-seam-registry.json` 登记 + 架构守卫通过 |
| M10 criteria 覆盖 10 个 checkId | **部分采纳**：事实采纳（10 项，已复算），落点改到 5B，不要求 5A 重做（见 §2.0） |
| M11 i18n 与 changeset | 采纳。5B 工时与验收加双字典；公共导出批加 `.changeset` |
| M12 "1.5 倍"改文件清单 | 采纳。§2.6 / §3.6 / §4.6 全部改为"开工前写死文件清单，超出即停" |
| O1 共享结论词汇 | **推迟到有第二个真实消费者时再做**（见 §2B.4 理由）。现在只有 5A 一个消费者，按 P7 属于投机抽象 |
| O2 3B/3C 合并 | 采纳（降级为可选批时合并） |
| O3 read-model 拆分 | 采纳，落在 §2B |
| O4 先加特征化测试 | 已由 5A 实现覆盖一部分（旧 evaluator 10 测试未改），剩余部分归 5B |
| O5 收益表按任务分开 | 采纳。§5 已按"诊断 / 修改"分表 |

### 0.4 我明确反驳的 3 条

| 独立评审主张 | 我的判断 | 依据 |
|---|---|---|
| "5A 应覆盖 10 个 checkId，工作量重估为 2–3 人日" | **不要求 5A 重做**。5A 的范围由 Owner 指令明确限定为"4 个数值阈值 + 保持 `shadow_telemetry_source_unavailable` 独立语义"，且要求"本批不改任何对外契约"。把 10 个硬检查也塞进 5A，会让 5A 从"纯数值判定"变成"判定结构重排"，直接违背当时的最小改动面约束 | 5A 已按该范围完成（PR #2478，18/18 + core 8933 全绿）；10 个 checkId 的"可解释"需求本身成立，但它属于展示层要什么就产什么，归 5B |
| "总人日 20–30" | **数字采纳，但作为"排期沟通区间"而非承诺**。按批相加得到两个不同的和（全范围 22–35.5、建议首轮 14.5–22.5），20–30 落在中间。写成一个精确区间会掩盖"Phase 1 上界不确定" | §6 给出两套明细 |
| "事故 #1 类问题在存储层修好后仍会在 UI 复现，因此 Phase 1 试点必须包含 UI" | **方向采纳、落点不采纳**。逐行 `warning` 的缺口在 **UI 校验器**，不需要动存储端口；把它塞进 1B 会让 1B 同时改 core read-model、console model、UI 三层，违反 P3。它应该是独立小批 | §0.2(b) 的证据链：`:451` 产出 → 校验器丢字段 → 页面无渲染 |

---

## 1. Phase 0：晋升判定 Reality Audit（已完成，只读）

### 1.1 核实的产线与消费方

| 环节 | 文件 | 关键位置 |
|---|---|---|
| 判定逻辑 | `packages/principles-core/src/runtime/activation/promotion-readiness-evaluator.ts` | `REQUIRED_PROMOTION_CHECK_IDS` 在 `:3-7`（**10 项**）；4 个阈值原在 `:65-68`；状态三元式原在 `:70` |
| 结果类型定义 | `packages/principles-core/src/runtime/activation/rulecode-owner-decision-service.ts` | `export interface PromotionReadinessResult` 在 32 行 |
| 读取器 | `packages/principles-core/src/runtime/activation/promotion-readiness-reader.ts` | 组装 checks → snapshot → evaluator |
| 证据快照 | `packages/principles-core/src/runtime/activation/promotion-evidence-snapshot.ts` | `snapshotDigest` 由 checks + shadowSummary 计算 |
| 宿主检查 | `packages/principles-core/src/runtime/activation/openclaw-promotion-checks.ts` | 产出 `safetyGateResults` |
| 影子摘要（生产） | `packages/principles-core/src/runtime/activation/rulecode-shadow-summary.ts:27` | `summarizeRuleCodeShadowEvents` |
| 影子摘要（CLI 自建） | `packages/pd-cli/src/commands/runtime-activation.ts:161` | `readShadowSummaryForActivation` |
| CLI 接线 | `runtime-activation.ts:682-756`（`750` 行取 shadowSummary） | 自建完整 reader 依赖 |
| Console 接线 | `pd-console/src/server/models/ActivationsConsoleModel.ts:678-729`（`725` 行取 `telemetry.shadowSummary`）、`:858` | 与 CLI 平行的一套 reader 依赖 |
| Console 决策过滤 | `pd-console/src/server/models/OwnerDecisionConsoleModel.ts:339-342` | `catch { continue; }` 静默丢待决项 |
| UI 校验 | `pd-console/src/ui/utils/validators.ts:1457`、`:1528-1536`、`:1551`、`:1568` | 白名单校验 status；显式字段映射；**不含 `warning`** |
| UI 展示 | `pd-console/src/ui/pages/activation/ActivationPage.tsx:168`、`:180`、`:187`、`:208`、`:212`、`:914-917` | 已有 shadow 计数、`evidence_insufficient` 文案、顶层 `degradedNote` |

### 1.2 与评审报告的三处差异（以核实为准）

| # | 评审报告说法 | 核实结果 | 影响 |
|---|---|---|---|
| 1 | "5 个阈值被压成一个布尔" | **4 个数值阈值** + 1 条独立的源不可用分支（`unavailable` + `shadow_telemetry_source_unavailable`），后者本来就是可区分的 | 5A 已按此实现 |
| 2 | 阈值"逻辑本身正确" | 逻辑正确，但阈值是内联魔数、不在任何导出契约里 | 5A 已收敛为 `PROMOTION_EVIDENCE_THRESHOLDS`（frozen，唯一来源） |
| 3 | 未提及 | **影子摘要有两个采集器**（两份逐字复制的 `collectRuleCodeEventEntries`，但都调用同一个 core 聚合函数） | R4 改为"防复制漂移"守卫，见 §2.5 |

### 1.3 是否需要改公共契约

`PromotionReadinessResult` 被 `runtime/index.ts` 桶导出，属于跨包公共类型。构造它的只有 evaluator 一处（测试另有 fixtures）；读取它的有 core 服务、CLI、Console、UI 校验四处。

- **5A 实际选择**：新增纯函数 + 冻结常量，**不改类型** → 零契约变更（已验证 PRI-775 冻结护栏通过）。
- **5C 才把 `criteria` 提升为结果必填字段**（有契约变更，单独一批、逆序回退）。

### 1.4 触面统计（修正）

| 维度 | 前一版 | 修正后 | 依据 |
|---|---:|---:|---|
| 需要读/改的产线文件 | 11 | **13** | 漏算两个桶：`activation/index.ts`、`runtime/index.ts` |
| 会受类型变化影响的测试文件 | 8 | **3 个构造夹具 + 5 个断言文件** | "8"本身可复算，但两类性质不同：夹具要迁移类型，断言文件只是期望值可能要动 |
| 包 | 3 | 3 | 一致 |

---

## 2. Phase 5 —— 让"卡在哪、还差多少"变成返回值

### 2.0 5A 已完成（记录，不是待办）

PR [#2478](https://github.com/csuzngjh/principles/pull/2478)，分支 `ai/adhoc-20261110-readiness-criteria-2caecc`，3 文件 281 行。

- 实际范围：4 个数值阈值 → `PROMOTION_EVIDENCE_THRESHOLDS`；`evaluatePromotionEvidenceCriteria()` 返回 `current / threshold / shortfall?`；`explainPromotionReadiness()` 只在 `evidence_insufficient` 时投影；`status` 改为由 criteria 派生。
- 交付形态：**包内 barrel 登记，公共 `runtime/index.ts` 未动**。原因：PRI-775 冻结护栏要求公共表面零变更；5A 无生产消费者，现在扩公共表面等于为没有调用方的能力先冻结名字与形状。
- 红→绿的性质：**"新能力不存在 → 存在"**，不是"旧逻辑算错"。改前新测试文件加载失败（导出不存在），改后 18/18；旧 evaluator 测试 10/10 的断言未被修改（`git diff` 为空）。
- 实测工作量约 **1 人日**（含 PRI-775 回退一次）。独立评审估的 2–3 人日是按"覆盖 10 个 checkId"算的；口径不同，不是估算错误。**10 个 checkId 的可解释性归 5B。**

### 2.1 目标（一句话）

**改完之后，任何"审批卡住了"的场景，维护者和 Owner 都能直接看到"差哪一项、还差多少"，不用再读判定代码。**

### 2.2 试点

试点仍是**晋升就绪这一条链路**（evaluator → `PromotionReadinessResult` → `ActivationPage`）。理由不变：事故 #6 的原发现场、只读不写库、消费方齐全（core + CLI + Console + UI 校验）。

### 2.3 批次划分（5A 已完成）

| 批次 | 内容 | 公共契约 | 逆序可回退 |
|---|---|---|---|
| **5A** ✅ | 4 个数值阈值收口 + `status` 派生 + `explainPromotionReadiness`；包内导出 | 否 | 是（单 commit `d7f2f46`） |
| **5B** 🚧 | ① 10 个 `checkId` 的硬检查也进入可解释投影（当前只有 `failedChecks`，缺"为什么没过"）；② Console / CLI 渲染 criteria 与 remaining；③ 两份 `collectRuleCodeEventEntries` 收敛到 `@principles/host-runtime`（原计划写 core，实际按 AGENTS.md §8.1 seam 归属改为 host-runtime，见 §2.5）；④ 双语文案 `zh-CN.json` / `en.json`；⑤ 公共导出的 `.changeset` | 否（仍在包内） | 需 5A 存在；单独回退 5B 会回到"只有 status" |
| **5C** | 把 `criteria` 提升为 `PromotionReadinessResult` 必填字段，删掉重复派生调用；更新 3 个构造夹具 + 5 个断言文件 + UI 校验器 | **是** | **不可独立回退**（5B 已按投影函数读取；回退 5C 必须同时回退 5B） |

> **状态更正（2026-11-10）**：5B 此前被 #2491 的标题误标为"已合并"，实际代码未落地。当前在 PR #2498（分支 `ai/adhoc-20261110-5b-criteria-promotion`）实现，**未合并**；`criteria` 保持可选字段，5C 未做。

**结论**：5A → 5B → 5C 只保证**逆序回退**。这与前一版"每批可独立 revert"不同，见 §7。

### 2.4 验收判据（可执行）

1. `promotion activate --dry-run --json` 输出含 `criteria[]`，且 `shadow_observed` 为 `{current:19, threshold:20, shortfall:1}`（5A 已在 core 层满足；5B 负责让它出现在 CLI 与 Console）。
2. 10 个 `checkId` 中任一个 `failed` 时，输出能说明"哪个检查、什么原因"，而不只是 `failedChecks: [{checkId, reasonCode}]` 的裸数组（5B）。
3. `status` 语义零放宽：原 `blocked` 场景仍为 `blocked`（特征化测试先行）。
4. 4 个阈值各做"刚好达标 / 差 1"两点边界测试（5A 已覆盖）。
5. 5C 起：UI 校验器不得因未知字段白屏（忽略未知字段 + 显式映射），且服务端先上、前端后上。

### 2.5 新测试要求（红→绿的诚实版）

| 编号 | 红（现在会失败） | 绿 |
|---|---|---|
| R1 ✅ | 19 样本 fixture 取不到 `criteria[].shortfall` → 字段不存在 | 5A 已绿：`{current:19, threshold:20, shortfall:1}` |
| R2 ✅ | 影子时长 23h 取不到"还差 1 小时" | 5A 已绿：`shadow_age {current:82800000, threshold:86400000, shortfall:3600000}` |
| R3 | 工件行缺失时，`failedChecks` 只说 `artifact_not_found`，说不出"扫了几行、缺哪行" | 输出 `scanned / missing[]`，且 `scanned > 0` 时不得返回全通过（5B） |
| **R4（重写）** | **今天就是绿的**：两边都调 core `summarizeRuleCodeShadowEvents`（CLI `:167`、console `:272`），`collectRuleCodeEventEntries` 逐字复制（`:132` vs `:214`） | 改为**防复制漂移守卫**，见下 |
| R5（新增） | 硬检查 `failed` 时只有 `{checkId, reasonCode}`，没有"这一项检查的是什么、缺什么输入" | 每个 `checkId` 有可展示的说明（5B） |

**R4 改成什么、为什么这样才会先红：**

- 做法：把 `collectRuleCodeEventEntries` 收敛到 `@principles/host-runtime`（`rulecode-event-collection.ts`），CLI 与 console 只保留一行委托/再导出。**落点偏差说明（2026-11-10）**：原稿写"提取到 core"，但 core 新增 fs I/O 必须登记 `io-seam-registry.json`（AGENTS.md §8.1）；而 `@principles/host-runtime` 已拥有 `RUNTIME_EVENT_LOG_CANDIDATE_DIRS` 与运行时日志读取职责，CLI 与 console 均已依赖它，故改为该包。守卫有两条：
  1. **结构守卫**：`rg "function collectRuleCodeEventEntries"` 在 `@principles/host-runtime` 之外必须为 0（提取后成立）。
  2. **行为等价守卫**：同一组 fixture 目录（含坏行、不可读目录、重复行、跨目录优先级）喂给"提取前实现"的冻结快照与提取后实现，逐字段相等。
- **它如何先红**：在当前代码上写第 1 条守卫，会立刻红（`rg` 命中 2 处）。这就是"先红"的证据——它红在"复制事实存在"，而不是红在"结果不一致"。第 2 条守卫在提取前后都是绿的，它的价值是防未来漂移，因此**明确标注为回归保护，不作为红→绿证据**。
- 这样改避免了前一版的根本问题：用一个今天本来就绿的断言（两份摘要相等）冒充"改造前会错"。

### 2.6 停止条件（出现即停、上报）

1. 出现"为了让测试变绿需要放宽 `blocked` / fail-closed 判定"。
2. 需要引入第二份阈值定义。摘要侧允许"收敛到 `@principles/host-runtime`"，但不得出现第二份聚合实现。
3. 契约变更范围超出开工前写死的清单（5C 开工前必须列出文件路径，超出即停；不再使用"8 个测试文件"这种模糊数字）。
4. **开工前写死"预计改动文件清单（路径 + 数量）"**，实际超出即停。取消"回归面超过预估 1.5 倍"这种没有基线的写法。
5. 5A/5B 改完后，下列三种输入仍无法区分则停并重估方向：
   - `state.db` 缺失（`no_state_db`）
   - 激活存在但工件行缺失（逐行 `warning` / `missing[]`）
   - 事件目录不可读（CLI + console 双份采集）
6. 需要改数据库表结构、回填数据，或修改 `snapshotDigest` 输入字段。

### 2.7 回滚方式

- 5A：单 commit revert，无持久化。
- 5B：拆成"host-runtime 提取"与"两处展示"两个提交；展示侧可按包 revert 回"只有计数"。
- 5C：revert 契约提交 **必须连同 5B 一起**，否则 5B 读取的字段消失。
- **全程无数据迁移**：`criteria` 不写入 `activation_evidence_snapshots`。

### 2.8 风险

| 风险 | 说明 | 应对 |
|---|---|---|
| 第二真相 | UI 自己算"差多少" | 阈值只在 core 定义；验收加"UI 源码不出现阈值数字常量"检查 |
| 摘要复制漂移 | 两份采集器今天一致，明天各自修 bug | §2.5 的结构守卫 + 行为等价守卫 |
| 部署顺序 | UI 校验器是白名单式；服务端先加字段、旧前端严格拒绝会白屏 | 5C 的校验器必须"忽略未知字段 + 显式映射"；服务端先上 |
| 误读 | `criteria` 被读成"明天就能晋升" | 文案只陈述当前差值，不承诺时间 |
| 长期无消费者 | 5A 的导出目前无人调用 | 5B 是本计划的下一批；若 5B 被搁置超过一个发布周期，按 §10 的触发条件重新评估是否保留 |

### 2.9 人日估算（修正）

| 批次 | 前一版 | 修正后 | 低估原因 |
|---|---:|---:|---|
| 5A | 0.5–1.0 | **1.0（实测）** | 含 PRI-775 回退；范围比独立评审假设的小 |
| 5B | 1.0–1.5 | **1.5–2.5** | 漏算双语文案、`.changeset`、console API 契约测试、10 个 checkId 的说明文案、摘要提取 |
| 5C | 0.5–1.0 | **0.5–1.0** | 不变（夹具性质已分清） |
| **合计** | 2.0–3.5 | **3.0–4.5**（5A 已完成，剩余 2.0–3.5） | |

---

## 2B. 新增批次：可见性缺口（独立小批）

### 2B.1 为什么独立、不塞进 5B

两处缺口与晋升判定无关，塞进 5B 会让 5B 同时改 core 判定、core 存储读模型、console model 三层：

1. **5B 必须与 UI 串行**（`ActivationPage.tsx`、`validators.ts`）；而这两处缺口一头在 core read-model、一头在 console model，**不需要动 UI 页面**（逐行 `warning` 需要，但那是第三条）。
2. `activation-compatibility-read-model.ts` 的结果类型 `ActivationCompatibilityScanResult` 经 `runtime/index.ts:1693-1694` 公共导出，消费者是 `pd-cli/src/commands/runtime-compatibility-scan.ts`。给它加字段是**跨包契约变更 + CLI JSON 输出变更**（`cli-1-strict-json`），必须有独立的契约评审与 CLI 接线测试。
3. 这两处正好是"结论词汇"的第一批真实消费者（`clean` vs `skipped` 行、`degraded` vs `unreadable`），先有消费者再抽词汇，符合 P7；反过来先造 `Outcome` 类型再找用途就是投机抽象。

### 2B.2 范围

| 编号 | 内容 | 契约 | 红测试 |
|---|---|---|---|
| **2B-a** | `activation-compatibility-read-model.ts`：新增增量字段 `skipped: [{ reason, count, sampleActivationIds }]`（`status` / `ok` 语义**不动**）；CLI 文本输出补一行 `skipped: N active row(s) ...`，否则人类操作路径仍看不见 | **是**（公共结果类型 + CLI 文本/JSON），`.changeset` patch | 构造 1 行 `content_json` 非 JSON：现在 `clean` + `scannedActivations: 0` 且无任何跳过信息；期望 `status` 仍为 `clean`、`skipped === [{reason:'invalid_content_json',count:1,...}]`，且文本输出含 `skipped:` 行 |
| **2B-b** | `OwnerDecisionConsoleModel.ts:339-342`：`catch { continue; }` 改为"计入 `unreadable` 计数并在列表响应里暴露"，不再让读取失败等价于"没有待决项" | 否（console 响应内部） | 让 `getOwnerReview` 抛错一条：现在该条静默消失、响应无任何计数；期望响应含 `unreadable: 1` + reason |
| **2B-c** | 逐行 `warning`：加进 `validators.ts` 的激活条目白名单 + `ActivationPage` 渲染（或明确删除死字段，二选一） | 否 | 悬挂工件 fixture：现在 UI 无任何提示；期望该行出现可见告警 |

### 2B.3 人日

2B-a 0.5–1.0；2B-b 0.5；2B-c 0.5。**合计 1.5–2.0**。

### 2B.4 为什么不现在做 O1（共享结论词汇）

做完 2B 与 1A 之后，会存在 3 个"带原因的结论"的真实形状（readiness、scan、outcome）。**到那时再抽，才有 3 个真实实现可比对**；现在抽只能猜。这条与独立评审 O1 的差异是有意的，理由是 P7（不做投机抽象）。

### 2B.5 `clean` 是否吸收跳过行（**已被 #2491 实施；本节曾滞后于代码**）

> **文档漂移更正（2026-11-10，随 5B 回写）**：本节原先写"2B-a 只加 `skipped[]`，不改 `clean` 语义"。这与当前代码不符——PR #2491 已把状态扩为 `'clean' | 'incomplete' | 'legacy_dependency' | 'no_state_db' | 'scan_failed'`，并把 `clean` 收紧为"findings 为空**且** skipped 为空"；跳过 > 0 返回 `incomplete`（`activation-compatibility-read-model.ts:53-63`、`:193-194`）。计划文本是旧稿，代码为准。

**Owner 2026-11-10 的原始裁定**：2B-a 不改 `clean` 语义，只加 `skipped[]`；"跳过 > 0 时不得返回 `clean`"作为**独立决策**，不在 2B-a 里顺手改。

**实际落地（#2491）**：独立决策选择了"引入第三态"，但以**不升级为阻塞**的方式实现——`incomplete` 与 `clean` 并列，而不是让同一个 `clean` 承担两种含义；`ok` 仍只表示"扫描跑完"，不是严重度信号（`:44-50`、`:198`），是否阻塞由 CLI/Console 各自决定。

仍未决的问题：`incomplete` 是否要在 CLI 退出码或 Console 顶部横幅上升级为显式警告。当前两者都只透出 status，不改变退出码。

两种走向的对照保留如下（第二行即当前实现）：

| 走向 | 语义 | 风险 |
| --- | --- | --- |
| 保持 `clean`（今天） | `clean` = "已解析的行里没有遗留契约依赖" | 操作者可能把"部分行没解析"读成"确实干净"——计数器可见但不强制 |
| 引入 `partial_scan`（或 `clean` 需 `skipped.length === 0`） | `clean` = "全部 ACTIVE 行都被检查过且通过" | **已采用（实现为 `incomplete`）**：升级路径上可能把"数据库里有坏行"升级为阻塞；当前通过 `ok` 不联动规避，CLI/Console 文案已同步渲染该状态 |

评估该决策时必须同时看：`pd-cli` 的退出码、Console 的 `status` 渲染、以及 5B 的 `criteria` 文案。**5B 的 criteria 只描述晋升就绪（promotion readiness），不改写 compatibility-scan 的 `clean`/`incomplete` 文案**；两处状态词汇必须保持各自独立，否则会出现"CLI 说不干净、Console 说没问题"的分裂。

---

## 3. Phase 3 —— 配置"一读一写"（**建议降级为 1 个必做批**）

### 3.1 事故 #2 的真实根因（重写）

前一版写"4 个独立 reader，某个 reader 丢弃 `runtimeProfiles.*.systemPrompt`"。**与源码不符。**

| 事实 | 证据 |
|---|---|
| `systemPrompt` 在类型中声明 | `pd-config-types.ts:113-117` |
| 消费方读取 `profile.systemPrompt` | `pd-config-agent-binding.ts:277-278` |
| `pd-config-validate.ts` 全文没有 `systemPrompt` | `Select-String 'systemPrompt'` 命中 **0** |
| `validateRuntimeProfile:319` → `validatePdLocalProfile`（`:219` 起）在 `:305-316` 逐字段白名单构造结果对象 | 只构造 `type / provider / model / apiKeyEnv / baseUrl / timeoutMs / maxRetries / maxTokens / reasoning` |
| 4 个 loader 都调用同一个 core 校验 | pd-cli `loadPdConfig:112`、host-runtime `loadPdConfigForPlugin:75`、console `loadPdConfig:249`、installer `validateConfigYamlFull:481` |
| effective 若拿到字段会保留 | `pd-config-effective.ts` 的 `{ ...profile }` |

**结论**：根因是 core 一处字段白名单漏项。合并 4 个 loader **不会**修复它；做 3B/3C 之后 `systemPrompt` 仍然丢。真正修复它的是 3A 的"字段覆盖率测试 + 补齐 validate 的字段拷贝"（`effective` 无需改动，见 §3.3 Owner 裁定）。

### 3.2 Phase 3 的真实收益重估

| 主张 | 前一版 | 重估 |
|---|---|---|
| 新增一个配置字段 | 8 文件 / 约 3,600 行 → 2 文件 / 1,200 行 | **不成立**。4 个 loader 是字段无关的包装，新增字段从来不需要改它们。真实成本是 core 的 types + defaults + validate + effective（1,859 total 行）+ 消费方；改完仍然是这 4 个 core 文件 + 消费方。**文件数不变** |
| 统一 4 个解析实现 | 减少重复 | 解析语义统一是真收益，但 3B/3C/3D 的真实重复只有"各包自己拼路径 + 调 core"，不是四套 YAML 解析器 |
| 漏读不再静默 | 未写 | **这才是真收益**：3A 之后，声明了但没被拷贝的字段会红 |

**判决：Phase 3 的收益只支撑 3A（1–2 人日），不支撑 4–7 人日的全阶段。**

依据：
- 3A 直接修事故 #2，且是唯一能修的批次；
- 3B/3C 的收益是"少一次 `mkdirp` 式的包装"，把 90 个调用点的风险暴露出来换不到可观测收益，**建议降为"下次改到该文件时顺带委托"的按需项，不排期**；
- 3D-write（保注释 YAML 写回）是本阶段最大单项（3–5 人日），但当前没有事故证据表明"三个写入口"曾经写坏配置——按 §4 的 MVP 口径，没有"不做会怎样"的具体后果，就不做；
- 3E 会改安装器最热文件（`workbuddy-host-installer.ts` 最后改动 2026-11-08），风险高于收益，**延后**。

### 3.3 批次划分（修订）

| 批次 | 内容 | 状态 |
|---|---|---|
| **3A** | core 新增 `readWorkspaceConfig()`（`config` + `fieldStatus` + `warnings`）；补齐 `validatePdLocalProfile` / `validateOpenClawProfile` 的字段拷贝；字段覆盖率测试。**按 Owner 2026-11-10 窄化裁定：实际只改 `pd-config-validate.ts` + `pd-config-types.ts`，不动 `effective.ts`**（见下方注） | **必做** |
| 3B+3C | 两个同构 loader 委托 core（合并为一批） | 可选，不排期（触发条件见 §8） |
| 3D-read | console 读委托 core | 可选 |
| 3D-write | `writeWorkspaceConfig` + 3 个写入口收敛（保注释） | 可选，独立决策 |
| 3E | installer 消费 core 校验 | **延后** |

> **2026-11-10 Owner 裁定（窄化 3A）**：事故 #2 的修复按"方案 C + 编译期穷尽表"作为**独立 PR** 实施，只改 `pd-config-validate.ts`（穷尽表 + "输入字段 ⊆ 输出字段"自检 + 未知键 fail-loud）与 `pd-config-types.ts`（删 `splitPipelineTimeoutMs`），**不做** `readWorkspaceConfig()` / `fieldStatus`，**不动** `effective.ts` 与 20+ 处 profile 重建点。
>
> 因此 3.4 第 1、2 条验收（`fieldStatus` 覆盖率）**不适用于本次修复**；本次的验收是：完整字段夹具经 `validate` 后全部保留、未知键报错、非字符串 `systemPrompt` 报错、`splitPipelineTimeoutMs` 被拒绝。3A 剩余部分（`readWorkspaceConfig` + `fieldStatus`）仍待独立立项。

### 3.4 验收判据（3A）

1. 字段覆盖率：`pd-config-types.ts` 声明的每个字段路径都出现在 `fieldStatus` 中，缺一即测试失败。
2. 在 config 写入 `runtimeProfiles.<p>.systemPrompt` 后，经 core effective 读取**能拿到该字段**（现在是 undefined）。
3. 类型写错时 `warnings` 含该字段路径，不静默。
4. 4 个 loader 的现有测试全部保持通过（不得改写断言来适配）。
5. 若新增公共导出：`.changeset` 已加。

### 3.5 新测试要求（红→绿，归因修正）

| 编号 | 红 | 绿 |
|---|---|---|
| C-R1（重写） | 在 config 中写 `runtimeProfiles.<p>.systemPrompt`，**经 core `validate` → `effective`** 读取 → 现在被丢、无 warning（根因在 validate，不在 loader） | `fieldStatus` 为 `read`，值可达；类型写错时 `warnings` 含该路径 |
| C-R2 | 统计"被声明但从未被任何路径拷贝的字段" → 现在无法测量 | 覆盖率测试输出为 0 |
| C-R3 | 每个声明字段加一条"声明/拷贝/消费"三元组断言 | 覆盖率只增不减 |

C-R4（"4 个 loader 行为等价矩阵"）**降级**：既然 3B/3C 不排期，等价矩阵没有消费者。保留为 3B/3C 开工时的前置条件。

### 3.6 停止条件

1. 需要放宽任何配置校验以让测试通过。
2. 出现第二套配置真相。
3. **开工前写死文件清单，超出即停**（取消"1.5 倍"）。
4. 需要改 config schema 本身。
5. 字段覆盖率测试需要"先删字段才能绿"——说明发现的是真实死字段，按 §18 数据/配置清理流程单独处理，不在本批顺手删。

### 3.7 人日（修订）

| 批次 | 前一版 | 修订后 | 说明 |
|---|---:|---:|---|
| 3A | 1.0–2.0 | **1.0–2.0** | 不变 |
| 3B+3C | 1.0–1.5 | 可选，不排期 | |
| 3D-read | （含在 3D 的 1.5–2.5） | 可选，1.0–1.5 | 拆分后单列 |
| 3D-write | （同上） | 可选，**2.5–4.0** | 保注释 YAML 写回需要 document API；3 个写入口语义不同 |
| 3E | 0.5–1.0 | 延后 | |
| **排期合计** | 4.0–7.0 | **1.0–2.0** | 只做 3A |

### 3.8 Follow-up：默认配置共享污染（已完成）

| 项 | 状态 | 证据 |
|---|---|---|
| `getDefaultPdConfig()` 的 `features` 只做浅拷贝（P-ERR-124：kill-switch 夹具改写共享 `host.codex` 条目，同 worker 后续测试读到 `enabled=false`） | **已完成**，PR **#2519**（merge `c8b984ffb`） | `pd-config-defaults.ts:134-158` 逐层拷贝：`features` 每条 clone、`runtimeProfiles` 每条 spread、`ui.diagnostics` 显式重建、`reuseEvaluation` spread |
| 残留：effective 层的 UI 默认值回退 `{ ...DEFAULT_UI }` 仍共享嵌套 `diagnostics`，调用方一次 mode 写入会改写进程级 `DEFAULT_UI` | **已完成**，PR **#2527**（本批独立小批） | 改为 `{ diagnostics: { mode: DEFAULT_UI.diagnostics.mode } }`；新增反例测试（改前红：`expected 'advanced' to be 'simple'`；改后绿：配置测试 303/303） |

扫描结论：其余默认值取用点（`DEFAULT_FEATURE_FLAGS`、`DEFAULT_RUNTIME_PROFILE`、`DEFAULT_REUSE_EVALUATION`、`DEFAULT_CONTEXT_INJECTION`）均为扁平结构或已逐层拷贝，无其他浅拷贝残留。

---

## 4. Phase 1 —— 存储收口（**建议只做读侧**）

### 4.1 目标

**改完之后，"表里没数据"和"引用坏了"在类型上就是两回事，不可能再显示成"一切正常"；产线侧改一次表结构只落 core。**

明确撤回一条主张：**"改一次表结构只落 core"对测试侧不成立**（见 §4.4）。

### 4.2 试点（重划）

试点从"`ActivationsConsoleModel` 单文件 8 处"改为**一条纵向链路**：

1. `principles-core/src/runtime/activation-compatibility-read-model.ts`（事故 #1 的原始判定位置；`clean` 的跳过行不可见）；
2. `pd-console/src/server/models/ActivationsConsoleModel.ts`（读侧，8 处构造中含写连接，见 §4.3）；
3. `pd-console/src/server/models/OwnerDecisionConsoleModel.ts:339-342`（`catch { continue; }`）。

理由：事故 #1 的用户可见症状是"页面显示已启用，实际没武装"。这三处正好覆盖"判定 → 列表 → 决策列表"三个环节；只改其中一个，另外两个会继续把"读不到"显示成"没问题"。

**不选** `host-runtime` 作试点：7 个文件直连 better-sqlite3 + 5 张自建表，是最难的一段。

**落点修订（2026-11-14）**：试点链路本身保留，但"改成什么"按 §4.3 的现行方案执行——扩展现有 `RuntimeStateManager` + `storage-paths.ts` 与既有只读连接，**不新建 `WorkspaceStateReader` 端口**（PRI-1207 已否决）。

### 4.3 端口边界重划（M4）—— 新建端口方案已被 PRI-1207 否决，改为扩展现有组合根

> **计划修订（2026-11-14，依据 PRI-1207 / PR #2627 的结论）**：本节原先采纳的"新建 `WorkspaceStateReader` / `WorkspaceStateWriter` 双通道"已被否决。
>
> 否决理由（以代码为准）：
>
> 1. `RuntimeStateManager` **已经是 state.db 的组合根**（生产调用点 20+），再建 `WorkspaceState` / `WorkspaceStateReader` 会形成第二个组合根，违反 P4（单一权威）与 P7（无投机抽象）。
> 2. trajectory 的只读端口 `openTrajectoryDbReadonly` + `TrajectoryDbUnavailableError` 已经存在，真实缺口是"部分消费者没接上"，不是"没有端口"（P2.1 Connection Before Creation）。
> 3. core 连接语义的唯一所有者已是 `SqliteConnection`（路径 + pragma + 打开策略），不需要再包一层同义类型。
>
> **替代方案（现行）**：扩展现有 `RuntimeStateManager` + `storage-paths.ts`（`resolveStateDbPath` / `resolveTrajectoryDbPath`）。读侧统一走 `SqliteConnection({ readonly: true, bootstrapIfMissing: false })` 与 `openTrajectoryDbReadonly`；**不新增端口类型、不新增 `io-seam-registry.json` 条目、不新增公共导出**。

**事实（2026-11-14 复核，未变）**：

- console 产线 `new SqliteConnection(` **35 处 / 17 文件**；其中 `readonly: false` **8 处 / 2 文件**（`ActivationsConsoleModel.ts` 6、`routes/feedback-reports.ts` 2）。
- 全仓非 core 产线直连 **42 文件 / 70 处**（console 17、host 9、cli 10、openclaw 6）。
- 前一版 1C 说"迁移 console 剩余 27 处"，而 1A 读侧只读、4.6 停止条件第 1 条禁止写入 → 走到第 28 处必然停摆。

**PRI-1207 的读写计数（按现码更正）**：`packages/principles-core/src/runtime/internalization-integrity-remediation.ts` 现为 **9 读 / 5 写**；此前使用的 **6 读 / 8 写** 口径已过时。

依据（可复跑）：base `6c83d6126`，该文件 `new Database(` 共 14 处，逐行判据为是否带 `{ readonly: true }` —— 只读 9 处（行 536/600/653/703/745/756/845/1123/1166），可写 5 处（行 768/783/877/933/1050）。写入面统一归 **PRI-1209**，本计划不定义 `WorkspaceStateWriter`。

**原三方案（历史记录，方案 B 已被否决）**：

| 方案 | 做法 | 利 | 弊 | 判断 |
|---|---|---|---|---|
| A. 端口允许写入但必须经契约 | 一个 `WorkspaceState` 端口，写方法显式声明事务与 fail-closed | 调用方只学一个接口；写语义集中 | 端口变宽；读写混在一个对象里，容易在只读场景误用写方法 | **否**——与"读侧先做"的顺序冲突 |
| B. 拆 `WorkspaceStateReader` / `WorkspaceStateWriter` 两个通道 | 读端口本阶段；写端口单独设计、单独批次 `1C-write` | 读侧能独立上线；写侧失败语义可单独评审；停止条件清晰 | 两个类型，接口数 +1 | **原采纳，PRI-1207 已否决**（第二组合根 + 端口已存在） |
| C. 另设仓库边界（每包自己的 store） | 各包保留自己的连接，只在 core 提供 schema/类型 | 改动最小 | 直连仍在，事故 #1 的结构性原因不变 | **否**——等于不做 |

**现行停止条件等价物**：若"扩展现有 `RuntimeStateManager`"需要新造第二个 state.db 组合根、或需要放宽只读保护才能完成 → 停，写路径归 `1C-write` / PRI-1209。

`1C-write` 本计划**不排期**，触发条件见 §8：只有当"同一写入缺陷在 ≥2 个包各修一次"的真实实例出现，或 console 写路径出事故，才启动；承接单为 PRI-1209。

### 4.4 批次划分（修订）

| 批次 | 内容 | 逆序可回退 | 备注 |
|---|---|---|---|
| **1A** | 扩展 `RuntimeStateManager`（读方法）与 `storage-paths.ts` 的既有解析器（`resolveStateDbPath` / `resolveTrajectoryDbPath`），让读侧返回三态 `{status:'ok'\|'missing'\|'unreadable'}`；**复用既有 `SqliteConnection` 端口，不新增公共导出 / 不新增 io-seam 登记** | 是 | 无新增公共类型 → 无需 `.changeset` |
| **1B** | 试点三处改走既有只读连接 / 解析器 / 三态结果：read-model、`ActivationsConsoleModel` 读侧、`OwnerDecisionConsoleModel` 的 catch 分支 | 需 1A 存在 | 逐行 `warning` 的 UI 缺口在 **2B-c**，不在这里 |
| **1C-read** | console 读侧剩余部分（17 文件中的读连接） | 需 1A/1B | 约 27 处 |
| **1C-write** | console 写侧 8 处（不定义 `WorkspaceStateWriter`；按 PRI-1209 的写路径评审单独推进） | 需 1A | **不排期** |
| **1D** | `host-runtime` 14 处 + 7 个 better-sqlite3 文件改走既有只读连接 / 解析器；5 张 `governance_*` 表**登记为独立库**（不迁 DDL） | 需 1A | 需要登记表 + 豁免测试 |
| **1E** | `pd-cli` 10 处 + `openclaw` 7 处改走既有只读连接 / 解析器 | 需 1A | |
| **1F** | CI 守卫：非 core 包禁止**未登记**的 `SqliteConnection` / `better-sqlite3`；测试侧直连 SQL 计数基线只降不升 | 需 1A–1E | 见下"1D 与 1F 的冲突" |

**1D 与 1F 的冲突（M8）**：1D 允许 `governance_*` 作为独立库存在（仍在 host-runtime，仍需连接），1F 又要求非 core 连接为 0 —— 二者不能同时成立。解决：新增一份**独立库登记表**（表名 → 域 / 写者 / 读者 / 生命周期），1F 只拦"未登记"的连接，并对登记表本身加测试（防止第三个野生库悄悄出现）。

**测试收敛机制（M7）**：

1. **新测试**一律经 core 的 seed/arrange helper 造状态（helper 随 1A 落地，只覆盖已迁移的表）。
2. **存量**按"改动到的文件必须顺手迁移断言"（boy-scout），不做全仓扫描、不一次性改写 105 个文件。
3. **1F 基线**：把当前的 **326 条直连 SQL / 105 文件**写成计数基线，只降不升；每次 PR 若上升，必须解释。

**有意接受的边界（写清，不假装能解决）**：本阶段**不承诺**把测试侧降到 0。"改一次表结构只落 core"只对**产线**成立；对测试侧，收益是"新增测试不再增加直连"，存量随触碰逐步下降。因此 §5 的收益表按"产线显著下降、测试侧近乎不变"记录，不用产线收益给测试侧背书。

### 4.5 验收判据

1. `rg "new SqliteConnection\(" packages --glob '!**/principles-core/**'` = 0（1C-write/1D 完成后）；未完成的批次用"登记表"解释剩余项。
2. `CREATE TABLE` 只出现在 core schema 所有权文件，或登记为"独立库"的文件中（登记表有测试）。
3. 事故 #1 回归：激活存在但工件缺失 → 读侧返回缺失清单，Console 显示"已启用但工件缺失"。
4. 读模型对"0 行"与"引用损坏"返回不同 `status`，有测试断言两者不相等（1B 覆盖 `clean` 的跳过行）。
5. 性能不回退：1 万行 fixture 上查询耗时不超改造前的 1.2 倍（读侧不加缓存、不做二次查询）。
6. 架构守卫：复用已登记的 `SqliteConnection` seam（**无新增 io-seam 条目**）；`architecture-regression` 通过。

### 4.6 停止条件

1. 方案退化为"新建第二个 state.db 组合根"（例如另造 `WorkspaceState` / `WorkspaceStateReader`）、或需要放宽只读保护才能完成 → 停，写路径归 `1C-write` / PRI-1209。
2. 出现第二套 schema 真相。
3. 需要数据迁移或回填 → 停。
4. 需要修改 `snapshotDigest` 输入字段 → 停。
5. **开工前写死文件清单，超出即停**（取消"1.5 倍"）。
6. 试点的三处中任一处依赖"部分失败仍继续"的旧行为且无法用 `status` 表达 → 停并记录。

### 4.7 回滚方式

- 每批按文件/按包独立提交；全程无 schema 变更、无数据迁移。
- 回滚 = `git revert <批次提交>`；**逆序**执行（1E → 1D → 1C-read → 1B → 1A）。
- 1D 的"独立库登记"回退 = 删除登记项，代码路径不变。

### 4.8 风险

| 风险 | 说明 | 应对 |
|---|---|---|
| **测试侧第二套写法** | 105 文件 / 326 条直连 SQL 继续绑定表结构 | §4.4 三条机制 + 基线；**明确写下这是有意接受、只降不升** |
| 读侧抽象变浅 | 若只是 `getDb()` 包装 | 只暴露语义查询，不暴露 SQL / 表名 / 行形状 |
| 性能 | 多一层调用 | 1 万行基准 |
| 归属判断错误 | `governance_*` 错判为独立库会掩盖问题 | 单独决策卡（谁写、谁读、生命周期），Owner 确认后再动 1D |
| 与在途任务冲突 | 1D/1E 碰 `host-runtime` / `openclaw` | 串行；1D 前确认无在途 host-runtime 改动 |

### 4.9 人日（修正）

| 批次 | 前一版 | 修正后 | 低估原因 |
|---|---:|---:|---|
| 1A | 1.0–1.5 | **1.5–2.0** | 漏算 io-seam 登记、`.changeset`、seed helper |
| 1B | 1.0–1.5 | **1.5–2.0** | 试点从 1 处扩到 3 处（含 read-model 契约变更） |
| 1C-read | （1C 1.5–2.0） | **2.0–3.5** | 27 处跨约 14 文件；每处 1–2 小时是下限 |
| 1C-write | 未单列 | 不排期（若做 **2.0–3.0**） | 8 处写连接 + 事务语义 |
| 1D | 2.0–3.0 | **2.5–4.0** | 5 张表归属决策 + 登记表 + 豁免测试 |
| 1E | 1.0–1.5 | **1.5–2.0** | 17 处 + 宿主只读假设核实 |
| 1F | 0.5 | **0.5–1.0** | 生产守卫 + 测试基线两条 |
| **读侧合计** | 7.0–10.0 | **9.5–14.5**（1A/1B/1C-read/1D/1E/1F） | |
| **含写侧** | 7.0–10.0 | **11.5–17.5** | 与独立评审的 11–17 一致 |

---

## 5. 收益：按任务分开算，不互相背书

口径：沿真实调用链，从"入口"到"判定/持久化"，必须打开的非测试文件数。

### 5.1 任务 A：查"这个激活为什么晋升不了"（**诊断**）

| 阶段 | 文件数 | 行数 |
|---|---|---|
| 现在 | 11 | **9,416**（evaluator 73 + reader + decision-service + snapshot + shadow-summary + openclaw-promotion-checks + CLI `runtime-activation.ts` + `ActivationsConsoleModel.ts` + `OwnerDecisionConsoleModel.ts` + `validators.ts` + `ActivationPage.tsx`） |
| 5A+5B 后 | 1（先读输出）+ 2（必要时定位） | **约 500–900** |

**下降 85–95%——这是整个计划最真实、最大的收益。** 前提是 5B 把 10 个 `checkId` 也纳入展示，否则仍要翻 `openclaw-promotion-checks.ts`。

### 5.2 任务 B：加一个配置字段（**修改**）

| 阶段 | 文件数 | 行数 |
|---|---|---|
| 现在 | 4–5 | **1,859 total + 消费方**（types 488 + defaults 140 + validate 932 + effective 299） |
| 3A 后 | 4–5 | **同上** |
| 前一版声称 | 8 → 2 | 3,600 → 1,200 ❌ **撤回** |

**下降接近 0（文件数不变）。** 收益是"漏改 validate/effective 会红"，不是"少读一半"。这是好事，但不能用来给 Phase 3 的 4–7 人日背书。

### 5.3 任务 C：改一次工作区表结构（**修改**）

| 阶段 | 产线文件 | 测试文件 |
|---|---|---|
| 现在 | **45**（70 处直连） | **105（326 条直连 SQL）** |
| Phase 1 读侧后 | 约 3–6（core 内） | **105（不变，靠 baseline 只降不升）** |

**产线显著下降、测试侧近乎不变。** 这就是前一版"只落 core ≤5 文件"的说法必须打折的原因。

### 5.4 需要人记住的隐含约定

现在至少 8 条：可写表清单、配置字段四层接线、快照 digest 输入、状态优先级（`unavailable > blocked > evidence_insufficient > ready`）、10 个 required checkId、测试 arrange/assert 规则、安装器配置保留语义、两套影子摘要采集。

计划后约 **8–9 条**：前 6 条中的一部分被文档化，但新增 criteria 词汇、`fieldStatus` 语义、读侧三态边界、独立库登记表。

**净减 1–2 条，不是数量级下降。** 前一版的"约定变检查"表述保留，但不再暗示总数大幅下降。

---

## 6. 时间跨度与并行度（修正）

### 6.1 总额

**修正后：20–30 人日。**

这个数字是**排期沟通区间，不是承诺**。按批相加会得到两个不同的和，因为"要不要做可选批"由 Owner 决定：

| 口径 | 组成 | 合计 |
|---|---|---:|
| 全范围（含 3B/3C/3D/1C-write） | 5: 3.0–4.5 + 3: 7.0–12.0 + 1: 11.5–17.5 | **21.5–34.0** |
| 同上，扣除已完成的 5A（1.0） | | **20.5–33.0** |
| 建议首轮（5 全做 + 3A + 1 读侧 + 2B） | 5: 3.0–4.5 + 3A: 1.0–2.0 + 1 读侧: 9.5–14.5 + 2B: 1.5–2.0 | **15.0–23.0** |

"20–30" 对应的是"全范围、扣除已完成部分"的下半段（20.5–33.0）。**不要用它做单批承诺**，也不要用它反驳按批相加的明细。

### 6.2 前一版被低估的批次与原因

| 批次 | 前一版 | 修正后 | 为什么低估 |
|---|---:|---:|---|
| Phase 1 总体 | 7–10 | 11.5–17.5 | 非 core 产线文件是 **42** 不是"约 25"；1C 的 27 处跨 14 文件且含写路径 |
| 1C | 1.5–2.0 | 2.0–3.5（读）/ +2.0–3.0（写） | 忽略了写连接的存在 |
| 3D | 1.5–2.5 | 拆成 1.0–1.5 + 2.5–4.0 | 保注释 YAML 写回要 document API |
| 5B | 1.0–1.5 | 1.5–2.5 | 漏算双语文案、`.changeset`、契约测试、10 个 checkId 文案 |
| 5A | 0.5–1.0 | 1.0（实测）；若按 10 checkId 口径 2–3 | 两种口径范围不同 |
| 未计入的固定成本 | 0 | `.changeset`、`io-seam-registry` 登记、架构守卫、评审往返、E2E/BDD | 前一版完全没写 |

### 6.3 并行度

| 在途任务 | 冲突判断 | 结论 |
|---|---|---|
| faux 测试改造（core 测试目录） | 文件不重叠 | 可并行，错开合并窗口 |
| UI 升级（`pd-console/src/ui`） | **5B / 2B-c 直接冲突**（`validators.ts`、`ActivationPage.tsx`） | 串行 |
| PRI-1044 生产验证（`host-runtime` / `openclaw`） | **1D/1E 直接冲突** | 串行 |
| 配置相关工单（PRI-1119 类） | **3A 冲突** | 串行 |
| 安装器改动 | 3E 已延后 | 可并行 |

**规则**：同一时刻只有一个阶段在动 `pd-console/src/ui` 或 `host-runtime`；同一包同一时间只允许一个阶段。

---

## 7. 批次回滚对照（**只保证逆序**）

前一版写"每批可独立 revert"。**这不成立。** 逐条列出抽查的三个批次：

| 批次 | 为什么不能单独回退 | 真实依赖 |
|---|---|---|
| **5C** | 5B 已按 `criteria` 字段读取；单独 revert 5C 会让 5B 引用的必填字段消失，编译失败 | 5A（投影函数）→ 5B（消费点）→ 5C（字段化）。只能 5C → 5B → 5A 逆序撤 |
| **3D** | 3A 只定义 `readWorkspaceConfig`；`writeWorkspaceConfig` 在 3D 内诞生。读侧委托改了 import，写侧删掉了三个写入口的 YAML 解析；单独 revert 读侧会让写侧仍引用已删实现 | 3A（新读函数）+ 3D-write（新写函数）。**拆成 3D-read / 3D-write 后**，两者各自可逆序撤；否则只能整体撤 |
| **1C** | 1C 依赖 1A 的读侧能力与 1B 在同一文件建立的模式；且含 8 处写连接，而 1A 读侧只读 | 1A（读侧能力）→ 1B（模式）→ 1C。**拆成 1C-read / 1C-write 后**，写侧可单独不排期 |

**结论（二选一，本计划选前者）**：

- ✅ **调整批次切法**：已拆 `3D-read` / `3D-write`、`1C-read` / `1C-write`，并把 5B 拆成"host-runtime 提取"与"两处展示"两个提交。
- ❌ 承认只能逆序撤 → 不作为结论，因为拆分成本很低。

**统一规则**：所有批次保证"**逆序可回退**"；不保证"任选一批撤回"。任何 PR 描述里不得再写"可独立 revert"，除非该批次的依赖为空。

---

## 8. 本计划不做什么 / 什么时候才该动

### 8.1 不做

沿用评审报告 §5 的 7 条"不该动"与 §6 的 7 个伪目标，结论不变：

**7 条不做**：不动 core 的公共导出与包目录；不按行数拆大文件；不合并三个宿主适配器；不新建事件/遥测框架；不做全仓 `as`/`any` 清理；不动 Console 页面组件（5B / 2B-c 的展示位除外）；不引入新特性开关。

**7 个伪目标**：拆 `installer.ts` 成 10 个文件；给 core 加更多 subpath exports；把 `better-sqlite3` 换成 `SqliteConnection` 就算收口；给每个 catch 加日志；把 10 个 prompt-builder 合成 1 个；用"接线守卫"锁住更多命令；合并 `state.db` 与 `trajectory.db`。

**本计划额外不做**：
- 不做任何数据迁移或回填；
- 不改 `snapshotDigest` 输入字段；
- 不改三宿主的 hook 生命周期与注册方式；
- 不在本轮新增 Linear 工单（是否立项由 Owner 决定）；
- 不做 `validators.ts` 的生成化改造（见 §9）；
- 不做测试目录的全仓迁移（只做基线 + boy-scout）。

### 8.2 暂缓项的触发条件（改为事件触发 + 定期复核）

前一版的"连续 30 天无改动"在活跃仓库里接近永远等不到：`rule-host.ts` 与 `production-rulehost-gate.ts` 最后改动 2026-11-07，`workbuddy-host-installer.ts` 2026-11-08。

| 项 | 触发条件 |
|---|---|
| 第 2 项（规则评估四合一） | ① 5B 的 criteria 已合并（**当前事实：未合并**，见 §2.3 状态更正；本条触发条件尚未满足）；② **任一 PR 同时修改** `production-rulehost-gate.ts` 与 `rule-host.ts` 即启动；③ 或出现"同一缺陷在 ≥2 个宿主各修一次"的第二次实例；④ 每 6 周复核一次并记录"继续暂缓"的理由 |
| 第 4 项（安装五阶段） | ① `writeWorkspaceConfig` 已合并；② 安装侧出现"binding 版本不同步"类问题的第二次实例；③ 每 6 周复核一次并记录理由 |
| 3B/3C（配置 loader 委托） | 下次因其他原因改到该 loader 时顺带做；不做等价矩阵，除非同行 |
| 3D-write | console 写路径出现一次真实写坏配置的事故，或出现第二个写者 |
| 1C-write | 同一写入缺陷在 ≥2 个包各修一次 |
| O1（共享结论词汇） | 2B + 1A 合并后，出现 ≥3 个"带原因的结论"的真实实现 |

---

## 9. AI 维护成本：计划之外、但同样影响"改一个需求要读多少"的部分

这一节回答"哪些是真的成本、哪些只是看着重"。**不是任务清单**，只有 §9.3 的两项落进批次。

### 9.1 逐项判断

| 项 | 规模（实测） | 成本形态 | 是真成本还是看着重 | 判断 |
|---|---|---|---|---|
| `validators.ts` 手写白名单 | **3,934 total / 3,564 non-blank** | 每加一个 API 字段：写一条同构 validator + 一条测试；漏写则字段被静默丢弃（2B-c 就是实例） | **真成本，高** | 高频（每加字段都付）+ 产生静默丢字段。但它与 5C 耦合，本轮只记成本，不做生成化 |
| `runtime/index.ts` 桶文件 | **2,371 total / 2,147 non-blank** | AI **不需要读**它；只要 grep 到符号名 | **看着重，实际轻**（对检索）；真成本在"公共表面治理" | 不因"文件大"去拆。真正的成本是每个新导出都是一次公共承诺——PRI-775 的冻结 fixture 已经在管这件事 |
| 双语文案 | `zh-CN.json` / `en.json` 两份 | 每个新 UI 状态/原因要写两遍，漏写则一半语言不可读 | **真成本，低到中** | 每批 UI 都付。已纳入 5B / 2B-c 的人日 |
| `.changeset` | 一次 1 行文件 | 忘写则 release 检查红 | **流程成本，不是理解成本** | 不排期；写进每批 checklist |
| `io-seam-registry.json` 登记义务 | core 每次新增 I/O 付一次 | 忘登记 → 架构守卫红 | **真成本，低** | 正面价值是防止 core 变成 I/O 垃圾场。已纳入 1A 验收 |
| 测试规模 | **1,350 文件 / 402,641 行**（独立评审复算，本文未单独复核）；已大于产线（999 / 284,024） | "这个行为在哪测的"要靠搜；改表结构会让大量夹具失效 | **真成本，最高** | 但它不是"读代码"成本，是"找测试"成本。本计划只做基线（§4.4），不做结构性治理 |
| `runtime-v2` → `runtime` 改名后的文档漂移 | `CONTEXT.md` / 架构文档 | 检索到旧路径，多跳一次 | **真成本，中** | 一次性同步即可，不需要计划 |

### 9.2 排序（按"每次改需求都要付"的频率 × 单次成本）

1. **测试规模**（每次找"这行为在哪测的"都付）——最高，但本计划只做基线。
2. **`validators.ts`**（每加字段都付，且会静默丢字段）——高。
3. **双语文案**（每批 UI 都付）——中，已进批次。
4. **`io-seam-registry`**（每次 core 加 I/O 付）——低，已进 1A。
5. **文档漂移**（改名后一次性）——低，一次性。
6. **`runtime/index.ts` 桶文件**——**伪成本**（对 AI 检索而言）。
7. **`.changeset`**——流程成本，不便理解。

### 9.3 只有两项落进批次

- 双语文案 → 5B / 2B-c 的验收里。
- `io-seam-registry` → 1A 的验收里。

其余五项**记录成本、不排期**。特别是 `validators.ts`：它的降本方式是"从 schema 生成"或"减少 API 字段"，两者都不是本计划的范围；把它塞进来会变成一次全仓重构（P3 禁止）。

---

## 10. 顺序结论（重排）

### 10.1 结论

**顺序应为：5A（已完成）→ 2B（可见性缺口）→ 5B → 5C → 3A → 1A/1B/1C-read → 其余按触发条件。**

具体地：

| 序 | 批次 | 人日 | 为什么在这个位置 |
|---|---|---:|---|
| 1 | **5A** ✅ | 已完成 | 已完成，且是后续所有展示的前提 |
| 2 | **2B**（read-model 跳过行 / 决策列表 catch / 逐行 warning） | 1.5–2.0 | 独立小批；不需要 UI 串行（2B-c 除外，0.5 天）；直接命中事故 #1 的三个环节 |
| 3 | **5B** | 1.5–2.5 | 把 5A 的能力接到 CLI 与 Console——**这是"AI 能少读 85–95% 文件"真正兑现的地方** |
| 4 | **5C** | 0.5–1.0 | 契约收口；必须在 5B 之后 |
| 5 | **3A** | 1.0–2.0 | 1–2 人日修掉事故 #2 的真因；不做它，事故 #2 永远在 |
| 6 | **1A + 1B + 1C-read** | 5.0–7.5 | 读侧试点；等 2B/5B 建立的"结论词汇"形状稳定后，再把读侧接到既有 `RuntimeStateManager` / 解析器 |
| 7 | 1D / 1E / 1F | 4.5–7.0 | 按包推进 |
| — | 3B/3C、3D-*、3E、1C-write、2/4 项 | 不排期 | 触发条件见 §8.2 |

### 10.2 "先把晋升链路走通到页面"应该排在"配置收敛"和"存储收口"之前——是

依据四条，都是可复算的：

1. **收益差距是数量级的。** 晋升诊断：11 文件 / 9,416 行 → 1+2 文件 / 500–900 行（85–95%）。配置收敛：文件数不变（4–5 → 4–5，1,859 行不变），收益只是"漏改会红"。存储收口：产线 45 → 3–6，但测试侧 105 文件 / 326 条 SQL 不动。
2. **成本差距是 3–5 倍。** 5B+5C 合计 2.0–3.5 人日；Phase 3 全做 7–12 人日；Phase 1 全做 11.5–17.5 人日。
3. **风险差距最大。** 5B 只改渲染与文案，失败模式是"文案不对"；Phase 1 要动 42 个产线文件、含 8 处写连接、牵动 105 个测试文件，失败模式是"数据读错"。
4. **5A 已经付了沉没成本。** 判定层已经能导出 reasons；不把它接到页面，这层能力就是零消费者（§2.8 最后一条风险）。让已投入的能力产生价值，比开一条新战线更符合最小改动面。

### 10.3 如果 Owner 的目标是"AI 改需求更快"，最高杠杆不在本计划的三个阶段

按 §9 的排序，"改一个典型需求"的最大摩擦是**测试规模**与 **`validators.ts`**，不是配置读取或 SQL 直连。因此：

- 若目标是 **Owner 体验**（能看到为什么晋升不了）→ 走 §10.1 前 3 步。
- 若目标是 **AI 开发效率** → 先做 §9 的第 1、2 项（测试可发现性 + 白名单生成化），它们的收益可能超过整个 Phase 1。
- 若目标是 **减少跨包事故** → 3A（1–2 人日）是性价比最高的一步，其余配置工作可以不做。

这三条目标不应混在一个计划里排期，否则会出现"三件事都做一半"。

### 10.4 什么情况下我会改这个结论

- 若出现第二次"配置字段被静默丢弃"的事故 → 3A 立刻前移到第 2 位。
- 若 Console 出现"激活显示正常但实际未武装"的复发 → 2B 前移到第 1 位（5A 之后）。
- 若 `host-runtime` 需新增第 6 张自建表 → 1D 的归属决策必须提前，否则第三套 DDL 会诞生。

---

## 11. 触面汇总（修正）

| 阶段 | 产线文件 | 测试文件 | 包数 | 公共契约变更 | 数据迁移 |
|---|---:|---:|---:|---|---|
| 5A ✅ | 3 | 1（新增） | 1（core） | 无 | 无 |
| 5B/5C | 约 8（core 1 + cli 1 + console 4 + 桶 2） | 8（3 夹具 + 5 断言） | 3 | 仅 5C | 无 |
| 2B | 3（core read-model 1 + console model 2）+ UI 2 | 约 3 | 3 | 2B-a 是 | 无 |
| 3A | 4（core types/defaults/validate/effective）+ 桶 1 | 约 3 | 1–2 | 新增导出 | 无 |
| 1（读侧） | **42 个非 core 产线文件**（console 17 / host 9 / cli 10 / openclaw 6）+ 复用 core 既有连接/解析器 | 约 15（试点）+ 105 存量（只做基线） | 5 | 无新增导出 | 无 |

Phase 1 的"42"是**非 core 包中出现 `new SqliteConnection(` 的产线文件数**（已复算：`NONCORE_FILES=42`）。前一版写"约 25"。

---

## 附录 A：关键文件与行号

**Phase 5**

- `packages/principles-core/src/runtime/activation/promotion-readiness-evaluator.ts:3-7`（10 个 required checkId）、`:41-43`（`shadow_telemetry_source_unavailable` 入 unavailable）、`:53-56`（unavailable 提前返回，5A 未改）、`:58-60`（failedChecks）、`:65-68`（4 个阈值，5A 已收口）、`:69-72`（status 由 criteria 派生，5A 已改）
- `packages/principles-core/src/runtime/activation/rulecode-owner-decision-service.ts:32`（`PromotionReadinessResult`）
- `packages/principles-core/src/runtime/activation/rulecode-shadow-summary.ts:27`（core 聚合）
- `packages/pd-cli/src/commands/runtime-activation.ts:132`（采集器副本）、`:147-155`（静默忽略坏行/坏目录）、`:161`（`readShadowSummaryForActivation`）、`:167`（调 core 聚合）
- `packages/pd-console/src/server/models/ActivationsConsoleModel.ts:214`（采集器副本）、`:272`（调 core 聚合）、`:451-453`（逐行 `warning`）、`:307`/`:320`/`:566`（`degraded` + reason）
- `packages/pd-console/src/server/models/OwnerDecisionConsoleModel.ts:339-342`（`catch { continue; }`）
- `packages/pd-console/src/ui/utils/validators.ts:1457`、`:1528-1536`、`:1551`、`:1568`（激活条目白名单；**无 `warning`**）
- `packages/pd-console/src/ui/pages/activation/ActivationPage.tsx:168`、`:180`、`:187`、`:208`、`:212`；`:694-697` + `:914-917`（顶层 `degradedNote`）

**Phase 3**

- `packages/principles-core/src/runtime/config/pd-config-validate.ts:305-316`（`validatePdLocalProfile` 逐字段白名单，**缺 `systemPrompt`**）、`:319-347`（`validateRuntimeProfile`）
- `packages/principles-core/src/runtime/config/pd-config-types.ts:113-117`（`systemPrompt` 声明）
- `packages/principles-core/src/runtime/config/pd-config-effective.ts`（`{ ...profile }` 保字段）
- `packages/pd-cli/src/services/pd-config-loader.ts:112`
- `packages/pd-console/src/server/config/pd-config-store.ts:249`（另有 3 个写入口）
- `packages/host-runtime/src/pd-config.ts:75`
- `packages/create-principles-disciple/src/mvp-config.ts:481`
- 消费方：`packages/pd-config-agent-binding.ts:277-278`

**Phase 1 / 2B**

- `packages/principles-core/src/runtime/activation-compatibility-read-model.ts:31`（状态枚举）、`:63-72`（`no_state_db`）、`:93-105`（**5 个** `continue`）、`:120`（`clean`）、`:122`（`scannedActivations`）
- `packages/pd-cli/src/commands/runtime-compatibility-scan.ts:24-67`（该结果的 CLI 消费者）
- `packages/pd-console/src/server/models/ActivationsConsoleModel.ts`（35 处直连 / 8 处中 6 处 `readonly:false`）
- `packages/pd-console/src/server/routes/feedback-reports.ts`（2 处 `readonly:false`）
- `packages/host-runtime/src/governance-observation-store.ts:206-267`（5 张自建表）、`:338-343`（直开 `.trajectory.db`）
- `packages/pd-console/src/server/models/IntentPageModel.ts`（1 条建表）
- `packages/openclaw-plugin/src/service/correction-observer-service.ts`（1 条建表）

## 附录 B：可复跑命令（数字已复算）

```powershell
$root='d:\Code\principles\packages'
$files=Get-ChildItem $root -Recurse -File -Include *.ts,*.tsx |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\' }
$prod=$files | Where-Object {
  $_.FullName -notmatch '\\tests?\\|__tests__' -and $_.Name -notmatch '\.test\.tsx?$' }

# 存储接触点（复算：SC_OCC=70 SC_FILES=45）
($prod | Select-String 'new SqliteConnection\(').Count
($prod | Select-String "from 'better-sqlite3'").Count                       # 34（前一版注释误写 33；文件数 33）
($prod | Select-String 'CREATE TABLE').Count                                # 54 / 8 文件

# 非 core 产线文件（复算：42）
$sc=$prod|Select-String 'new SqliteConnection\('
($sc|Where-Object{$_.Path -notmatch '\\principles-core\\'}|ForEach-Object{$_.Path}|Sort-Object -Unique).Count

# 写连接（console：8 处 / 2 文件）
$prod | Select-String 'readonly: false' |
  ForEach-Object { $_.Path } | Group-Object |
  Where-Object { $_.Name -match 'pd-console' } | Select-Object Name,Count

# 测试侧直连 SQL（复算：TEST_OCC=326 TEST_FILES=105）
$tests=$files | Where-Object { $_.FullName -match '\\tests?\\|__tests__' -or $_.Name -match '\.test\.tsx?$' }
$t=$tests|Select-String -Pattern 'FROM activations|INTO activations|UPDATE activations|JOIN pi_artifacts|FROM pi_artifacts|INSERT INTO pi_artifacts'
"TEST_OCC=$($t.Count) TEST_FILES=$(($t|ForEach-Object{$_.Path}|Sort-Object -Unique).Count)"

# 配置读取实现与调用点
Get-ChildItem $root -Recurse -File -Include *.ts |
  Select-String 'export function (loadPdConfig|loadPdConfigForPlugin|validateConfigYamlFull)'
($prod | Select-String 'loadPdConfig\(|loadPdConfigForPlugin\(').Count      # 90

# 事故 #2 根因（复算：0）
Select-String -Path (Join-Path $root 'principles-core\src\runtime\config\pd-config-validate.ts') -Pattern 'systemPrompt'

# 行数口径（两列都打，避免混用）
foreach($p in @('principles-core\src\runtime\index.ts','pd-console\src\ui\utils\validators.ts')){
  $f=Join-Path $root $p; "$p total=$((Get-Content $f).Count) nonblank=$((Get-Content $f|Measure-Object -Line).Lines)" }
```

## 附录 C：批次提交与回退对照（逆序）

| 批次 | 建议提交信息 | 回退动作 | 迁移回滚 |
|---|---|---|---|
| 5A ✅ | `refactor(readiness): derive status from criteria (no contract change)` | revert 该提交 | 否 |
| 2B-a | `fix(core)!: report skipped rows in activation compatibility scan` | revert（连带 CLI 输出测试） | 否 |
| 2B-b | `fix(console): surface unreadable decisions instead of dropping them` | revert | 否 |
| 2B-c | `fix(console): render per-activation artifact warning` | revert | 否 |
| 5B-core | `refactor(host-runtime): extract rulecode event collection` | revert（需 5B-ui 之后） | 否 |
| 5B-ui | `feat(console,cli): show promotion criteria remaining` | 按包 revert | 否 |
| 5C | `refactor(core)!: add criteria to PromotionReadinessResult` | revert **必须连带 5B** | 否 |
| 3A | `feat(core): cover every declared config field in validate/effective` | revert | 否 |
| 1A | `refactor(core): extend runtime state readers (no new port)` | revert | 否 |
| 1B | `refactor(console): read activation state via existing reader` | revert | 否 |
| 1C-read | `refactor(console): migrate remaining read connections to existing reader` | 按文件 revert（在 1B 之后） | 否 |
| 1D | `refactor(host-runtime): read via existing reader; declare independent db` | 按文件 revert | 否 |
| 1E | `refactor(cli,openclaw): read via existing reader` | 按包 revert | 否 |
| 1F | `chore(ci): forbid unregistered sqlite access; add test baseline` | revert 守卫 | 否 |
| — | 3B/3C、3D-read、3D-write、1C-write、3E | 不排期 | — |

---

## 附录 D：本版修订记录

| 章节 | 改了什么 | 来源 |
|---|---|---|
| §0 | 新增"对独立评审的逐条回应"，含 3 处事实纠正与 3 条明确反驳 | 本轮要求 |
| §1.4 | 产线文件 11 → 13；测试文件 8 → "3 夹具 + 5 断言" | 独立评审 §1.2 |
| §2.0 | 新增 5A 完成记录（PR #2478、红→绿性质、公共 barrel 未动原因） | 本轮实现 |
| §2.3 | 新增"逆序可回退"列；5B 补 i18n / changeset / 摘要提取 | M5、M10、M11 |
| §2.5 | R4 重写为"防复制漂移守卫"，并写清它如何先红 | M2 |
| §2.6 | 停止条件改为文件清单 + 三种 fixture | M12 |
| §2.9 | 5B 1.0–1.5 → 1.5–2.5 | 独立评审 §2.7 |
| §2B | 新增"可见性缺口"独立小批 | 本轮判断 |
| §3 | 事故 #2 归因重写；Phase 3 降级为仅 3A | M1 |
| §4.3 | 端口边界三方案取舍，采纳"读写双通道"（**已被 PRI-1207 否决，见下条**） | M4 |
| §4.3 / §4.4 / §4.6 / 附录 C | 改为"扩展现有 `RuntimeStateManager` + `storage-paths.ts`"，删除 `WorkspaceStateReader`/`WorkspaceStateWriter` 新建方案；读写计数按现码更正为 9 读 / 5 写（依据：`internalization-integrity-remediation.ts` 14 处 `new Database(` 逐行判定，base `6c83d6126`） | PRI-1207 / PR #2627 + 2026-11-14 复核 |
| §4.4 | 42 文件；测试收敛机制；有意接受的边界 | M6、M7、M8 |
| §5 | 收益表按任务分开；撤回"8 文件 / 3,600 行 → 2 文件 / 1,200 行" | M1、O5 |
| §6 | 13–20.5 → 20–30，并给出两套明细 | M6 |
| §7 | "可独立 revert" → "仅逆序成立"，列 5C/3D/1C 真实依赖 | M5 |
| §8.2 | 触发条件改为事件触发 + 6 周复核 | 独立评审 §7.5 |
| §9 | 新增"AI 维护成本"一节并排序 | 本轮要求 |
| §10 | 新增顺序结论（重排为 5A→2B→5B→5C→3A→1 读侧） | 本轮要求 |
| 附录 B | `# 33` → 34；补 42 / 326 / 0 / 行数口径 | 独立评审 §6.10 |
