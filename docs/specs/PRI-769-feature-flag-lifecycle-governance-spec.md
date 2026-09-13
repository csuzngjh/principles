# PRI-769 — Feature Flag Lifecycle Governance SPEC

> 日期：2026-09-13 · 基线：`origin/main` `49814cddd`（2026-09-13 00:00 +0800）
> 性质：**治理设计 SPEC，不实现代码**。本文所有事实均直接取自该基线的生产代码、测试与注册表；不采信历史审计结论，历史材料仅作叙事线索并在引用处重新核验。
> 约束遵守：本 SPEC 不删除任何 flag、不修改 flag contract、不修改 runtime behavior、不新增 flag framework、不做大规模重构。所有落地建议均为**后续独立小 PR**，逐项等 Owner 批准。

---

## 1. Current Reality

### 1.1 注册表事实（一手读取，`49814cddd`）

单一 SSoT：`packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts` 的 `DEFAULT_FEATURE_FLAGS`。

| 类别 | 数量 | 语义（`computeEffectiveFlags` 强制） |
|---|---|---|
| `core` | 9 | 默认 ON；显式 `enabled:false` = 应急关闭（带 warning，可观测） |
| `quiet` | 31 | 完整 override；**每条强制携带 census 生命周期决策**（contract test 双向封死） |
| `gone` | 5 | 终态墓碑：default false、复活被可观察拒绝、不携带 census 条目 |
| `legacy_retire` | 0 | 词汇表存在但零使用，且 `feature-flag-lifecycle.test.ts` 把它**钉死为 0**（实际不可用） |

派生链（已核实为单一权威，非复制品）：

```
feature-flag-contract.ts (DEFAULT_FEATURE_FLAGS)
  ├─ runtime-v2/config/pd-config-defaults.ts（循环派生，同一来源 ✓）
  │    └─ config/pd-config-feature-flags.ts → computeFeatureFlagsFromConfig（第二套 resolver）
  ├─ feature-flags/feature-flag-contract.ts → computeEffectiveFlags（第一套 resolver）
  │    └─ host-runtime pd-config.ts → loadFeatureFlagFromConfig
  └─ create-principles-disciple：fresh config 只写 sparse `features: {}`（PRI-645）
```

已知债务（`docs/architecture/feature-flag-governance.md` §1 自认）：两套 resolver 的**语义分支**（gone 拒绝复活 / core 应急关闭 / unknown 告警）是两份重复实现。PRI-752 的 gone 墓碑修复必须同时改两处——这是漂移成本的直接实证。

### 1.2 Feature Flag Matrix（45 条，`49814cddd`）

Status 词汇：`ACTIVE`（真实改变运行行为）/ `EXPERIMENT`（quiet 默认关、有可执行消费者）/ `COMPATIBILITY`（为兼容旧配置/旧行为存在）/ `DEPRECATED`（已判定待删）/ `GONE`（终态墓碑）。**本基线无 DEAD（零消费者）flag**——2026-09-12 的 5 个 DEAD 已全部处置（3 墓碑化、2 删除）。

消费者证据方法：全量 45 flag 在 `49814cddd` 上做了非注册表 src 引用扫描；对 9 个关键 flag 复核了可执行调用点（file:line 级）；其余行的 file:line 底本来自 PRI-751 矩阵（基线 `4dce7d942`，仅早 4 个 commit 且其间无 flag 接线变更），标注 (751)。残留引用（enum-labels / 注释 / CostHint 等显示层）**不作为消费者证据**。

#### MVP-Core（9，全部 ACTIVE）

| Flag | Default | 可执行消费者 | Status |
|---|---|---|---|
| prompt | ON | active-principle-prompt.ts、runtime-v2 prompt activation reader (751) | ACTIVE |
| code_tool_hook | ON | `pd-config-feature-flags.ts` enabledChannels → internalization-queue / canary / features（⚠ host 侧 auto-consumer 腿硬编码 channels，双消费腿分裂） | ACTIVE |
| defer_archive | ON | 同 code_tool_hook（同一 enabledChannels 集合） | ACTIVE |
| rulecode_safety_controls | ON | runtime-activation.ts、ActivationsConsoleModel (751) | ACTIVE |
| rulecode_owner_live_decision | ON | runtime-activation.ts、ActivationsConsoleModel 强制门 (751) | ACTIVE |
| internalization_full_chain | ON | internalization-consumer-cycle.ts (751) | ACTIVE |
| code_rule_capability | ON | rulehost-readiness.ts、run-rulehost.ts (751) | ACTIVE |
| host.codex | ON | pd-hook / codex-setup / health-codex / workspace-worker (751) | ACTIVE |
| new_user_onboarding | ON | console App.tsx、routes/onboarding.ts (751) | ACTIVE |

