# PD Pipeline Spine Phase 4a — Feature Flag 实证普查与 A/B/C 分类（55/55，audit-only）

## 1. 元信息

| 项 | 值 |
| --- | --- |
| 基线 | `origin/main` = `3f068988cf04b22501a5c190f52f88630d1cb12f`（2026-11-27） |
| 生成日期 | 2026-11-27（Executor Agent D，PRI-1294 Phase 4a） |
| 审计对象 | `packages/principles-core/src/runtime/feature-flags/feature-flag-contract.ts` 的 `DEFAULT_FEATURE_FLAGS`（55 个定义，L187-461）及其全部生产消费者 |
| 性质 | **audit-only**：本轮零代码修改、零删除；所有"清理/删除"均为后续工单的建议，须经 Owner 逐项拍板 |
| SPEC 注记 | 工单引用 SPEC-PD-PIPELINE-SPINE-001 v0.9 §6；仓库现为 **v0.14，状态 Draft for Owner Review（未批准）**（`docs/specs/SPEC-PD-PIPELINE-SPINE-001.md:3-5`）。Phase 4 定义（"4a 清理经 Owner 确认的纯死开关分支"，L287-290）语义在两版一致：本普查即 4a 的证据底座，任何清理动作仍受"远期门控、须 Owner 逐项拍板"约束 |

### 1.1 方法

1. **逐个开关全量核查（无抽样）**：对 55 个 id 分别执行三桶 `rg`（生产 `packages+scripts` 排除 `__tests__/tests/*.test.ts`；测试；`docs+scripts`），并对每个 id 追加"字符串字面量 + 点属性访问"联合模式（`'<id>'|"<id>"|.<id>`，pcre2），避免漏掉 `flags.xxx?.enabled` 形态的消费点。
2. **动态访问扫描**：`rg "flags\[[a-zA-Z_]+\]|features\[[a-zA-Z_]+\]"` 全仓生产码，逐个归位到已知 flag 常量（`signal-classifier.ts:164` flagId 默认 `signal_collector`、`adaptive-priority-provider.ts:23-25` 三 host AA 常量、`workbuddy-setup.ts:41` FLAG_ID、`loadFeatureFlagFromConfig` 的 flagId 参数链等）。未发现以拼接方式构造的未知动态 key。
3. **配置覆盖路径核实**（§1.2）：三条计算路径全部从同一 registry 取默认值。
4. **消费分支实读**：对每个生产消费点读上下文确认"flag 值真的控制行为"，区分行为型消费 / 状态显示型消费 / 测试引用 / 文档引用。
5. **治理与 lifecycle 对照**：`docs/architecture/feature-flag-governance.md`（PRI-574）、`docs/process/feature-flag-lifecycle-census.md`（PRI-610）、`QUIET_FLAG_LIFECYCLE`（`feature-flag-lifecycle.ts:39-351`）、`feature-flag-contract.test.ts`、`docs/architecture/PRI-751-feature-flag-reality-matrix.md`。
6. **中间产物**：`D:\Code\principles\.tmp\pri-1294\flag-census\evidence\{prod,test,docs,lit,cons}/<id>.txt`（55×5 份原始 rg 证据），报告结论均可回溯到这些文件与 `path:line`。

### 1.2 配置覆盖路径（`.pd/config.yaml` features 段如何生效）

单一事实源：`DEFAULT_FEATURE_FLAGS`（`feature-flag-contract.ts:187-461`）。三条计算路径共享它：

| 路径 | 位置 | 生产使用 |
| --- | --- | --- |
| `computeEffectiveFlags` | `feature-flag-contract.ts:463-548` | **生产零调用**；仅测试使用（`pd-config-sparse-bootstrap.test.ts`、`workbuddy-host-contract.test.ts`、`story-a-acceptance.test.ts`、各 flag 测试）+ `runtime/index.ts:637` barrel 再导出 |
| `computeFeatureFlagsFromConfig` / `isFeatureEnabled` | `runtime/config/pd-config-feature-flags.ts:45-137` | 主生产路径（pd-cli 命令、pd-console server、host-runtime） |
| `computeEffectivePdConfig`（features 合并段） | `runtime/config/pd-config-effective.ts:70-125` | effective config 层（`getDefaultPdConfig` 经 `pd-config-defaults.ts:25-31` 从契约 registry 派生） |
| `loadFeatureFlagFromConfig` | `host-runtime/src/pd-config.ts:112-118` | openclaw-plugin / codex-adapter / workbuddy-adapter / host-runtime 的单 flag 读取便捷层（内部走 `computeFeatureFlagsFromConfig`） |

语义在三条路径一致（可观察性契约，全部带 warning）：

- gone flag：拒绝重新启用，`gone flag cannot be re-enabled`（contract:505-511；pd-config-feature-flags.ts:73-78；pd-config-effective.ts:86-96——后者还强制 registry 的 gone category 覆盖存量配置里的旧 quiet 形态，PRI-752）；
- core flag：省略=恒 ON；显式 `enabled:false` = 应急停用 + `core flag explicitly disabled via config (emergency disable)`（contract:518-526；pd-config-feature-flags.ts:90-99；pd-config-effective.ts:98-113）；
- quiet flag：接受任意有效覆盖（contract:529-532）；
- 未知 key：`unknown flag ignored`，永不成为有效能力（contract:536-540；pd-config-feature-flags.ts:107-112；pd-config-effective.ts:118-125）；
- 危险键（`__proto__`/`constructor`/`prototype`）拒绝（contract:11,63-67,477-483）；malformed override 保留默认+告警（contract:498-501）；
- PRI-609 别名归一：`FEATURE_FLAG_ALIASES` 现为**空表**（contract:23），归一化函数仍在三条路径前置运行（pd-config-effective.ts:70-74）。

## 2. 审计总表（55 行）

说明：**分类** 取值 A / B / C / UNCLASSIFIED。本普查 **A=0、B=26、C=17、UNCLASSIFIED=12**（12 个均为 gone tombstone，属分类学外的"保留（兼容 tombstone）"，详见 §6）。生产消费者均为 `packages/*/src`（或 `scripts/`）内非测试引用；`path:line` 可在基线 commit 复核。

**core（9 个，default ON）**

