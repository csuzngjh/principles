# PRI-760 — Feature Flag Reality Matrix & Safe Flag Cleanup

> 原任务描述引用 **PRI-754** 编号，但 Linear 中 PRI-754 已被「建立 PD AI User QA 基础框架」（Done）占用；
> 本次审计另立 **PRI-760** 承载，登记于「PD 瘦身与架构收敛」专项（PRI-744）下。
> 前置：PRI-751 已完成 Flag Reality Matrix 首轮（其基线 tree `4dce7d942`）；本审计在最新
> `origin/main`（`ef71be063`，含 PRI-751/752 退役合并）上独立复核全部执行消费者，**不直接采信历史结论**。

- Baseline Commit: `ef71be063d75c6721e20fe8f25aec84c2e82e7d0`（origin/main，2026-09-12）
- Branch: `ai/PRI-760-flag-reality-matrix`
- Date: 2026-09-12
- 方法：逐 flag 静态/动态/runtime 执行消费者验证（基于 worktree 源码，事实优先级：Runtime 实际读取 > 生产代码消费者 > 配置 > 测试 > 文档 > 历史审计）

---

## 1. 结论摘要

- 注册 flag **47 个**（core 9 / quiet 36 / gone 2），单一 SSoT `feature-flag-contract.ts:DEFAULT_FEATURE_FLAGS`；
  `pd-config-defaults.ts` 的 registry 由 contract 派生（非第二真值，仅映射 category/enabled）。
- **ACTIVE：40**（含 `code_tool_hook`/`defer_archive`/`prompt` channel 三旗）；40 + DEAD 2 + GONE 5 = 47。
- **DEAD（零可执行消费者）2 个**：`painEvidenceAdmission`、`painEvidenceAdmissionDefault`
  （涉 pain pipeline = protected zone → 走 SPEC，不直接删码）。
- **GONE（墓碑）5 个**：`evolution_worker`、`internalization_core_grounding`、`empathy_observer`
  （PRI-751/752 已退役，当前 tree 为 gone）、`nocturnal`、`idle_trigger`（历史 MVP-Gone）。
  全部可执行消费者为零，仅保留"拒绝 stale 复活 override"的墓碑语义。
- **UNKNOWN：0**（全部有消费者证据或墓碑证据）。
- 与 PRI-751 文档的关键复核差异（本基线 tree 独立验证）：
  - `diagnostician_split_pipeline` —— **判定 ACTIVE（兼容行为）**，非死旗：
    `pd-config-effective.ts:200-219` 的 PRI-638 legacy-fold shim 是**主动行为**，对携带 legacy
    `enabled:false` 的存量 workspace 会改写 diagnostician agent 绑定（防升级静默激活 LLM 管线）；
    清理该 flag 会使这些 workspace 的管线被静默重新启用。PRI-751 已纠正过一次，本次复核一致。
  - `evolution_worker`/`internalization_core_grounding`/`empathy_observer` 在 PRI-751 基线仍为
    quiet 注册；**当前 tree 已合并 PR #1622/#1624/#1625 变为 gone 墓碑**，本次复核以此为准。
- live workspace（`D:\.openclaw\workspace\.pd\config.yaml`）采集：2026-09-12 只读，与 PRI-751 一致，
  未注册键 `model_training`/`trainer` 残留（配置卫生项，锁 Owner 决策，不在本任务动作）。

---

## 2. Feature Flag Matrix（47）

### 2.1 MVP-Core（9，默认 on）

| Flag | Default | Consumers（本 tree 可执行） | Runtime Effect | Status |
|---|---|---|---|---|
| prompt | on | host-runtime active-principle-prompt.ts；openclaw-plugin runtime-v2-prompt-activation-reader.ts:26 | 提示注入读取路径 | ACTIVE |
| code_tool_hook | on | pd-config-feature-flags.ts:109-115 → enabledChannels → runtime-internalization-queue/canary/features；⚠ host auto-consumer 硬编码腿（consumer-cycle.ts:337） | CLI 队列可执行性判定 + canary 结果（host 腿不受控） | ACTIVE（注：双消费腿分裂，收敛待 Owner） |
| defer_archive | on | 同 code_tool_hook（同一 enabledChannels 集合） | 同 code_tool_hook | ACTIVE |
| rulecode_safety_controls | on | rulecode-owner-decision-service.ts:94；pd-cli runtime-activation.ts:566；console ActivationsConsoleModel.ts:476 | RuleCode 安全隔离授权 | ACTIVE |
| rulecode_owner_live_decision | on | rulecode-owner-decision-service.ts:91；runtime-activation.ts:565；ActivationsConsoleModel.ts:531/670 | Owner live 决策授权 | ACTIVE |
| internalization_full_chain | on | host-runtime internalization-consumer-cycle.ts:351 | 全链 vs dreamer-only auto-consumer | ACTIVE |
| code_rule_capability | on | rulehost-readiness.ts:248 | RuleHost 管线开关 | ACTIVE |
| host.codex | on | codex-adapter pd-hook.ts:94、workspace-worker.ts:145、catch-up.ts:72、codex-worker-status.ts:51 | Codex 宿主适配总开关 | ACTIVE |
| new_user_onboarding | on | console App.tsx:142 | 首访引导 | ACTIVE |