#### Quiet 默认 ON（16）

| Flag | Default | 可执行消费者 | Status |
|---|---|---|---|
| internalization_auto_consumer | ON | plugin index shouldStart*、codex workspace-worker (751) | ACTIVE |
| story_a_approval_completion | ON | ApprovalsConsoleModel（本次复核：全仓唯一 src 引用） | ACTIVE |
| feedback_channel | ON | routes/feedback-reports.ts (751) | ACTIVE |
| release_manager_shadow | ON | `routes/update.ts:2013 isFeatureEnabled(flags,'release_manager_shadow')`（本次复核） | ACTIVE |
| release_manager_write_authority | ON | routes/update.ts /apply-full 权威路由 (751；有效性另依赖 `PD_RELEASE_METADATA_URL`) | ACTIVE |
| diagnostician_core_grounding | ON | diag-rootcause/distiller-runner (751) | ACTIVE |
| diagnostician_split_pipeline | ON | 仅剩 legacy-fold shim（pd-config-effective.ts）；**主动兼容行为**：对存量 legacy 配置会主动禁用 diagnostician 绑定，清理它=静默重启用管线 | **COMPATIBILITY**（governance doc 已标 DEPRECATE/DEFER DELETE，删它之前必须先移除 shim 依赖） |
| diagnostician_llm_degradation | ON | base-peer-runner.ts (751；live 被 Owner 关闭=走 legacy 硬失败，运行时证据见 §1.4) | ACTIVE |
| failed_tasks_observability | ON | routes/failed-tasks.ts (751) | ACTIVE |
| evaluator_artificer_repair_loop | ON | rulehost-pipeline-runner、consumer-governance (751) | ACTIVE |
| artificer_output_retry | ON | artificer-runner.ts permanentErrorCategories (751)；PRI-571/621 毕业状态由 contract test 锁定（本次复核） | ACTIVE |
| principle_receipt_block_copy | ON | gate-block-helper.ts (751) | ACTIVE |
| principle_receipt_ledger | ON | gate.ts/prompt.ts/milestone-readers (751) | ACTIVE |
| principle_governance_projection_v2 | ON | routes/principles.ts (751) | ACTIVE |
| failed_task_recovery_console | ON | failed-tasks recover 端点 (751) | ACTIVE |
| governance_experience_v1 | ON | routes/governance.ts、server/index.ts (751) | ACTIVE |

#### Quiet 默认 OFF（15，全部 EXPERIMENT——有真实消费者，等毕业或退役决策）

| Flag | Default | 可执行消费者 | Status |
|---|---|---|---|
| correction_observer | OFF | plugin index shouldStartCorrectionObserver (751) | EXPERIMENT |
| signal_collector | OFF | `signal-collector-host.ts:424`（本次复核；⚠ live flag ON 但 agent 绑定 OFF，两开关相反=实际休眠） | EXPERIMENT |
| gfi | OFF | runtime-canary.ts:156、CLI gfi（窄消费；评分链路无门控为已知 follow-up） | EXPERIMENT |
| diagnostician_async_cli | OFF | pain-record.ts (751) | EXPERIMENT |
| l2_dreamer | OFF | runtime-adapter-resolver、consumer-cycle (751) | EXPERIMENT |
| intent_engineering | OFF | intent.ts、diag-rootcause-runner、prompt.ts (751) | EXPERIMENT |
| rulecode_context_v2 | OFF | rule-host-writer、run-rulehost (751) | EXPERIMENT |
| artifact_summary_redundancy | OFF | base-peer-runner、context-trace (751) | EXPERIMENT |
| context_manifest_budget | OFF | base-peer-runner (751) | EXPERIMENT |
| progressive_evaluator | OFF | base-peer-runner (751) | EXPERIMENT |
| abstraction_layer_v1 | OFF | plugin index shouldUseSharedHostRuntime (751) | EXPERIMENT |
| principle_receipt_self_report | OFF | prompt.ts、principle-application-ledger (751) | EXPERIMENT |
| pain_diagnosis_persistence | OFF | pain-signal-runtime-factory、diag-rootcause-runner (751) | EXPERIMENT |
| anonymous_product_telemetry | OFF | product-telemetry/service、pd-cli telemetry (751) | EXPERIMENT |
| codex_conversation_ingestion | OFF | pd-hook/codex-setup/governance-observation-store (751) | EXPERIMENT |