| ID | Category | Default | Production Consumer(path:line) | 实际分支状态 | 分类 | 关键证据 | 建议 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| prompt | core | ON | host-runtime/src/prompt-injection-status.ts:133-140；prompt-injection-projection.ts:178-185；enabledChannels 链 pd-config-feature-flags.ts:37,116-122 → pd-cli runtime-internalization-queue.ts:108、runtime-canary.ts:164 | OFF=prompt 注入面整体停用（globalReason 带 nextAction）+queue/canary 过滤该 channel | B | MVP 三通道之一（ADR-0014 §2.4）；core 禁省略关闭，显式 false=应急停用并告警（feature-flag-contract.ts:518-526） | 保留 |
| code_tool_hook | core | ON | enabledChannels 消费：pd-cli runtime-internalization-queue.ts:108、runtime-canary.ts:164、runtime-features.ts:68；installer raw reader create-principles-disciple/src/mvp-config.ts:8（governance §3.5 登记） | 全仓无 `flags.code_tool_hook` 直接读取；OFF=queue/canary 快照过滤该 channel + installer 通道校验；注意 host-runtime internalization-consumer-cycle.ts:722 硬编码三通道 | B | MVP 通道开关；OFF 对 pd-cli 队列/金丝雀视图与 installer 校验有可观察差异；应急停用不暂停 host-runtime 推进（边界发现 BF-3） | 保留（附 BF-3 保留意见） |
| defer_archive | core | ON | 同 code_tool_hook（enabledChannels 链 + installer mvp-config.ts:8） | 同 code_tool_hook | B | 同 code_tool_hook | 保留（附 BF-3 保留意见） |
| rulecode_safety_controls | core | ON | principles-core/src/runtime/activation/rulecode-owner-decision-service.ts:120-121；openclaw-promotion-checks.ts:289-299；pd-console ActivationsConsoleModel.ts:805,971；pd-cli runtime-activation.ts:669,700 | OFF=Owner 决策拒绝（safety_controls_unavailable）+晋升检查阻断+状态面显示 disabled | B | description 明示应急停用走 code_tool_hook 语义；消费为行为型（拒绝/阻断），非仅显示 | 保留 |
| rulecode_owner_live_decision | core | ON | pd-console ActivationsConsoleModel.ts:1051（throw feature_not_enabled）；pd-cli runtime-activation.ts:668 | OFF=晋升/Owner 决策拒绝，nextAction 指向 rollout gate | B | PRI-435 系 gate 后默认 ON；OFF=拒绝晋升（可恢复：重新配置） | 保留 |
| internalization_full_chain | core | ON | host-runtime/src/internalization-consumer-cycle.ts:741-746；openclaw-plugin/src/openclaw-worker.ts:363 | OFF=auto-consumer 退回 dreamer-only（DEFAULT_CONSUMER_RUNNER_KINDS）；ON=全链 dreamer→…→evaluator | B | PRI-419 amendment；OFF=明确回退语义（rollout_reviewer 仍为人审门） | 保留 |
| code_rule_capability | core | ON | pd-cli/src/services/rulehost-readiness.ts:248-250；host-runtime internalization-consumer-cycle.ts:875,1071；pd-cli runtime-internalization-run-rulehost.ts:204 | OFF=readiness 拒绝（提示 text-principle-only 模式）+RuleHost 对抗管线跳过 | B | PRI-435 core 化；OFF=降级路径存在且可观察 | 保留 |
| host.codex | core | ON | codex-adapter/src/pd-hook.ts:511；worker/workspace-worker.ts:305；ingestion/catch-up.ts:80；host-runtime codex-worker-status.ts:51-52；pd-cli health-codex.ts:397,607 | OFF=pd-hook 输出 {} + exit 0 + skip 记录（rc-9）；worker/catch-up 暂停；health 报 blocker | B | ADR-0020；OFF=可观察跳过，整 host 熔断开关 | 保留 |
| new_user_onboarding | core | ON | pd-console src/server/routes/onboarding.ts:72；ui/App.tsx:164；ui/pages/settings/SettingsPage.tsx:198,354 | OFF=无 /welcome 重定向 + demo 触发端点关闭 + Settings 开关可见 | B | maintainer-approved MVP-Core（2026-07-01）；OFF=首次体验降级但可逆 | 保留 |

**quiet 默认 ON（17 个）**

| ID | Category | Default | Production Consumer(path:line) | 实际分支状态 | 分类 | 关键证据 | 建议 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| signal_collector | quiet | ON | host-runtime/src/signal-classifier.ts:164-166 | OFF=LLM 深判停用，降级 keyword-only + WARN + `pd config doctor` needs_setup | B | PRI-797 毕业（2026-09-15）；OFF=显性降级非静默；关键词检测不受此 flag 控制（description 明示） | 保留 |
| internalization_auto_consumer | quiet | ON | workbuddy-adapter/src/worker/workspace-worker.ts:301；codex-adapter/src/worker/workspace-worker.ts:339；openclaw-plugin/src/index.ts:141；pd-cli runtime-internalization-queue.ts:109；pd-console routes/failed-tasks.ts:763 | OFF=执行暂停（ready 任务保持 pending，证据不冻结） | B | PRI-381/624 Workspace 执行权威；OFF=暂停语义，lifecycle KEEP_QUIET | 保留 |
| story_a_approval_completion | quiet | ON | pd-console src/server/models/ApprovalsConsoleModel.ts:930-941 | OFF=批准后跳过激活（approval 保持 approved，可手动 `pd runtime activation dispatch`），无数据损伤 | B | PRI-408 Contract F；OFF=回退到手动 dispatch，可观察 | 保留 |
| feedback_channel | quiet | ON | pd-console src/server/routes/feedback-reports.ts:152-219,277 | OFF=submit 端点 403 + 提交 UI 隐藏；配置段保留 | B | PRI-543 范围扩展（report+submit 双梯）；OFF=可观察 403 | 保留 |
| diagnostician_core_grounding | quiet | ON | principles-core/src/runtime/internalization/diag-rootcause-runner.ts:480；diag-distiller-runner.ts:183 | OFF=诊断 prompt 无 core grounding 块 | B | Arm 2；OFF=prompt 回退，两态差异明确 | 保留 |
| diagnostician_split_pipeline | quiet | ON | principles-core/src/runtime/config/pd-config-effective.ts:199-224（PRI-638 legacy-false shim）；pd-console pd-config-store.ts:515-527（写侧退役 legacy 键）；显示面 pd-console enum-labels.ts:116 | 实现选择职责已死（PRI-638：树中只剩 split 实现，pain-signal-runtime-factory.ts:683 注释、diagnose.ts:501-503）；legacy `enabled:false` 经 shim 折叠为 agent.enabled=false + 告警 | B* | 保留理由=legacy 兼容 shim + 契约测试锁定（feature-flag-contract.test.ts:516 PRI-369）+ 有效 flag 面显示；flag-OFF 经 shim 仍产生可观察、可恢复行为（诊断器禁用）。**特别核查详见 §3**；与 4b 候选 A（diag_distiller+diag_router 合并评估）共享此开关，本分类仅依据当前代码现实 | 保留（兼容 shim；非 A） |
| diagnostician_llm_degradation | quiet | ON | principles-core/src/runtime/runner/base-peer-runner.ts:1444 | OFF=rate_limit 走 retryOrFail → max_attempts_exceeded（legacy 硬失败） | B | ADR-0019 / PRI-571 毕业；OFF=legacy 行为分支仍完整 | 保留 |
| rulecode_context_v2 | quiet | ON | openclaw-plugin src/hooks/gate.ts:443；pd-cli runtime-internalization-run-rulehost.ts:185；runtime-activation.ts:961；principles-core rule-host-writer.ts:42；pd-config-loader.ts:236,252-256（config 加载失败 fail-closed） | OFF=迁移期熔断：v2 context 拒绝生成、规则走 legacy 路径、状态面 suspended_by_flag | B | PRI-780 毕业（2026-09-13）；description/治理文档明示 quiet=保留迁移熔断 | 保留 |
| failed_tasks_observability | quiet | ON | pd-console routes/pipeline-health.ts:84-92；routes/failed-tasks.ts:672-673；server/index.ts:343；ui/app-sidebar.tsx:178 | OFF=端点拒绝 + 侧边栏项隐藏 | B | OFF=Console 只读化，可恢复 | 保留 |
| evaluator_artificer_repair_loop | quiet | ON | host-runtime/src/internalization-consumer-governance.ts:195；pd-cli rulehost-pipeline-runner.ts:845 | OFF=needs_revision 无自动修复出边（dead-end，仅诊断用途） | B | PRI-509 / INV-02 liveness；OFF=legacy 行为；治理文档 PRI-779 已同步真实消费点 | 保留 |
| artificer_output_retry | quiet | ON | principles-core/src/runtime/internalization/artificer-runner.ts:652 | OFF=output_invalid 恢复为永久失败类别（legacy） | B | PRI-621 毕业（2026-08-29）；OFF=legacy 永久失败 | 保留 |
| principle_receipt_block_copy | quiet | ON | openclaw-plugin/src/hooks/gate-block-helper.ts:234 | OFF=block 文案回退通用英文模板（byte-identical） | B | PRI-530 / PRI-571 毕业；OFF=模板回退 | 保留 |
| principle_receipt_ledger | quiet | ON | openclaw-plugin gate.ts:273,753、hooks/prompt.ts:1207；workbuddy-adapter pd-hook.ts:334；pd-console ReceiptsConsoleModel.ts:499-503；host-runtime product-telemetry/milestone-readers.ts:59 | OFF=无 ledger 写入 + Receipt 面降级显示（带 reason+nextAction） | B | PRI-531 / PRI-571 毕业；OFF=降级可观察 | 保留 |
| principle_governance_projection_v2 | quiet | ON | pd-console routes/principles.ts:212-216；routes/owner-decision.ts:36,51,88；server/index.ts:344 | OFF=projection/owner-decision 端点 403（feature_disabled）+ pre-projection 详情视图 | B | PRI-549 / PRI-571 毕业；OFF=旧视图保留 | 保留 |
| failed_task_recovery_console | quiet | ON | pd-console routes/failed-tasks.ts:807-811（POST recover 403）；ui/pages/failed-tasks/FailedTasksPage.tsx:513（按钮隐藏） | OFF=Console 只读，恢复仅 CLI | B | Owner 决策 2026-08-24；复用 RecoverySweepService，flag-off=403 | 保留 |
| openclaw_diagnostician_consumer | quiet | ON | host-runtime/src/diagnostician-auto-run.ts:103-108 | OFF=L3 自动诊断跳过，诊断任务保持 pending 交 L2（Console 请求驱动），不丢弃 | B | SPEC-PD-AGENT-PAIN-INGRESS-001 §8.4；OFF=降级到 L2（可观察） | 保留 |
| governance_experience_v1 | quiet | ON | pd-console routes/governance.ts:79-85；ui/pages/focus/FocusPage.tsx:651；ui/pages/review/review-data.ts:37；server/index.ts:350 | OFF=端点 403（无 DB 访问）+ legacy Focus 体验 | B | PRI-584~587 毕业（2026-08-29）；explains-only（ERR-102） | 保留 |

