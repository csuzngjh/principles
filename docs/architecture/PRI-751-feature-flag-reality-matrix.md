# PRI-751 — Feature Flag Reality Matrix

> 日期：2026-09-12 · 基线：`origin/main` `4dce7d942f00039113b698de2a5b27025b9a3fa6`
> 性质：只读审计产出 + 收敛执行记录。事实优先级：Runtime 实际读取 > 生产代码消费者 > 当前配置 > Live workspace > 测试 > 文档 > 历史报告。
> 前置线索（PRI-749 Phase 0 报告、PRI-731/736/737 审计、Linear 描述）均**重新验证**后才采信；验证中推翻/修正线索的处以「⚠ 修正」标注。
> 配套 SPEC（protected zone）：`docs/specs/pain-admission-flag-contract-fix.md`。

---

## 1. 结论摘要

- 注册 flag 47 个（core 9 / quiet 36 / gone 2），单一 SSoT（`feature-flag-contract.ts`，quiet 生命周期 census 由 contract test 强制双向覆盖）。
- **DEAD（零可执行消费者）5 个**：`evolution_worker`、`internalization_core_grounding`、`empathy_observer`（退役由独立 PR #1622/#1624/#1625 执行，**截至本基线树 `4dce7d942` 三项仍处于注册表，合并前本文档的矩阵快照与实现存在已知时差**）；`painEvidenceAdmission`、`painEvidenceAdmissionDefault`（涉 pain pipeline=protected zone → SPEC 待决策）。
- **channel 双 flag 改判 ACTIVE**（评审修正）：`code_tool_hook`、`defer_archive` 经 `pd-config-feature-flags.ts:109-115` 计算 `enabledChannels`，被 `pd runtime internalization queue`（runtime-internalization-queue.ts:108/111）、`pd runtime canary`（runtime-canary.ts:226-227）、`pd runtime features`（runtime-features.ts:68）消费——显式关闭会改变任务可执行性判定与 canary 结果。host auto-consumer 侧硬编码 channels（internalization-consumer-cycle.ts:337）构成**同一 flag 的双消费腿**。
- 其余 40 个 ACTIVE（含 `diagnostician_split_pipeline`——评审修正：其 PRI-638 兼容折叠是**主动行为**，会改写 diagnostician agent 绑定；`diagnostician_llm_degradation` live 被 Owner 关闭、`release_manager_write_authority` 有效性依赖环境变量——均已在备注注明）。
- **INACTIVE-BUT-VALID 2 个**：`nocturnal`、`idle_trigger`（gone 墓碑）。
- 注册表外残留：live config 的 `model_training`/`trainer` 两个未注册键（每次加载产生 unknown-flag 告警，属 workspace 配置卫生，按 §18 走 Owner 决策，不在本系列处理）。
- 环境变量门控行为（`PD_RELEASE_METADATA_URL` 等）不属于 flag 注册体系，单列 §5。

## 2. Flag Matrix（47）

Status 词汇：`ACTIVE`（真实改变行为）/ `INACTIVE-BUT-VALID`（代码完整、合法休眠）/ `DEAD`（注册存在+全仓无消费者+无 runtime effect+无迁移需要）/ `UNKNOWN`（证据不足）。
Consumers 列只列**可执行门控点**（file:line）；"元数据"指注册表/census/标签/注释自指。
"live" 列 = live workspace `D:\.openclaw\workspace\.pd\config.yaml`（2026-09-12 只读采集）。

### 2.1 MVP-Core（9，默认 on）

| Flag | Default | live | Consumers（可执行） | Runtime Effect | Status |
|---|---|---|---|---|---|
| prompt | on | on | active-principle-prompt.ts:42；runtime-v2-prompt-activation-reader.ts:26 | 控制提示注入读取路径 | ACTIVE |
| code_tool_hook | on | on | pd-config-feature-flags.ts:109-115 → enabledChannels → runtime-internalization-queue.ts:108/111、runtime-canary.ts:226-227、runtime-features.ts:68；⚠ host auto-consumer 腿为硬编码（consumer-cycle:337） | CLI 队列任务可执行性判定 + canary 检查结果随 flag 变化（host 腿不受控——双消费腿分裂，收敛待 Owner） | ACTIVE |
| defer_archive | on | on | 同 code_tool_hook（同一 enabledChannels 集合） | 同 code_tool_hook | ACTIVE |
| rulecode_safety_controls | on | on | runtime-activation.ts:566/597；ActivationsConsoleModel.ts:476/625 | RuleCode 安全隔离授权 | ACTIVE |
| rulecode_owner_live_decision | on | on | runtime-activation.ts:565；ActivationsConsoleModel.ts:531/670（670 强制门） | Owner live 决策授权 | ACTIVE |
| internalization_full_chain | on | on | internalization-consumer-cycle.ts | 全链 auto-consumer 推进 vs dreamer-only | ACTIVE |
| code_rule_capability | on | on | rulehost-readiness.ts:248；run-rulehost.ts:191 | RuleHost 管线开关（⚠ live 类别写成 quiet，注册表 core 为准） | ACTIVE |
| host.codex | on | on | pd-hook.ts；codex-setup.ts:335；health-codex.ts:318；workspace-worker/catch-up/codex-worker-status | Codex 宿主适配总开关（⚠ live on 但 Codex 集成本机未安装→不可达） | ACTIVE |
| new_user_onboarding | on | on | console App.tsx:142；routes/onboarding.ts:72 | 首访引导 | ACTIVE |