#### Gone 墓碑（5，终态）

| Flag | 墓碑时间 | 残留非注册表引用（本次复核，均非消费者） |
|---|---|---|
| nocturnal / idle_trigger | 2026-05-24（初版即 gone） | 无行为消费者（dev 脚本/legacy 文本探测） |
| evolution_worker | 2026-09-12（PRI-752/#1622） | enum-labels.ts（显示标签）、pd-config-feature-flags.ts（注释） |
| empathy_observer | 2026-09-12（#1625） | enum-labels.ts、ControlCenterPage、EmpathyObserverCostHint（显示层；标签兼作 agent 显示名） |
| internalization_core_grounding | 2026-09-12（#1624） | enum-labels.ts、context-manifests.ts / peer-runner-types.ts（注释） |

#### 注册表外状态（记录，不属 flag 体系）

- live workspace 未注册键 `model_training` / `trainer`：每次加载触发 unknown-flag 告警（rc-9 可观察），workspace 卫生事项，归 Owner 处置。
- 环境变量门（`PD_RELEASE_METADATA_URL` 等）不在 flag 注册体系内。
- `painEvidenceAdmission` / `painEvidenceAdmissionDefault`：**已物理删除**（PRI-763，commit `c546d2def`），存量配置键此后走 unknown-flag 告警——这是与"墓碑"并存的第二种终态，见 §4.3。

### 1.3 Lifecycle Reality（现状流程考古）

**谁决定（git 实证，非文档声称）：**

| 决策 | 现实 | 证据 |
|---|---|---|
| 创建 | AI/开发者在 feature PR 中随功能诞生；结构性门槛=census 双向测试（PRI-610 起）；产品门槛=AGENTS §16 四问+§5 triage | `codex_conversation_ingestion` 单 commit（PRI-622）同时落 flag+census+消费者+测试 |
| 命名 | **无成文规则**。事实惯例：PRI-609 后 camelCase 为 canonical 身份，snake_case 降级为 alias（alias 表现已清空）；host 适配器用点分 `host.codex` | `FEATURE_FLAG_ALIASES = {}`（本次复核为空表） |
| 默认值 | registry `enabled`；翻 ON=毕业 PR，须 Owner 决策 + census GRADUATE 已执行证据（测试强制日期自洽） | `a1f05a7a6 feat(update): graduate release_manager flags (Owner decision 2026-09-07)` |
| consumer | 结构上 census.consumers 必填；**真实性无机器校验**（prose/glob，从未被测试比对现实）——即 #1628/#751 审计反复命中的洞 | `empathy_observer` census 曾声称 "openclaw-plugin observer wiring"，实际从未存在 |
| 删除 | Owner 授权波次（MVP-Gone #1622/24/25）或 protected zone 走 SPEC（PRI-763）；**终态形式（墓碑 vs 物理删除）无成文规则**，由评审轮临时掰出 | 评审 fix commit `d6323661e`/`907bcb231`："keep X as gone tombstone per census lifecycle" |

**元数据字段现状：**

| 字段 | 存在？ | 位置 |
|---|---|---|
| created date | ✅ `since`（必填 string，非空校验） | contract |
| owner | ❌ 无任何字段 | — |
| expiration | ❌ 无；时间触发仅是"review trigger"（census doc 明文，非自动删除） | — |
| removal plan | ⚠️ quiet 有：census `retirementCriteria`（测试强制非空）；core/gone 无（gone 已终态，core 归 Owner） | census |