**quiet 默认 OFF（17 个）**

| ID | Category | Default | Production Consumer(path:line) | 实际分支状态 | 分类 | 关键证据 | 建议 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| correction_observer | quiet | OFF | openclaw-plugin/src/index.ts:117-124；service/correction-observer-service.ts:189,424 | OFF=LLM 优化 observer 服务不启动（同步纠正检测独立运行，不受影响） | C | 可选 LLM 关键词优化服务；lifecycle KEEP_QUIET（6 个月无 dogfood 激活即退役标准） | 保留 |
| automatic_pain_submission | quiet | OFF | host-runtime/src/auto-pain-authorization.ts:26,34（消费链 openclaw signal-collector-host + diagnostician-auto-run + pd-cli pain retry） | OFF=automatic_hook 信号保持 observation-only：无 Stage-2 LLM 分类、无 Pain 提交、无诊断任务 | C | SPEC §9.6 B 类授权；刻意独立于 signal_collector / internalization_auto_consumer（lifecycle 2026-11-20） | 保留 |
| prompt_full_pipeline | quiet | OFF | pd-cli/src/services/pd-config-loader.ts:272（resolvePromptFullPipelineSeedMode）；principles-core pain-signal-runtime-factory.ts:1256；pd-console SettingsPage.tsx:218,377（Console 开关） | OFF=标准 channel-aware 拓扑；ON=仅新种子 prompt/defer_archive 链走全 legacy 管线（seed-time 应用，不重释在途链） | C | PRI-720 Owner 指令 escape hatch；lifecycle 明示"永久 Owner 控制面，非未完成特性" | 保留 |
| diagnostician_async_cli | quiet | OFF | pd-cli/src/commands/pain-record.ts:448 | OFF=同步等待诊断完成；ON=提交即返、后台诊断 | C | PRI-375 注册默认关（orchestrator 未落地前）；lifecycle KEEP_QUIET | 保留 |
| l2_dreamer | quiet | OFF | host-runtime internalization-consumer-cycle.ts:1066；pd-cli runtime-adapter-resolver.ts:293-294 | OFF=dreamer 一次性 completeSimple；ON=多轮 agentLoop（只读工具+submit_output），零迁移回退 | C | PRI-419；scoped 单 runner 例外（ADR-0014 amendment） | 保留 |
| intent_engineering | quiet | OFF | pd-config-feature-flags.ts:157-160（isIntentAnchoringEnabled 唯一谓词）+ 全链消费：openclaw hooks/prompt.ts:1258、core/intent-doc-reader.ts:176；pd-cli intent.ts:409；pd-console routes/intent.ts:38、routes/intent-decisions.ts:93；diag-rootcause/dreamer/philosopher/scribe 各 runner 的 strategic-strip 分支（lifecycle consumers 全列） | OFF=无 INTENT 读取、无 prompt 注入、无 intentTension；各阶段经同一谓词保证一致性（SIA v1.2 P1-2） | C | PRI-465 + 2026-11-15 统一化（flag 拥有整链）+ PRI-1229~1233 B 阶段（每入口传 reader） | 保留 |
| principle_receipt_self_report | quiet | OFF | host-runtime prompt-injection-status.ts:130、active-principle-prompt.ts:162、prompt-activation-deliverability.ts:157；openclaw-plugin core/principle-application-ledger.ts:213；pd-cli principles-stats.ts:632 | OFF=directive 模板不变 + 无自报捕获写入 | C | PRI-532 P1-a；默认关待 agent 合规验证（lifecycle KEEP_QUIET） | 保留 |
| pain_diagnosis_persistence | quiet | OFF | principles-core pain-signal-runtime-factory.ts:1255、diag-rootcause-runner.ts:481；pd-cli diagnose.ts:497、pain-retry.ts:643 | OFF=无 pain_diagnoses 写入 + Stage A prompt byte-identical（Evidence First 块不注入） | C | 双半特性单旗（prompt 块 + 持久化）；默认关待验证 | 保留 |
| anonymous_product_telemetry | quiet | OFF | host-runtime/src/product-telemetry/service.ts:52 | OFF=任何表面零导出尝试；ON 还需 consent + 环境资格（三重门） | C | PRI-595~603；maintainer release gate 独立于用户 consent | 保留 |
| workbuddy_live_keyword_pain | quiet | OFF | workbuddy-adapter/src/pd-hook.ts:352；host-runtime governance-signal-admission.ts:2194；pd-cli workbuddy-worker.ts:107-108；installer workbuddy-host-installer.ts:1832-1878（显式置 false 迁移） | OFF=仅显式"PD记录痛苦："前缀 intake；ON（且 host.workbuddy ON）=自动候选进入 admission（当前仍 observation_only，见关键证据） | C | 2026-11-05 审计：WorkBuddy 入口 **UNSUPPORTED**（无持久观察 writer，候选永不成为 Pain 行）；description 明示 keep off；lifecycle 仍 KEEP_QUIET（毕业=补 writer+E2E+Owner 决策） | 保留（注明能力当前 unsupported，开关本身两态可观察） |
| codex_conversation_ingestion | quiet | OFF | codex-adapter pd-hook.ts:518；worker/workspace-worker.ts:364-366；ingestion/catch-up.ts:83、ingestion/turn-context.ts:345；pd-cli health-ingestion.ts:392、health-codex.ts:78 | OFF=零 transcript 读取（hook 边界零文件系统调用）+零 observation 写入 | C | PRI-622 Slice A（SPEC rev 2 §17，G0 APPROVED 2026-08-29）；隐私边界即 flag-off | 保留 |
| workbuddy_conversation_ingestion | quiet | OFF | workbuddy-adapter pd-hook.ts:462；worker/workspace-worker.ts:313；pd-cli workbuddy-setup.ts:41（FLAG_ID）、health-ingestion.ts:454 | OFF=零 transcript 读取；ON 还需 host.workbuddy ON + v3 consent 记录（三重门） | C | PRI-1171 P2；三门结构 flag-off 可观察 | 保留 |
| host_identity_minimal_metadata | quiet | OFF | pd-mcp-server submit-assembly.ts:306-315；codex-adapter pd-hook.ts:1058、ingestion/pain-receipt-fallback.ts；workbuddy-adapter pd-hook.ts:638、ingestion/pain-receipt-fallback.ts:342-361 | OFF=Pain 提交保持法律未绑定（blocked_by_consent），零身份元数据持久化 | C | PRI-1274 B1；刻意独立于 codex_conversation_ingestion / automatic_pain_submission（lifecycle 2026-11-21） | 保留 |
| host.workbuddy | quiet | OFF | workbuddy-adapter pd-hook.ts:326、worker/workspace-worker.ts:279；pd-cli health-workbuddy.ts:162、workbuddy-setup.ts:372；host-runtime workbuddy-worker-status.ts:51；pd-console pd-config-store.ts:1273,1508、AdaptiveActivationConsoleModel.ts:283 | OFF=hook 输出中性 JSON + exit 0 + 可观察 skip 记录（rc-9），无 dispatch、无 transcript 读取 | C | ADR-0020 第三 host（SPEC workbuddy-host-adapter v0.3.0 OD-03）；显式 opt-in（install 不启用） | 保留 |
| host.codex.adaptive_activation | quiet | OFF | codex-adapter pd-hook.ts:523,690；host-runtime adaptive-priority-provider.ts:24；pd-console pd-config-store.ts:1054、AdaptiveActivationSection.tsx:147 | OFF=Native 输出逐字节不变 + 零模型请求 | C | PRI-1170；独立于 host.codex（互不隐含）；启用还需完整 pi-ai profile + key | 保留 |
| host.openclaw.adaptive_activation | quiet | OFF | openclaw-plugin hooks/prompt.ts:728、index.ts:255；pd-console pd-config-store.ts:1055、AdaptiveActivationConsoleModel.ts:267 | OFF=既有固定映射不变 | C | PRI-1105；需 host 可入场当前 user message+ID | 保留 |
| host.workbuddy.adaptive_activation | quiet | OFF | workbuddy-adapter pd-hook.ts:519-521；pd-console pd-config-store.ts:1056,1069、AdaptiveActivationConsoleModel.ts:269 | OFF=Native 原则缺口选择器不启用 | C | PRI-1105/PRI-1170 家族；需当前 UserPromptSubmit generation_id | 保留 |