### 2.2 Quiet（36）

| Flag | Default | Consumers（本 tree 可执行） | Runtime Effect | Status |
|---|---|---|---|---|
| internalization_auto_consumer | on | plugin index.ts:127 + service:130；host-runtime consumer-cycle | auto-consumer 启动 | ACTIVE |
| story_a_approval_completion | on | ApprovalsConsoleModel.ts:356 | 审批完成编排器 | ACTIVE |
| feedback_channel | on | console index.ts:267；feedback-reports.ts:157/215/282 | 反馈面（off=403+隐藏） | ACTIVE |
| release_manager_shadow | on | routes/update.ts:2013 | /check 走 ReleaseManager 治理 | ACTIVE |
| release_manager_write_authority | on | routes/update.ts:2026 | /apply-full 写权威（有效性依赖 PD_RELEASE_METADATA_URL） | ACTIVE（风险注记） |
| **painEvidenceAdmission** | on | ❌ 零可执行读取（gate-b-only-runtime-guard / pain-emission-characterization 锁定 hooks 不读；Gate A zero importers；PRI-651-B1 已摘除） | 无 | **DEAD → SPEC** |
| **painEvidenceAdmissionDefault** | on | ❌ 同上；"OFF 回滚 Gate A" 契约无接线 | 无 | **DEAD → SPEC** |
| diagnostician_core_grounding | on | diag-rootcause-runner.ts:174；diag-distiller-runner.ts:176 | 诊断 prompt 锚定 | ACTIVE |
| diagnostician_split_pipeline | on | pd-config-effective.ts:200-219（PRI-638 legacy-fold shim，改写 agent 绑定） | **主动兼容行为**：legacy workspace `enabled:false` → 禁用 diagnostician 绑定；清理会使管线被静默重新启用 | ACTIVE（兼容行为） |
| diagnostician_llm_degradation | on | base-peer-runner.ts:1012 | rate-limit 优雅降级 vs 硬失败 | ACTIVE |
| l2_dreamer | off | host-runtime consumer-cycle.ts:449；pd-cli runtime-adapter-resolver.ts:277 | dreamer L2 多轮循环 | ACTIVE |
| failed_tasks_observability | on | console index.ts:268；routes/failed-tasks.ts；sidebar:137 | 失败任务面（off=403） | ACTIVE |
| evaluator_artificer_repair_loop | on | rulehost-pipeline-runner.ts:693；consumer-governance.ts:160 | needs_revision→artificer 修复环 | ACTIVE |
| artificer_output_retry | on | artificer-runner.ts:652-653 | output_invalid 重试 vs 永久失败 | ACTIVE |
| artifact_summary_redundancy | off | base-peer-runner.ts:1026；context-trace | progressive disclosure L0 | ACTIVE |
| context_manifest_budget | off | base-peer-runner.ts:1145；context-manifests.ts | L1 manifest 预算注入 | ACTIVE |
| progressive_evaluator | off | base-peer-runner.ts:1156；evaluator-runner.ts:566 | L2 两段评估 | ACTIVE |
| abstraction_layer_v1 | off | plugin index.ts:145 | shared host-runtime vs legacy 路由（默认 off=legacy） | ACTIVE |
| principle_receipt_block_copy | on | gate-block-helper.ts:283 | 阻断文案富化 | ACTIVE |
| principle_receipt_ledger | on | gate.ts:172/341/633；prompt.ts:695 | receipt 台账写入 | ACTIVE |
| principle_receipt_self_report | off | prompt.ts:769；principle-application-ledger.ts:211 | 📌 自报捕获 | ACTIVE |
| principle_governance_projection_v2 | on | console index.ts:269 | 治理投影视图 | ACTIVE |
| failed_task_recovery_console | on | console index.ts:272；FailedTasksPage | Console 恢复动作 | ACTIVE |
| governance_experience_v1 | on | console index.ts:275；routes/governance.ts:76；FocusPage:935 | 治理体验快照 | ACTIVE |
| **internalization_core_grounding** | on→gone | ❌ 零可执行读取（runner 硬编码 `coreGrounding: true`） | 无 | **GONE 墓碑**（PRI-751 PR #1624 已退役） |
| pain_diagnosis_persistence | off | pain-signal-runtime-factory.ts:781；diag-rootcause-runner.ts:176 | 根因归因持久化 | ACTIVE |
| anonymous_product_telemetry | off | host-runtime product-telemetry/service.ts:330；pd-cli telemetry.ts | 匿名遥测导出（flag+consent+eligibility） | ACTIVE |
| codex_conversation_ingestion | off | codex-adapter pd-hook.ts:97、catch-up.ts:75 | Codex 会话摄取（off=零 transcript 读） | ACTIVE |
| correction_observer | off | plugin index.ts:103 | LLM 关键词优化服务启动 | ACTIVE |
| signal_collector | off | signal-collector-host.ts:424（resolveObserverConfig） | LLM 深判断路径 | ACTIVE |
| **empathy_observer** | off→gone | ❌ 零可执行读取（真实控制面=internalAgents agent 绑定） | 无 | **GONE 墓碑**（PRI-751 PR #1625 已退役） |
| **evolution_worker** | off→gone | ❌ 零可执行读取（worker 已删） | 无 | **GONE 墓碑**（PRI-752 已退役） |
| gfi | off | runtime-canary.ts:156；CLI `runtime gfi` | canary 探针门控（评分本身无条件运行） | ACTIVE（窄） |
| diagnostician_async_cli | off | pain-record.ts:354 | 异步诊断提交 | ACTIVE |
| intent_engineering | off | prompt.ts:727；intent-doc-reader.ts:171；diag-rootcause-runner.ts:175 | INTENT 锚定/意图张力 | ACTIVE |
| rulecode_context_v2 | off | gate.ts:518-523；rule-host-writer.ts:217 | RuleContext v2 上下文 | ACTIVE |