### 1.4 已有护栏盘点（Guardrail Inventory）

**机器强制（CI 内有效）：**

| 机制 | 位置 | 覆盖与效力 |
|---|---|---|
| quiet↔census 双向封死 | `feature-flag-lifecycle.test.ts` | 无 census 条目的 quiet flag = CI fail（"feature purgatory = 0"）；孤儿 census 行 = CI fail |
| census 条目完整性 | 同上 | decision/consumers/evidence/decided/retirementCriteria 必填；KEEP_QUIET/STAGED 须 graduationCriteria；STAGED 须声明接线未落与去向 |
| GRADUATE 反注水 | 同上 | GRADUATE 行必须默认 ON + 已执行证据 + decided 日期在证据中自洽——" aspirational GRADUATE rows" 被 CI 拒绝 |
| gone 终态 | 同上 + 两套 resolver | 墓碑必须 default false；复活被可观察拒绝（warning）；census 不得有 gone 条目 |
| 注册 flag 校验器 | `validateFeatureFlagRaw` + contract test | id/category/enabled/since 类型级校验；PRI-571/621 毕业默认值被测试锁定 |
| installer↔registry 反漂移 | `installer-config-parity.test.ts` + sparse bootstrap 测试 | installer 禁止物化 default-equivalent entry（PRI-645 收敛后，**flag 删除不再牵连 installer**——历史 hazard 已消除） |
| registry↔surface 对账 | correction-observer-registry.test、mvp-surface-registry-guard.test | surface registry 与 flag 墓碑状态对账（PRI-752 已同步） |
| unknown flag 告警 | 两套 resolver | 配置里的死键/错键可观察（rc-9），不静默 |

**只是文档（无机器效力，已发现漂移）：**

| 机制 | 漂移证据（本次核验） |
|---|---|
| census doc（`docs/process/feature-flag-lifecycle-census.md`）的决策汇总表 | 已滞后于 TS registry：`release_manager_shadow` 文档仍写 STAGED，registry 已 GRADUATE（2026-09-07）；GRADUATE 计数 5≠8 |
| `lifecycle.ts` 头部与测试注释引用 `docs/governance/feature-flag-lifecycle-census.md` | **该路径不存在**（实际在 `docs/process/`）——死引用 ×2 |
| governance doc 的 consumer 地图 | 人工复核产物（最近一次 2026-08-24 + 09-12 修订），无机制保证持续为真 |
| census doc 的"时间触发复审" | 无调度器/无 issue 生成器，纯文字 |

**结构性盲区（现有测试不覆盖）：**

1. **consumer 真实性**：`consumers` 字段是字符串数组，测试只查"非空"，从不比对真实引用——三个历史失败案例全部从这里漏过。
2. **core flag 无生命周期记录义务**：census 只管 quiet。core 由 Owner 审批兜底（AGENTS §5），尚可接受，但"以 core 名义新注册却无消费者"同样无检测。
3. **终态程序未明文化**：墓碑 vs 物理删除的选择规则不存在，导致三次退役靠评审轮纠正（§2 案例三）。
4. **resolver 双实现**：语义分支两处维护，已实际发生"修复必须改两处"。

---

## 2. Problem（为什么会腐化——三案例根因链）

### 2.1 `evolution_worker`：为什么残留？

worker 代码在 PRI-737（#1613/#1614）被删除，flag 及其全部配套（census "quarantined heartbeat" 条目、surface registry ×2、guard 测试断言）**有意留给"separate change"**（contract 注释自认），此后 6 周无人认领，直到 PRI-751 审计发现全仓零可执行消费者、PRI-752 执行退役。

根因：**删除 PR 的交付单元只有代码，flag 终态不是交付清单的一部分**；census 声称的消费者随代码删除而失效，但没有任何机制发现"census 指向的世界已经不存在"。

### 2.2 `empathy_observer`：为什么成为墓碑（安慰剂开关）？

注册时 census 声称 "openclaw-plugin observer wiring"——**该接线从未存在**（PRI-752 逐项复核：EmpathyObserver 类只有自测试调用；empathy 检测经 signal-collector-host 无条件运行；Console 成本提示挂在 agent 绑定上）。live 配置 `enabled:true` 长期指向一个零读者的开关。