**gone（12 个，default OFF 且永久不可启用）**

| ID | Category | Default | Production Consumer(path:line) | 实际分支状态 | 分类 | 关键证据 | 建议 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| release_manager_shadow | gone | OFF | 无运行时消费者（全仓仅 registry 定义 feature-flag-contract.ts:231 + 契约测试） | 存量 `enabled:true` 覆盖被两条生产计算路径可观察拒绝；enabled 保持 false | UNCLASSIFIED（tombstone） | PRI-738 退役：signed ReleaseManager 检查已无条件化，无 legacy 比较分支残留 | 保留（兼容 tombstone） |
| release_manager_write_authority | gone | OFF | 无（仅 feature-flag-contract.ts:232 + 测试） | 同上 | UNCLASSIFIED（tombstone） | PRI-738：ReleaseManager 唯一写权威，无替代 writer；Owner 毕业决策 PRI-672/698（lifecycle census 快照） | 保留（兼容 tombstone） |
| gfi | gone | OFF | 无运行时消费者；非 flag 引用：installer mvp-config.ts:14（MVP_GONE_FLAGS 常量） | 同上 | UNCLASSIFIED（tombstone） | GFI-COMPLETE-REMOVAL-001（2026-11-04）：评分内核/session state/观察面全部删除，无 runtime owner（governance §3.1） | 保留（兼容 tombstone） |
| evolution_worker | gone | OFF | 无运行时消费者；显示面 pd-console enum-labels.ts:112（'进化工作器'） | 同上 | UNCLASSIFIED（tombstone） | PRI-737 删 worker、PRI-752 移入 gone（live 证据：flag=off、evolution_tasks/events 0 行）；census 2026-12-01 窗口因主体已不存在而提前满足 | 保留（兼容 tombstone） |
| empathy_observer | gone | OFF | 无运行时消费者 | 同上 | UNCLASSIFIED（tombstone） | PRI-751 / #1625 退役，PRI-819 物理清理（类/schema/agent 绑定/显示标签全删）；检测已无条件走 signal-collector-host | 保留（兼容 tombstone） |
| internalization_core_grounding | gone | OFF | 无运行时消费者；显示面 pd-console enum-labels.ts:115 | 同上 | UNCLASSIFIED（tombstone） | PRI-751 / #1624：grounding 由 runner 自身 `coreGrounding:true` 默认值无条件启用，flag 从未有可执行读者 | 保留（兼容 tombstone） |
| artifact_summary_redundancy | gone | OFF | 无运行时消费者 | 同上 | UNCLASSIFIED（tombstone） | PRI-819 R-06（Owner 决策 2026-09-18）：Layer 0 读者与门控分支同批删除 | 保留（兼容 tombstone） |
| context_manifest_budget | gone | OFF | 无运行时消费者 | 同上 | UNCLASSIFIED（tombstone） | PRI-819 R-06：Layer 1（manifest+budget 注入）读者与分支已删 | 保留（兼容 tombstone） |
| progressive_evaluator | gone | OFF | 无运行时消费者 | 同上 | UNCLASSIFIED（tombstone） | PRI-819 R-06：Layer 2（两阶段评估）已删，evaluator 恢复单阶段 | 保留（兼容 tombstone） |
| abstraction_layer_v1 | gone | OFF | 无运行时消费者 | 同上 | UNCLASSIFIED（tombstone） | PRI-1137：shared host runtime 唯一路由，OpenClaw legacy 注入路由已删；id 保留使旧 config 条目可识别（description 明示） | 保留（兼容 tombstone） |
| nocturnal | gone | OFF | 无运行时消费者；非 flag 引用：installer mvp-config.ts:14（MVP_GONE_FLAGS） | 同上 | UNCLASSIFIED（tombstone） | PRI-239 时代退役（Nocturnal 三元管线）；AGENTS §8.3 禁止重建该 retired 架构 | 保留（兼容 tombstone） |
| idle_trigger | gone | OFF | 无运行时消费者；非 flag 引用：mvp-config.ts:14；proven-channel-baseline.ts:144（LEGACY_KEYWORDS，对 activation reason 做关键词分类，非 flag 读取） | 同上 | UNCLASSIFIED（tombstone） | PRI-239 时代退役（后台 idle 触发器） | 保留（兼容 tombstone） |