### 2.2 Quiet（36）

| Flag | Default | live | Consumers（可执行） | Runtime Effect | Status |
|---|---|---|---|---|---|
| internalization_auto_consumer | on | on | plugin index（shouldStart*）；codex workspace-worker | auto-consumer 启动 | ACTIVE |
| story_a_approval_completion | on | on | ApprovalsConsoleModel.ts:356 | 审批完成编排器 vs 手动 dispatch | ACTIVE |
| feedback_channel | on | on | routes/feedback-reports.ts | 反馈面（off=403+隐藏） | ACTIVE |
| release_manager_shadow | on | on | routes/update.ts:2013 | /check 走 ReleaseManager 治理 | ACTIVE |
| release_manager_write_authority | on | on | routes/update.ts:2026 | /apply-full 写权威（⚠ 有效性依赖 PD_RELEASE_METADATA_URL + artifact target；pre-transaction 回退 legacy） | ACTIVE（风险注记） |
| **painEvidenceAdmission** | on | on | ⚠ 零可执行读取（PRI-651-B1 已摘除；引用全为元数据/注释/文案） | 无 | **DEAD → SPEC** |
| **painEvidenceAdmissionDefault** | on | on | ⚠ 同上；"OFF 回滚 Gate A" 契约无接线 | 无 | **DEAD → SPEC** |
| diagnostician_core_grounding | on | on | diag-rootcause-runner.ts:174；diag-distiller-runner.ts:176 | 诊断 prompt 锚定 | ACTIVE |
| diagnostician_split_pipeline | on | on | pd-config-effective.ts:194-203（legacy-fold shim；PRI-638 后不再选管线）；配套 pd-config-store.ts:484-497 须先移除该覆盖 Console 才能持久化 enable | **主动兼容行为**：对携带 legacy `enabled:false` 的存量 workspace 会主动禁用 diagnostician agent 绑定（防升级静默激活 LLM 管线）——不是休眠开关，清理它会使这些 workspace 的管线被静默重新启用 | ACTIVE（兼容行为） |
| diagnostician_llm_degradation | on | **off** ⚠ | base-peer-runner.ts:1012 | rate-limit 优雅降级 vs 硬失败（live 走 legacy 硬失败，需 Owner 复核） | ACTIVE |
| l2_dreamer | off | off | runtime-adapter-resolver.ts；consumer-cycle | dreamer L2 多轮循环 | ACTIVE |
| failed_tasks_observability | on | on | routes/failed-tasks.ts | 失败任务面（off=403） | ACTIVE |
| evaluator_artificer_repair_loop | on | on | rulehost-pipeline-runner.ts:693；consumer-governance.ts:160 | needs_revision→artificer 修复环 | ACTIVE |
| artificer_output_retry | on | on | artificer-runner.ts:653 | output_invalid 重试 vs 永久失败 | ACTIVE |
| artifact_summary_redundancy | off | off ⚠ | base-peer-runner.ts:1026；context-trace | progressive disclosure L0（⚠ closure profile 开了 L1+L2 留 L0 关） | ACTIVE |
| context_manifest_budget | off | **on** | base-peer-runner.ts:1145；context-trace | L1 manifest 预算注入 | ACTIVE |
| progressive_evaluator | off | **on** | base-peer-runner.ts:1156；context-trace | L2 两段评估 | ACTIVE |
| abstraction_layer_v1 | off | off | plugin index（shouldUseSharedHostRuntime，进程级缓存） | shared host-runtime vs legacy 路由（**默认 off=生产走 legacy 路由**） | ACTIVE |
| principle_receipt_block_copy | on | **off** ⚠ | gate-block-helper.ts | 阻断文案富化（live 用 generic 模板） | ACTIVE |
| principle_receipt_ledger | on | on | gate.ts/prompt.ts；milestone-readers.ts | receipt 台账写入（live 185 行实证） | ACTIVE |
| principle_receipt_self_report | off | **on** | prompt.ts；principle-application-ledger.ts | 📌 自报捕获（live 12 行实证） | ACTIVE |
| principle_governance_projection_v2 | on | on | routes/principles.ts:146；server/index.ts:269 | 治理投影视图 | ACTIVE |
| failed_task_recovery_console | on | on | server/index.ts；failed-tasks recover 端点 | Console 恢复动作（off=只读） | ACTIVE |
| governance_experience_v1 | on | on | routes/governance.ts:76；server/index.ts:275 | 治理体验快照 | ACTIVE |
| **internalization_core_grounding** | on | on | ⚠ 零可执行读取（dreamer/philosopher/scribe runner 硬编码 `coreGrounding: true`） | 无（能力无条件开启） | **DEAD → PR #1624** |
| pain_diagnosis_persistence | off | off | pain-signal-runtime-factory.ts:787；diag-rootcause-runner.ts:176 | 根因归因持久化（live off→pain_diagnoses 0 行） | ACTIVE |
| anonymous_product_telemetry | off | **on** | product-telemetry/service.ts；telemetry.ts | 匿名遥测导出（flag+consent+eligibility 三级门；live 09-11 导出成功） | ACTIVE |
| codex_conversation_ingestion | off | off | pd-hook/codex-setup/health-codex + governance-observation-store | Codex 会话摄取（off=零 transcript 读） | ACTIVE |
| correction_observer | off | **on** | plugin index（shouldStartCorrectionObserver） | LLM 关键词优化服务启动 | ACTIVE |
| signal_collector | off | **on** ⚠ | signal-collector-host.ts:424 | LLM 深判断路径（⚠ live flag on 但 `internalAgents.agents.signalCollector.enabled=false`——两开关相反，实际休眠） | ACTIVE |
| **empathy_observer** | off | **on** ⚠ | ⚠ 零可执行读取（唯一"消费"=Console 只读展示；真实控制面是 agent 绑定） | 无 | **DEAD → PR #1625** |
| **evolution_worker** | off | off | ⚠ 零可执行读取（worker 已于 PRI-737 删除；引用全为注册表/surface/标签自指） | 无 | **DEAD → PR #1622** |
| gfi | off | off | runtime-canary.ts:156；CLI `gfi` 命令 | canary 探针门控（⚠ 评分本身按 governance §3.1 无条件运行——既有 follow-up 工单） | ACTIVE（窄） |
| diagnostician_async_cli | off | off | pain-record.ts:354 | 异步诊断提交 | ACTIVE |
| intent_engineering | off | **on** | intent.ts:322；diag-rootcause-runner.ts:175；prompt.ts；intent-doc-reader | INTENT 锚定/意图张力（live intent_decisions 0 行=未触发过） | ACTIVE |
| rulecode_context_v2 | off | **on** | rule-host-writer.ts；run-rulehost.ts:172 | RuleContext v2 上下文 | ACTIVE |