根因：**flag 注册与接线解耦且无检测**；census 的 consumers 是从不被核验的散文；显示层（标签/CostHint）与能力控制面混淆，使"看起来有消费"。

### 2.3 `painEvidenceAdmission`：为什么出现无效 kill switch？

生于 PRI-404，描述承诺"OFF 回滚 Gate A"；PRI-454 把 admission 统一进无条件 Gate B、归档 Gate A（零运行时调用方）——**flag 承诺的回滚主体被后续重构删除，脱钩持续约 3 个月无人发现**，直到 PRI-651-B1 特征测试证明钩子不读该 flag、PRI-751 定性 placebo、PRI-763 走 SPEC 后退役删除。

根因：**重构删除了 flag 的语义主体，但"flag 仍有注册+描述承诺"这一事实没有任何护栏看守**——这是三案例中最锋利的一类：腐化不是没人删，而是**没人知道它已经死了**。

### 2.4 共同原因（腐化机制）

1. **consumer 声明与可执行现实脱钩**，且无机器校验（三案例共同根因）；
2. **注册与接线允许解耦**（STAGED 机制存在但仅 release_manager_shadow 正确用过一次；其余"先注册后接线"直接变成永久休眠）；
3. **删除/重构 PR 的交付单元不含 flag 终态**，残留靠人肉审计战役回收（每次都是 PRI-749/751/752/760 这类专项）;
4. **终态程序无成文规则**——墓碑还是物理删除，由评审临时决定（三次退役均出现 review fix commit）；
5. **无 owner、无过期、无复审调度**——腐化只能靠阶段性审计战役暴露，成本高且滞后；
6. **派生文档（census doc 决策表、governance consumer 地图）无强制同步**，已实际漂移；
7. **resolver 双实现**放大语义漂移面。

---

## 3. Design Principles（最低成本防腐）

> 目标不是零 flag、不是重流程，是**让"flag 已死"这件事不可能无人知晓**。

1. **Flag is temporary by default**：每个注册自带退出条件（quiet 已由 census 强制；把"同一 PR 内交付 consumer 或显式 STAGED"升级为硬门）。
2. **No flag without wiring**：注册 PR 必须包含生产消费者，或 census STAGED 行点名路线图 issue。禁止"先占名后接线"。
3. **One authority, everything derived**：`feature-flag-contract.ts` + `QUIET_FLAG_LIFECYCLE` 是唯一权威；census doc/governance doc/矩阵是派生品，派生品**不得承载会被引用的决策汇总表**（漂移实证：census doc 决策表已滞后）。
4. **Removal is part of feature delivery**：退役是一个 PR 单元（flag 终态 + census 行 + surface + 标签 + 测试）；终态形式按成文规则选择（§4.3），不再靠评审即兴。
5. **Behavior changes need the Owner**：给休眠 flag 接线、删除有消费者 flag，都是行为变更 → Owner 决策（gfi/pain 先例）。AI 只执行已授权的退役。
6. **Convention before schema（P7）**：owner/issue 先用 evidence 字符串约定（可正则校验），**不建议现在扩 contract schema**——待约定失效再议。
7. **不新建子系统**：所有增强都是对既有 census 测试/文档的小扩展（Connection Before Creation）。

---

## 4. Lifecycle Model

### 4.1 与代码现实对齐的状态机

对任务书建议的 `PROPOSED→EXPERIMENT→ACTIVE→DEPRECATED→REMOVED` 的**现实修正版**（不新造运行时状态——每个阶段都映射到既有机制）：

```
P0 PROPOSED            Owner 批准的 Linear issue（MVP 四问已答；进 MVP-Core 须 Owner 显式批准）
    ↓ 注册 PR
S1 EXPERIMENT          quiet + default OFF + census(KEEP_QUIET|STAGED) + 同 PR 生产消费者
    ↓ 毕业 PR（默认翻转，测试锁定 GRADUATE 已执行证据）
S2 ACTIVE              default ON（quiet 毕业态或 core）
    ↓ 退役决策（Owner 授权 / SPEC）
S3 RETIRED-DECIDED     census 决策改 RETIRE（evidence 记退役 PR 链接）──【 today 隐式存在，本 SPEC 显式化 】
    ↓ 退役 PR（单一交付单元）
T1 GONE-TOMBSTONE 或 T2 DELETED（选择规则见 §4.3；墓碑建议限时，见 §4.4）
```