## 3. A 类清理候选清单（纯死开关）

**本轮 A 类候选：0 个。**

55 个开关逐一核查后，没有任何一个同时满足 A 类全部要件（旧实现已删 + 无有效生产消费者 + 保留的判断只控制已不存在功能 + 删除不改变有效生产行为 + 无紧急制动/兼容需求或该需求可由 tombstone 保护）：

- 12 个 gone flag 是墓碑而非死开关：墓碑的"存在"本身就是可观察生产行为（两条生产计算路径都会拒绝 `enabled:true` 覆盖并告警，语义区别于 unknown-flag 告警），且每一条都挂着 Owner 退役决策记录（PRI-738 / GFI-COMPLETE-REMOVAL-001 / PRI-752 / PRI-751 / PRI-819 R-06 / PRI-1137）。按工单 gone 特别规则，全部归"保留（兼容 tombstone）"。
- 9 个 core + 17 个默认 ON quiet 全部有行为型生产消费者且 OFF 分支有效（§4）。
- 17 个默认 OFF quiet 全部有有效消费者且两态可观察（§5）。
- 最接近 A 类的 `diagnostician_split_pipeline`（工单 A 类候选示例）经实证**不是**纯死开关：其能力选择职责确已死于 PRI-638（树中只剩 split 实现，`pain-signal-runtime-factory.ts:683-690` 注释明示），但 registry 条目仍承担三件事：① PRI-638 legacy-`false` 切换 shim（`pd-config-effective.ts:199-224`）——存量 `diagnostician_split_pipeline.enabled:false` 被折叠为 `internalAgents.agents.diagnostician.enabled=false` 并发告警，防止升级时静默激活先前禁用的 LLM 管线；② Console 写侧在 Owner 打开诊断器时同一原子写中退役冲突的 legacy 键（`pd-config-store.ts:515-527`）；③ 契约测试锁定注册事实（`feature-flag-contract.test.ts:516` PRI-369）+ 有效 flag 面（`pd runtime features` / Console Settings）显示。删除定义会把存量键变为 unknown 告警并移除有效面可见性——**行为可观察变化**，不满足 A 类"删除不改变有效生产行为"要件。

**并行冲突矩阵**：因 A 类为空，矩阵输入为空。补充核查：4 个并行分支（`ai/PRI-1299-pipeline-spine-successor-lookup-taskstor`（37 files）、`ai/PRI-1300-repair-lineage-core`（12）、`ai/PRI-1301-executor-revision-dedup`（11）、`ai/PRI-1302-orchestrator-interface-spike`（0）相对基线 `git diff --name-only` 与本普查涉及的文件（feature-flag-contract.ts、pd-config-effective.ts、pd-config-feature-flags.ts、enum-labels.ts、mvp-config.ts、proven-channel-baseline.ts、diagnose.ts、pain-retry.ts、pain-record.ts、signal-classifier.ts、auto-pain-authorization.ts、diagnostician-auto-run.ts）**零交集**；同工单姊妹分支 `ai/PRI-1294-pdlab-assessment`（0 files）亦无交集。未来若 Owner 批准任何清理（含 tombstone 精简），重跑该矩阵即可，当前无"延后到某 PR 合并后"的条目。

## 4. B 类保留清单（默认 ON，有制动价值；26 个 = core 9 + quiet-ON 17）

判据：默认开启、实现有效、flag-OFF 仍是有效可恢复/降级路径（紧急制动或回退），删除判定将移除应急能力。