### 2.3 Gone（2，墓碑）

| Flag | Default | Consumers | Runtime Effect | Status |
|---|---|---|---|---|
| nocturnal | gone/off | 无行为消费者（scripts/nocturnal 为 dev 脚本）；computeEffectiveFlags 拒绝复活+告警 | 配置复活拒绝 | INACTIVE-BUT-VALID（墓碑） |
| idle_trigger | gone/off | 同上（proven-channel-baseline.ts:141 仅 legacy 文本探测关键词） | 配置复活拒绝 | INACTIVE-BUT-VALID（墓碑） |

## 3. 收敛执行记录（每个 flag 一个小 PR；**截至本文基线树 `4dce7d942` 以下变更均处于 OPEN PR，未在本分支树内**）

| Flag | Before | Evidence（Definition/Consumer/Runtime） | Decision | Change | Verification |
|---|---|---|---|---|---|
| evolution_worker | quiet/off 注册、census 声称 "quarantined heartbeat"、surface-registry ×2、guard 测试断言存在 | 注册表项在；全仓零可执行消费者（worker 已删 PRI-737；PRI-737 审计预规划本删除；census 文档标注 RETIRE-ready "deletion is a separate PR"）；runtime effect 无 | C→退役（执行既定程序；评审后按 census 契约改为 **gone 墓碑**——存量 enabled 覆盖被可观察拒绝） | PR #1622：contract（gone 墓碑）+census+surface×2+labels+测试+文档 | core 508 + plugin 61 测试 PASS；verify:merge exit 0 |
| internalization_core_grounding | quiet/on 注册、census 声称 internaliz*/runner 消费者 | 注册表项在；三 runner `coreGrounding: true` 默认值无条件启用，flag ID 零读取；runtime effect 无 | C→退役（评审后改为 **gone 墓碑**） | PR #1624：contract（gone 墓碑）+census+labels+3 注释纠偏+测试+文档 | core 493 测试 PASS；verify:merge exit 0 |
| empathy_observer | quiet/off 注册（live on）、census 声称 "observer wiring"、governance §3.2 已知旧消费点废弃 | 注册表项在；零可执行读取；empathy 检测无条件运行；真实控制面=internalAgents 绑定；governance §3.2 预告 MVP-Gone 波次 | C→退役（Owner 任务即该波次授权；评审后改为 **gone 墓碑**） | PR #1625：contract（gone 墓碑）+census+ADR-0016 示例+governance §3.2 更新+测试 fixture 换元（含评审补抓的 diag-chain-e2e）；label 保留（agent 显示名，CostHint 测试锁定） | 508+58+35+17 测试 PASS；verify:merge exit 0 |
| painEvidenceAdmission(+Default) | quiet/on 注册、描述承诺"OFF 回滚 Gate A"、census 声称 production readers | 注册表项在；PRI-651-B1 特征测试锁定钩子**不读** flag；Gate A `@deprecated` 归档且零运行时调用方；alias 测试头注过期且自认 "silently dead kill switch"；runtime effect 无 | C→**SPEC**（涉 pain pipeline，protected zone 不直接改码） | `docs/specs/pain-admission-flag-contract-fix.md`（选项 A/B/C 待 Owner） | SPEC 附验证计划（pain 特征测试零改动为硬门） |