**关键修正**（相对任务书建议模型）：

- **DEPRECATED 不是 config category**。`legacy_retire` 分类虽存在于 `VALID_CATEGORIES`，但零使用且被测试钉死为 0，与 census `RETIRE` 决策语义重复。建议：**保持退役路径为"quiet + census RETIRE"**（已实践、已强制），并在未来的 contract 清理 PR 中**移除 `legacy_retire` 词汇**（减概念，AGENTS §30）。不建议"启用 legacy_retire"——那需要松测试钉 + 新语义定义，收益为零。
- **EXPERIMENT→ACTIVE 的转换就是默认值翻转**，无独立运行时状态；门禁已存在（GRADUATE 反注水测试），无需新建。
- **REMOVED 有两种合法终态**，这是现实已存在而文档未承认的事实（§4.3）。

### 4.2 各阶段状态变更义务

| 阶段转换 | 义务（全部落在既有文件/流程） |
|---|---|
| P0→S1 注册 PR | ① contract 加条目（id/category/enabled=false/since/description）；② census 加行（Purpose/Default/Rollback/Graduation/Retirement/Exit + **evidence 含 PRI issue 号**）；③ 同 PR 生产消费者或 STAGED 点名路线图 issue；④ contract+census 测试绿；⑤ 命名 camelCase（host 适配器 `host.*`），禁止新 snake_case；alias 仅可指向已注册 canonical ID |
| S1→S2 毕业 PR | census 决策改 GRADUATE + 已执行证据（含日期）+ 默认值翻转；Owner 决策记录（commit message/issue） |
| S2/S1→S3 退役决策 | Owner 授权（波次或单项）；census 决策改 RETIRE，evidence 记授权来源与退役 PR 计划 |
| S3→T 退役 PR | ① contract：翻 gone 墓碑 **或** 物理删除（§4.3 规则）；② census 行同 PR 移除（孤儿行测试强制）；③ surface registry + guard 测试同 PR；④ 显示层引用处置（enum-labels 仅在兼作他历时可留——empathy 标签先例）；⑤ verify:merge 绿；⑥ 若曾有真实消费者：门控分支代码同 PR 移除或显式保留理由 |

### 4.3 终态选择规则（墓碑 vs 物理删除——本 SPEC 新增的成文规则）

从三个案例的实践中提炼（现状是评审即兴，三次两样）：

- **默认 = GONE 墓碑**：凡该 ID 曾随发布版本存在于注册表（可能残留于任何 workspace 的 config.yaml），墓碑保证存量 `enabled:true` 覆盖被**可观察拒绝**（而非 unknown 告警），并阻断同 ID 复注册的语义混淆。
- **物理删除仅当**：该 flag 从无可执行消费者（纯元数据腐化，如 painEvidenceAdmission）——删除只是注册表卫生，不存在任何行为面，存量配置键走 unknown-flag 告警即可（rc-9 已可观察）。
- 两套 resolver 的 gone 分支已处理 legacy 配置形态（PRI-752 修复：存量 `{category:'quiet'}` 形态不改变墓碑判定）——墓碑路径的实现安全性已被评审验证。

### 4.4 墓碑限时（time-box）

墓碑是**带时间窗的终态**：默认保留 ≥2 个发布周期（或 90 天）供存量配置暴露与复审；此后可由卫生 PR 移除墓碑行（empathy 先例：显示层如兼作他用则保留显示层）。**时间触发仅是 review trigger**，延续 census doc 既有立场，不做自动删除。现存最老候选：`nocturnal` / `idle_trigger`（2026-05-24 至今）。

---

## 5. Required Metadata

**现有强制元数据（不变）**：contract——`id / category / enabled / since / description`；census——`decision / consumers[] / evidence / decided / graduationCriteria / retirementCriteria`。

**本 SPEC 新增的约定（零 schema 变更，测试可正则校验）：**