| # | ID | Cat | 默认 | 制动价值（flag-OFF 行为） | 关闭后可恢复性 | 保留理由（一句话） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | prompt | core | ON | prompt 注入面整体停用（globalReason+nextAction） | config 改回 true 即恢复 | MVP 通道总闸，ADR-0014 §2.4 |
| 2 | code_tool_hook | core | ON | pd-cli 队列/金丝雀过滤该 channel + installer 校验回退 | 同上 | MVP 通道开关（BF-3 保留意见：不暂停 host-runtime 推进） |
| 3 | defer_archive | core | ON | 同 code_tool_hook | 同上 | MVP 通道开关（同 BF-3） |
| 4 | rulecode_safety_controls | core | ON | Owner 决策拒绝 + 晋升检查阻断 | 恢复后决策/晋升可用 | RuleCode 安全隔离权威；description 明示应急停用语义 |
| 5 | rulecode_owner_live_decision | core | ON | 晋升拒绝（feature_not_enabled） | rollout gate 语义恢复 | shadow→live 决策权威的应急停用 |
| 6 | internalization_full_chain | core | ON | auto-consumer 退回 dreamer-only | 恢复=全链推进 | PRI-419 amendment 的范围回退杆 |
| 7 | code_rule_capability | core | ON | readiness 拒绝 + 管线跳过（text-only 模式提示） | 恢复=对抗管线回归 | PRI-435；RuleHost 管线急停 |
| 8 | host.codex | core | ON | pd-hook 输出 {} + exit 0 + skip 记录 | config 改回即恢复 | 整个 Codex host 的熔断（rc-9 可观察） |
| 9 | new_user_onboarding | core | ON | 无 /welcome 重定向 + demo 端点关 | 恢复即重现 | 首次体验面急停 |
| 10 | signal_collector | quiet | ON | 降级 keyword-only + WARN + needs_setup | 显式覆盖回滚 | PRI-797 毕业；OFF=显性降级路径 |
| 11 | internalization_auto_consumer | quiet | ON | 执行暂停（任务 pending 不冻结） | 恢复=继续推进 | PRI-381/624 执行权威暂停杆 |
| 12 | story_a_approval_completion | quiet | ON | 批准后跳过激活，手动 dispatch 回退 | 恢复=编排器接管 | PRI-408 Contract F 回退路径 |
| 13 | feedback_channel | quiet | ON | submit 403 + UI 隐藏 | 恢复=通道回归 | MVP 反馈面总闸 |
| 14 | diagnostician_core_grounding | quiet | ON | 诊断 prompt 无 grounding 块 | 恢复=块回归 | Arm 2 prompt 回退 |
| 15 | diagnostician_split_pipeline | quiet | ON | legacy-false shim 折叠为诊断器禁用（带告警与恢复指引） | Console 开诊断器即同写退役 legacy 键 | PRI-638 兼容 shim + 契约测试锁定（非能力选择旗） |
| 16 | diagnostician_llm_degradation | quiet | ON | rate_limit 硬失败（legacy） | 恢复=优雅降级回归 | ADR-0019；OFF=legacy 行为分支完整保留 |
| 17 | rulecode_context_v2 | quiet | ON | v2 context 拒绝生成（迁移熔断）+ config 失败 fail-closed | 恢复=治理路径回归 | PRI-780 毕业后保留的迁移期熔断 |
| 18 | failed_tasks_observability | quiet | ON | 端点拒绝 + 侧边栏隐藏 | 恢复=可观测性回归 | 运维可观测面急停 |
| 19 | evaluator_artificer_repair_loop | quiet | ON | needs_revision dead-end（legacy，仅诊断用） | 恢复=INV-02 liveness 回归 | PRI-509；OFF=legacy 行为 |
| 20 | artificer_output_retry | quiet | ON | output_invalid 永久失败（legacy） | 恢复=重试语义回归 | PRI-621 毕业；OFF=legacy |
| 21 | principle_receipt_block_copy | quiet | ON | block 文案回退通用模板（byte-identical） | 恢复=归因文案回归 | PRI-530 毕业；OFF=模板回退 |
| 22 | principle_receipt_ledger | quiet | ON | 无 ledger 写入 + Receipt 面降级（reason+nextAction） | 恢复=写入恢复 | PRI-531 毕业；证据面急停 |
| 23 | principle_governance_projection_v2 | quiet | ON | projection/owner-decision 403 + 旧视图 | 恢复=投影回归 | PRI-549 毕业；旧视图保留为回退 |
| 24 | failed_task_recovery_console | quiet | ON | recover 端点 403 + 按钮隐藏（CLI 恢复仍可用） | 恢复=Console 恢复动作回归 | Owner 决策 2026-08-24；写面急停 |
| 25 | openclaw_diagnostician_consumer | quiet | ON | L3 跳过，任务留 L2 pending（不丢） | 恢复=L3 回归 | 降级梯 L3/L2 结构性回退 |
| 26 | governance_experience_v1 | quiet | ON | 端点 403（无 DB 访问）+ legacy Focus | 恢复=快照体验回归 | PRI-584~587 毕业；legacy Focus 为回退 |

## 5. C 类保留清单（默认 OFF，活跃实验/可选能力；17 个）

判据：有有效消费者、两态有可观察差异、默认关=实验/灰度/Owner opt-in。

| # | ID | 实验目的 / 可选能力 | 主要消费者 | 状态 | 两态价值 |
| --- | --- | --- | --- | --- | --- |
| 1 | correction_observer | LLM 关键词优化 dogfood（同步检测外的增值实验） | openclaw-plugin index.ts:117、correction-observer-service.ts | 默认 OFF，dogfood 中 | ON=observer 服务启动；OFF=仅同步检测 |
| 2 | automatic_pain_submission | B 类自动 Pain 提交授权（Workspace opt-in） | host-runtime auto-pain-authorization.ts:26,34 | 默认 OFF（2026-11-20 注册） | OFF=信号 observation-only；ON=进入分类/提交/诊断链 |
| 3 | prompt_full_pipeline | 全 legacy 管线 escape hatch（测试场景/显式全链跑） | pd-config-loader.ts:272、pain-signal-runtime-factory.ts:1256、Console Settings | 默认 OFF（PRI-720）；seed-time 应用 | ON=新种子链走全管线；OFF=channel-aware 短路径 |
| 4 | diagnostician_async_cli | 异步诊断提交模式 | pd-cli pain-record.ts:448 | 默认 OFF（orchestrator 未落地） | ON=提交即返后台诊断；OFF=同步等待 |
| 5 | l2_dreamer | dreamer 多轮 agentLoop 实验 | consumer-cycle.ts:1066、runtime-adapter-resolver.ts:293 | 默认 OFF（PRI-419） | ON=agentLoop+只读工具；OFF=one-shot，零迁移回退 |
| 6 | intent_engineering | INTENT.md 锚定全链（SIA v1.2 唯一谓词） | isIntentAnchoringEnabled + Stage A/Dreamer/Philosopher/Scribe + Console Intent 面 + CLI | 默认 OFF（PRI-465；2026-11-15 全链统一） | OFF=无 INTENT 读写无注入；ON=全链锚定 |
| 7 | principle_receipt_self_report | agent 自报 📌 行实验 | prompt-injection-status.ts:130、active-principle-prompt.ts:162、principle-application-ledger.ts:213 | 默认 OFF（PRI-532，待合规验证） | OFF=模板 byte-identical；ON=注入指令+捕获写入 |
| 8 | pain_diagnosis_persistence | 根因归因持久化 + Evidence First prompt | pain-signal-runtime-factory.ts:1255、diag-rootcause-runner.ts:481、diagnose.ts:497、pain-retry.ts:643 | 默认 OFF（2026-08-23） | OFF=无 pain_diagnoses 写+prompt 原样；ON=双半特性启用 |
| 9 | anonymous_product_telemetry | 匿名产品遥测（maintainer gate） | host-runtime product-telemetry/service.ts:52 | 默认 OFF；ON 需 consent+资格 | OFF=零导出；ON=每日布尔里程碑快照 |
| 10 | workbuddy_live_keyword_pain | WorkBuddy 实时关键词 Pain 实验通道 | workbuddy pd-hook.ts:352、governance-signal-admission.ts:2194、workbuddy-worker.ts:107 | 默认 OFF；2026-11-05 审计判 UNSUPPORTED（无持久观察 writer） | OFF=仅显式前缀 intake；ON=自动候选入 admission（现仍 observation_only） |
| 11 | codex_conversation_ingestion | Codex 对话摄入 Slice A（隐私边界=flag-off） | codex pd-hook.ts:518、workspace-worker.ts:364、catch-up.ts:83、turn-context.ts:345 | 默认 OFF（G0 APPROVED，Slices A-D 推进中） | OFF=零 transcript 读取；ON=有界摄入 governance_observations |
| 12 | workbuddy_conversation_ingestion | WorkBuddy 统一轨迹摄入（三门：host+flag+consent） | workbuddy pd-hook.ts:462、workspace-worker.ts:313、workbuddy-setup.ts:41 | 默认 OFF（PRI-1171 P2） | OFF=零 transcript 读取；ON=共享 seam 摄入 |
| 13 | host_identity_minimal_metadata | 最小身份元数据披露授权（ids only） | pd-mcp-server submit-assembly.ts:306-315、codex/workbuddy pd-hook + pain-receipt-fallback ×3 | 默认 OFF（PRI-1274 B1，2026-11-21） | OFF=提交 unbound（blocked_by_consent）；ON=_meta 预绑+回执回退绑定 |
| 14 | host.workbuddy | WorkBuddy host 适配器整体（第三 host opt-in） | workbuddy pd-hook.ts:326、workspace-worker.ts:279、health-workbuddy.ts:162 | 默认 OFF（OD-03；install 不启用） | OFF=中性 JSON+exit 0+skip；ON=完整 governance 环 |
| 15 | host.codex.adaptive_activation | Codex Adaptive Activation（Native 缺口选择） | codex pd-hook.ts:523,690、adaptive-priority-provider.ts:24 | 默认 OFF（PRI-1170）；PRI-1122 实况批量回滚通过 | OFF=Native byte-identical+零请求；ON=模型辅助增量选择 |
| 16 | host.openclaw.adaptive_activation | OpenClaw Adaptive Activation | openclaw prompt.ts:728、index.ts:255 | 默认 OFF（PRI-1105） | OFF=固定映射；ON=需入场身份的实时选择 |
| 17 | host.workbuddy.adaptive_activation | WorkBuddy Adaptive Activation | workbuddy pd-hook.ts:519-521 | 默认 OFF（PRI-1105） | OFF=Native 缺口不启用；ON=需 generation_id 的实时选择 |