### 2.3 Gone（2，墓碑）

| Flag | Default | Consumers | Runtime Effect | Status |
|---|---|---|---|---|
| nocturnal | gone/off | 无行为消费者（dev 脚本除外）；computeEffectiveFlags 拒绝复活+告警 | 配置复活拒绝 | INACTIVE-BUT-VALID（墓碑） |
| idle_trigger | gone/off | 同 nocturnal（proven-channel-baseline.ts:141 仅 legacy 文本探测关键词） | 配置复活拒绝 | INACTIVE-BUT-VALID（墓碑） |

---

## 3. 分类汇总

- ACTIVE：41（`diagnostician_split_pipeline` 因 legacy-fold 主动兼容行为归 ACTIVE，非 DEAD）
- GONE 墓碑（已退役，保留复活拒绝）：`evolution_worker` / `internalization_core_grounding` / `empathy_observer` / `nocturnal` / `idle_trigger` = 5
- DEAD → SPEC（protected zone）：`painEvidenceAdmission` / `painEvidenceAdmissionDefault` = 2
- UNKNOWN：0

## 4. Lifecycle census 陈旧项（P4 修正）

`feature-flag-lifecycle.ts` 中两条 entry 的 `consumers` 与当前 hook 代码不符，需随 SPEC/退役同步修正：

- `painEvidenceAdmission` / `painEvidenceAdmissionDefault`：census 声称消费者
  `openclaw-plugin/src/hooks/pain.ts / llm.ts / gate-block-helper.ts` —— 实际 hooks 显式不再加载
  （PRI-651-B1 特征测试锁定）。census 待 SPEC 落地后更新。
- `diagnostician_split_pipeline` census 消费者字段标注为 diagnose.ts/pain-retry.ts —— 其执行消费为
  legacy-fold shim，建议修正 consumers 字段以反映 `pd-config-effective.ts`。

## 5. 后续动作（不本任务执行）

- **SPEC**：`painEvidenceAdmission(+Default)` 删除/退役选项（涉 pain pipeline protected zone；
  既有 SPEC：`docs/specs/pain-admission-flag-contract-fix.md` 待 Owner 决策 A/B/C）。
- **配置卫生**（Owner 侧）：live config 未注册键 `model_training` / `trainer`；
  `code_rule_capability.category: quiet` 漂移（注册表 core 为准，无行为影响）。
- **防膨胀 SPEC 候选**：Feature Flag Lifecycle Governance（owner / created reason / expiry /
  consumer requirement）——注册时强制"有真实执行消费者"机器检查（仿 QUIET_FLAG_LIFECYCLE census
  契约测试），本任务不实现。

## 6. Protected Zone

本审计为只读，未修改任何代码。无 Learning Loop / Runtime Governance / Data Layer 变更。
`painEvidenceAdmission` 相关 admission 已由 Gate B（TriggerController）无条件接管（pain.ts:559-604），
flag 处置不触碰 Gate B 代码路径。

## 7. 交付物

- Feature Flag Matrix（见 §2）
- Active Flags：41
- Valid Inactive：2 墓碑（nocturnal/idle_trigger）
- Dead Flag Candidates：2（painEvidenceAdmission*，走 SPEC）
- PR List：无（本任务零代码变更；退役已于 PRI-751/752 完成）
- Linear：PRI-760 中文更新