| 约定 | 落点 | 校验方式 |
|---|---|---|
| evidence 必须含 Linear issue 号（`PRI-\d+`） | census `evidence` 字符串 | lifecycle test 加一条正则断言（Phase 2 PR） |
| consumers 必须是真实存在的 src 路径（glob 可解析） | census `consumers` | consumer-reality 检查（§6 A1） |
| 退役 PR 落地后 evidence 追加退役 PR 链接 | census（RETIRE 行保留至删除 PR 为止的窗口内） | PR 评审检查单 |

**明确不建议现在做（P7）**：给 contract 加 `owner` 字段、`expiry` 字段、`removalPlan` 字段。owner 职责已由"issue assignee + census evidence"承载；expiry 与 census 时间触发复审立场冲突；removalPlan 与 retirementCriteria 重复。若一个季度后约定失效率高，再以独立 contract PR 重议。

---

## 6. Automation Opportunities

### A1（推荐，Phase 2 落地）：consumer-reality 检查 —— 扩展既有 census 测试

在 `feature-flag-lifecycle.test.ts` 内新增（**不新建工具/子系统**）：

1. **僵尸检测（Q3 答案）**：对每个 quiet flag，在 `packages/*/src`（排除注册表/census/测试/enum-labels 等显示层与注释语境）中至少命中一处**可执行读取模式**（`isFeatureEnabled(…,'id')`、flags map 取值、`loadFeatureFlagFromConfig(…,'id')`、或所在文件 import 任一 resolver 模块）；例外：census 决策为 STAGED（须点名路线图 issue）。
2. **consumers 路径真实性**：census.consumers 的每个 glob 至少解析到一个真实文件。
3. **墓碑必须保持死亡**：对每个 gone flag 断言零可执行读取——防止退役 flag 在后续重构中被"无意复活接线"。

成本：一个测试文件的扩展 + 显示层豁免清单维护；误报风险（如 `prompt` 子串）用"引号内完整 ID + resolver 导入"模式消除。收益：机械拦截三个历史失败类别（注册未接线 / 重构致孤 / 墓碑复活）。

### A2（Phase 1，文档 PR）：派生品去漂移

- 修复 `lifecycle.ts` 头部与测试注释的死路径引用（`docs/governance/`→`docs/process/`，2 处注释）；
- census doc **删除决策汇总表**（已漂移的部分），保留可复现方法 + new-flag rule + 本 SPEC 的终态规则，并加"决策状态以 TS registry 为准"横幅——派生品只讲方法，不复制状态。

### A3（可选，Owner 定节奏）：周期复审

以 census doc 既有"可复现 census 方法"为操作手册，按固定周期（建议季度）开 Linear 复审任务重跑方法。**不建议**为此新建 CLI/CI 扫描器（违反 P7/无新 framework 约束）；A1 已把最高价值的检测前移到每个 PR。

### A4（否决备案）：独立 flag 扫描工具 / 新 framework

显式否决：现有 contract+census 测试已是 CI 门，A1 扩展其覆盖即可；独立工具引入第二套真相与维护面，正是本 SPEC 要消除的模式。

### Q5（CI 是否阻止无治理新增 flag）——答案：已经是，且应加强

现状：无 census 条目的 quiet flag **已经**无法通过 CI（双向测试）。缺口只在 consumer 真实性与墓碑纯度（A1 补齐）。成本收益：基础设施全部现成，增量是一个测试文件的扩展，边际成本低；收益是把三案例的事后审计战役（每次数天）变为 PR 级即时失败。**净收益明确为正。**

---

## 7. Migration Plan（建议实施阶段；全部需 Owner 批准后另立 PR）

| 阶段 | 内容 | PR 规模 | 行为变更 |
|---|---|---|---|
| **M1 文档采纳**（本 SPEC 交付即含） | SPEC 落盘 docs/specs/；A2 两处死路径修复 + census doc 去漂移 | 小（doc+注释） | 无 |
| **M2 测试扩展** | A1 三项检查进 `feature-flag-lifecycle.test.ts` + 豁免清单 | 小（单测试文件） | 无（纯测试） |
| **M3 词汇与墓碑卫生** | ① `legacy_retire` 从 VALID_CATEGORIES 移除（contract 清理 PR，连带松测试钉）；② nocturnal/idle_trigger 墓碑限时复审 | 小 | 无运行时行为变化（词汇无消费者） |
| **M4 约定复审**（仅当失效率高） | 再议 contract schema 增长（owner/expiry） | — | — |