## 6. UNCLASSIFIED 清单（12 个 gone tombstone；非 A——分类学外的保留项）

**语义澄清**：本清单的 UNCLASSIFIED **不是**"证据不足"（本普查对 12 项证据均完整），而是"A/B/C 分类语义域之外"：gone tombstone 的存在本身即生产行为（拒绝复活+告警），既非死开关（A），也非恒开制动（B），也非活跃实验（C）。按工单 gone 特别规则归类建议一律为**保留（兼容 tombstone）**；仅当某定义被证明"无兼容角色且无可观察消费者"才可提议移除——本轮无一满足该前提。

| # | ID | since | 退役决策记录（description/治理文档） | 兼容角色 | 非旗引用残留（非消费者） |
| --- | --- | --- | --- | --- | --- |
| 1 | release_manager_shadow | 2026-08-25 | PRI-738：signed 检查无条件化，无 legacy 比较 | 拒绝存量 enabled:true 复活 | 无 |
| 2 | release_manager_write_authority | 2026-09-06 | PRI-738：ReleaseManager 唯一写权威（毕业记录 PRI-672/698） | 同上 | 无 |
| 3 | gfi | 2026-05-24 | GFI-COMPLETE-REMOVAL-001（2026-11-04）：评分链路+观察面整体删除 | 同上 | installer MVP_GONE_FLAGS（mvp-config.ts:14） |
| 4 | evolution_worker | 2026-06-01 | PRI-737 删 worker；PRI-752 移入 gone（2026-09-12） | 同上 | enum-labels.ts:112 显示标签 |
| 5 | empathy_observer | 2026-06-02 | PRI-751 / #1625；PRI-819 物理清理 | 同上 | 无（显示标签已随 PRI-819 删除） |
| 6 | internalization_core_grounding | 2026-06-16 | PRI-751 / #1624：runner 默认值无条件 grounding | 同上 | enum-labels.ts:115 显示标签 |
| 7 | artifact_summary_redundancy | 2026-07-26 | PRI-819 R-06（Owner 2026-09-18）：Layer 0 读者+分支删除 | 同上 | 无 |
| 8 | context_manifest_budget | 2026-07-26 | PRI-819 R-06：Layer 1 | 同上 | 无 |
| 9 | progressive_evaluator | 2026-07-26 | PRI-819 R-06：Layer 2，evaluator 单阶段 | 同上 | 无 |
| 10 | abstraction_layer_v1 | 2026-08-13 | PRI-1137：shared host runtime 唯一路由 | id 保留使旧 config 条目可识别（description 明示） | 无 |
| 11 | nocturnal | 2026-05-24 | PRI-239 时代退役（Nocturnal 三元管线） | 拒绝复活 | installer MVP_GONE_FLAGS（mvp-config.ts:14） |
| 12 | idle_trigger | 2026-05-24 | PRI-239 时代退役（idle 触发器） | 同上 | mvp-config.ts:14；proven-channel-baseline.ts:144 LEGACY_KEYWORDS（对 refusal reason 做关键词分类，非 flag 读取） |

**为何不提议移除任何 tombstone 定义**：每一条的兼容角色都是"存量 `.pd/config.yaml` 里该键的可观察拒绝"（语义上区别于 unknown-flag 告警：前者告知 Owner"这是刻意退役的能力，不可复活"，后者只说"键未注册"）。该角色不可由其它机制等价替代——gone 分支拒绝 + 告警正是工单所述"历史 config 兼容的唯一保护机制"。12/12 保留。

**tombstone 的保护机制（三条生产/测试路径强制）**：

- `computeFeatureFlagsFromConfig`：`pd-config-feature-flags.ts:73-78`（gone 拒绝复活；category 权威于存量旧形态，PRI-752）；
- `computeEffectivePdConfig`：`pd-config-effective.ts:86-96`（同语义 + featuresChangedFromDefault 记账）；
- `computeEffectiveFlags`（测试口径 + barrel 导出）：`feature-flag-contract.ts:505-511`。

**移除单个 tombstone 定义的代价**（供 Owner 未来决策参考）：存量 `features.<gone-id>` 键从"gone 拒绝复活"告警退化为"unknown flag ignored"告警；`MVP_GONE_FLAGS`（installer）、surface-guard/lifecycle 测试断言、enum-labels 显示面需同步改。属 Owner-visible 契约变更，不在本 audit-only 轮提议。

## 7. 自审记录（强制第二轮，逐条）