## 4. 配置面残留（注册表外，记录不动作）

- live config 未注册键：`model_training`、`trainer`——每次加载 "unknown flag ignored" 告警；属 workspace `.pd/config.yaml`（运行时状态，AGENTS §1.1 仅 installer/运行时可写），建议 Owner 择机手动清理或随配置卫生 PR。
- live config `code_rule_capability.category: quiet` 类别漂移——注册表 core 为准（F14-1），无行为影响。
- live config 同时含 `painEvidenceAdmissionDefault` 与别名 `pain_evidence_admission_default`（同值，PRI-609 归一化良性；SPEC 选项 A 落地后一并清理）。
- live workspace `.state/evolution_queue.json`、`evolution-scorecard.json`：无生产 writer（唯一 writer 是测试 fixture）——PRI-751 死数据范围，按 DATA_CLEANUP_GUIDELINES 归档，不在 flag PR 内。
- `pd errors` 的 legacy worker-status 段读取已无 writer 的 `worker-status.json`（writer 随 PRI-737 删除）——死数据候选，另行立单。

## 5. 环境变量门控行为（非 flag 体系，单列）

| 变量 | 影响 | 备注 |
|---|---|---|
| PD_RELEASE_METADATA_URL | ReleaseManager 实际接管 /check、/apply-full 的前提 | 缺省=逐请求显式回退 legacy（rc-9） |
| PD_RELEASE_SMOKE_PUBLICATION | 发布 smoke 免内部构建 | dev/release 工具链 |
| PD_DEV_WORKTREE_ALLOW_PRIMARY | 主 checkout 写禁令的人工应急阀 | 仅限人类，AI 禁设（git-3） |
| PD_WORKSPACE_DIR | dev 隔离 workspace | 防写穿 live |

## 6. 成功标准自检

> 不是减少 flag 数量，而是让每个 flag 都有明确现实含义。

- 47 个注册 flag 全部获得四态之一 + 可执行消费者证据 + runtime effect 描述；无 "UNKNOWN-但未注明原因" 项。
- 2 个 UNKNOWN（channel flags）给出明确下一步：涉 activation 保护域，需 SPEC 级调查（如 Owner 同意可立单）。
- 5 个 DEAD 中 3 个已退役（独立小 PR），2 个走 SPEC（protected zone 纪律）。
- 文档同步：USER_GUIDE 双语、feature-flag-governance、lifecycle-census、ADR-0016 示例、注册表/注释——无"代码删了文档还在宣传"残留（历史审计文档与 CHANGELOG 有意保留为史录）。