依赖关系：M2/M3 相互独立；M4 默认不做。AGENTS.md §16 交叉引用本 SPEC 属 Owner 审批项（CODEOWNERS），可随 M1 由 Owner 顺手采纳。

---

## 附录 A：任务书 Q1–Q5 直答

- **Q1 何时允许新增 flag**：Owner 批准 issue + MVP 四问（§16）+ 同 PR（registry+census+消费者或 STAGED+测试）+ camelCase 命名。进 MVP-Core 另须 Owner 显式批准（§5）。
- **Q2 生命周期**：§4.1 七阶段现实修正版——不采用建议模型原名照搬；DEPRECATED 以 census RETIRE 承载而非新 category；REMOVED 双终态成文化。
- **Q3 僵尸检测**：§6 A1-1（definition 存在 + 零可执行消费者 → CI fail；STAGED 豁免）。
- **Q4 删除安全条件**：①零可执行消费者（或消费分支同 PR 移除并 Owner 批准）；②census 行同 PR 清（测试强制）；③终态形式按 §4.3 规则选择；④surface+guard 测试同 PR；⑤installer 无牵连（PRI-645 后已结构性保证）；⑥显示层引用逐个处置；⑦存量 config 残留走可观察告警路径（已验证）。
- **Q5 CI 门**：已存在（quiet 双向测试）；建议按 A1 加强；成本收益为正（§6 Q5）。

## 附录 B：Owner 四问直答（Success Criteria）

1. **现在有哪些 flag？** 45 个：core 9 / quiet 31 / gone 5（基线 `49814cddd`），另有 `legacy_retire` 空词汇 1 组、live 未注册键 2 枚（`model_training`/`trainer`，卫生事项）。
2. **哪些真正运行中？** 25 个 ACTIVE（9 core + 16 quiet 默认 ON，全部有可执行消费者）；15 个 EXPERIMENT（默认 OFF 但已接线，等毕业或退役决策）；1 个 COMPATIBILITY（`diagnostician_split_pipeline`，删前须先移 shim 依赖——需 Owner 立单）。无 DEAD。
3. **哪些可以删除？** 当前无零消费者 DEAD flag（5 个已于 09-12 处置）。可删候选均为后续 Owner 决策项：①两枚最老墓碑 nocturnal/idle_trigger（限时已到）；②`legacy_retire` 空词汇；③live 未注册键清理。**本 SPEC 不执行任何删除。**
4. **未来新增如何避免成为垃圾？** §4.2 注册 PR 义务（同 PR 接线/STAGED + evidence 带 issue 号）+ §6 A1 CI 僵尸/复活检测 + §4.3/4.4 成文终态与限时墓碑——把"腐化暴露"从季度审计战役前移到 PR 即时失败。

## 附录 C：证据与复核声明

- 一手读取（`49814cddd`）：feature-flag-contract.ts、feature-flag-lifecycle.ts、feature-flag-lifecycle.test.ts、feature-flag-contract.test.ts（结构+毕业锁）、pd-config-feature-flags.ts、pd-config-defaults.ts（派生关系）、surface-guard-policy.ts、plugin-surface-registry.ts、docs/architecture/feature-flag-governance.md、docs/process/feature-flag-lifecycle-census.md。
- 全量扫描：45 flag 非注册表 src 引用计数；3 退役 flag 残留引用定性（全部显示层/注释）。
- 抽查复核（file:line 级）：release_manager_shadow、signal_collector、artificer_output_retry（测试锁）、evolution_worker/empathy_observer/internalization_core_grounding 残留、painEvidenceAdmission 删除 commit（`c546d2def`）、毕业 commit（`a1f05a7a6`）、单 PR 诞生例（`a3a508f86`）。
- 未逐项复核的 consumer file:line 底本取自 PRI-751 矩阵（基线 `4dce7d942`，与本次基线间隔 4 commit，无 flag 接线变更），行内已标注 (751)。