1. **是否把 gone 等同 A 类？** 否。12 个 gone 全部按 tombstone 规则处理，保留理由各自挂 Owner 退役记录；`computeFeatureFlagsFromConfig`/`computeEffectivePdConfig` 的拒绝分支是生产行为（pd-config-feature-flags.ts:73-78、pd-config-effective.ts:86-96）。
2. **是否把默认 ON 等同死开关？** 否。26 个默认 ON 全部先找到行为型消费者再判 B；例如 `evaluator_artificer_repair_loop` OFF=legacy dead-end（internalization-consumer-governance.ts:195）、`artificer_output_retry` OFF=永久失败（artificer-runner.ts:652）、`rulecode_context_v2` OFF=迁移熔断（gate.ts:443 等）。
3. **是否漏动态消费者？** 已补扫：字面量+点属性联合模式抓到 5 个纯属性访问消费点（如 `flags.host_identity_minimal_metadata?.enabled`，codex-adapter/src/pd-hook.ts:1058）；变量 key 访问全部归位到已知常量（§1.1 第 2 步）。未发现拼接式未知 key。
4. **是否忽略紧急制动？** 否。core 9 个的显式 `enabled:false` 应急停用路径全部核实（contract:518-526 + 各消费者拒绝分支，如 ActivationsConsoleModel.ts:1051 晋升拒绝、rulehost-readiness.ts:248 readiness 拒绝）。**一处保留意见**见边界发现 BF-3（code_tool_hook/defer_archive 应急停用不暂停 host-runtime 推进）。
5. **是否误判配置兼容 tombstone？** 重点复核了 `diagnostician_split_pipeline`（未误判，见 §3）与 `abstraction_layer_v1`（PRI-1137 描述明示"kept so an old config.yaml entry stays recognizable"——兼容角色成立，保留）。
6. **是否遗漏 description 里的历史 Owner 决策？** 逐条读取了 55 条 description 并对照 governance/lifecycle 文档：PRI-797（signal_collector 毕业）、PRI-571（5 flag 毕业批次）、PRI-751/752/762/763（empathy/evolution/internalization_core_grounding/painEvidenceAdmission 退役）、PRI-819 R-06（3 个 progressive-disclosure 退役）、PRI-1137（abstraction_layer_v1）、PRI-638（split 管线唯一实现）、PRI-738（release_manager 双旗）、GFI-COMPLETE-REMOVAL-001、PRI-720（prompt_full_pipeline escape hatch）、PRI-1170/1105（三 host AA）、PRI-1274（host_identity_minimal_metadata）均已纳入分类依据。
7. **是否把测试/文档引用当生产消费者？** 分桶纪律：每开关 prod 桶排除 `__tests__/tests/*.test.ts/*.steps.ts/fixtures`；表格消费者列全部为 `src/`（或 `scripts/`、`pd-console/scripts/e2e-seed.ts` 显式标注）引用。enum-labels.ts 为显示标签，一律不计为消费者（仅在 tombstone 附录中作为显示面提及）。
8. **是否把已废弃实现当活跃？** 复核了 4 个高风险点：`diagnostician_split_pipeline` 的实现选择分支（已死，PRI-638——据此否决其 A 类候选资格中的"死分支可删"半边，但 shim 仍活）；`gfi`（评分链路确认已整体删除，仅 tombstone+installer 常量+显示标签残留）；`empathy_observer`（EmpathyObserver 类/schema/绑定确认已于 PRI-819 物理删除）；`computeEffectiveFlags`（确认为生产零调用，测试口径 API——不影响 tombstone 判定，因为生产强制走另两条路径）。

## 8. 边界发现（不在 55 行分类内，供后续工单参考）

**BF-1 治理/lifecycle 文档路径漂移**：`docs/architecture/feature-flag-governance.md:9` 与 `docs/process/feature-flag-lifecycle-census.md:5,13-14,20` 仍引用 `runtime-v2/feature-flags/...` 路径；当前真实路径为 `packages/principles-core/src/runtime/feature-flags/`（runtime-v2 已并入 runtime）。文档导航信息过期，SSoT 本身（TS registry）未漂移。建议后续 docs-only 工单修正。

**BF-2 `computeEffectiveFlags` 为测试口径 API**：生产零调用（全部生产消费走 `computeFeatureFlagsFromConfig` / `computeEffectivePdConfig` / `loadFeatureFlagFromConfig`），仅测试与 barrel 导出（runtime/index.ts:637）使用。governance 文档 §1 已将"两套消费 API 并存"登记为已知债务——本轮确认债务仍在，语义一致，不构成清理对象（删除会破坏契约测试与 barrel surface 基线，属重构决策）。

**BF-3 core 通道旗的应急停用覆盖面不完整**：`code_tool_hook` / `defer_archive` 全仓无直接 flag 读取，仅通过 `enabledChannels` 生效（pd-cli runtime-internalization-queue.ts:108、runtime-canary.ts:164、runtime-features.ts:68 + installer raw reader）；而 host-runtime 内化消费循环硬编码三通道（internalization-consumer-cycle.ts:722 `enabledChannels: new Set(['prompt','code_tool_hook','defer_archive'])`）。即：显式 `enabled:false` 应急停用会改变 CLI 队列/金丝雀视图与 installer 校验，但**不会暂停 host-runtime 的任务推进**。`prompt` 有直接读取（prompt-injection-status.ts:133），无此问题。属既有行为现实，非本普查修正项；建议在后续使 enabledChannels 真正贯通 host-runtime 消费循环或在该处注明豁免理由（须 Owner 决策）。

**BF-4 `legacy_retire` 分类零使用但被测试锁定**：`VALID_CATEGORIES` 含 `legacy_retire`（feature-flag-contract.ts:8），registry 零使用；`feature-flag-lifecycle.test.ts:111-114` 与 `plugin-surface-registry.test.ts:177` 将其锁定为"已识别、当前为空的过渡态"。删除该枚举属契约变更，收益仅是删一个枚举字面量——不建议动。

**BF-5 `FEATURE_FLAG_ALIASES` 空表**：PRI-609 别名机制（feature-flag-contract.ts:23）当前无任何别名条目，但归一化函数仍在三条计算路径前置运行并有专门测试。空表是机制保留而非死代码（一旦 snake_case 旧 id 出现即需它）；不建议动。

**BF-6 lifecycle census 的消费者字段局部过期**：`QUIET_FLAG_LIFECYCLE.diagnostician_split_pipeline.consumers`（feature-flag-lifecycle.ts:120）写 `pd-cli/src/commands/diagnose.ts、pain-retry.ts`——PRI-638 后这两处只余注释（diagnose.ts:501-503、pain-retry.ts:647-649），不再读取该 flag。PRI-779 zombie guard 未覆盖 lifecycle consumers 字段与源码的同步。属记录漂移，建议随下一次 lifecycle 触碰修正（audit-only 本轮不改）。

**BF-7 `workbuddy_live_keyword_pain` 状态与描述**：capability 在 WorkBuddy 内当前 UNSUPPORTED（无持久观察 writer，候选恒 observation_only），description 与 lifecycle census 均如实记录；flag 本身仍为有效两态开关（governance-signal-admission.ts:2194）。若 Owner 决定放弃该通道，其退役路径 = lifecycle census 正常 RETIRE 流程（先 gone 化，暂无物理分支可删——门控分支仍活）。

**BF-8 PRI-763 残留注释**：feature-flag-contract.ts:252-254 保留 PRI-763 退役说明注释（painEvidenceAdmission 系列已彻底移出 registry，无定义无墓碑）——注释性历史记录，非死代码。对照意义：PRI-763 走"零可执行消费者 + 从未广泛配置 → 完全移除、不留墓碑"路线（存量键直接走 unknown 告警）；其余 12 个 gone 走墓碑路线。两条退役路线并存且各有 Owner 决策背书，说明"是否留墓碑"在 PD 治理中本来就是逐案 Owner 决策，本普查不替 Owner 预设。

## 9. 结论

55/55 完成（无抽样）：**A 类纯死开关 0 个；B 类默认 ON 有制动价值 26 个（core 9 + quiet-ON 17）；C 类活跃实验/可选能力 17 个（quiet-OFF）；UNCLASSIFIED 12 个（gone tombstone，一律建议保留（兼容 tombstone））**。Phase 4a"清理纯死开关分支"在当前基线**没有可清理对象**——不存在同时满足"旧实现已删 + 无有效消费者 + 删除不改变生产行为 + 无兼容需求"的开关。任何后续清理只能来自 Owner 对具体 tombstone 或 shim 的逐项拍板（见 §3、§6 的代价说明）。
