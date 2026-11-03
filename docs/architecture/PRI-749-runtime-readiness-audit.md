# PRI-749 — Phase 0 Runtime Readiness Reality Audit

> 日期：2026-09-12
> 基线：`origin/main` `4dce7d942f00039113b698de2a5b27025b9a3fa6`（PR #1616 合并后）
> 性质：只读审计。零代码修改、零 PR。所有结论均以当前仓库代码 + 真实安装环境（`~/.pd`、`~/.openclaw`、live workspace `D:\.openclaw\workspace`）的可复核证据为准。
> 方法：临时 detached worktree 上做全仓扫描（不污染主 checkout 暂存工作）；live 数据用 `sqlite3 -readonly` 采集。
> 关联文档：`PRI-730-runtime-v2-surface-convergence-audit.md`、`PRI-731/736/737 evolution-worker reality audits`（本文不重复其结论，只引用）。

---

## 1. Executive Summary

PD 的**核心治理闭环在生产上是活的，但只走了半圈**：

- 活的半圈：pain 捕捉（13 events，最近 09-11）→ 诊断（198 tasks，168 succeeded）→ 候选（42，29 consumed）→ Receipt 注入（173 次 prompt_injected，最近 09-11 17:01）。
- 沉默的半圈：**RuleHost 拦截面零产出**（`gate_blocks=0`、`rule_blocked=0`、`auto_correct=0`）；**激活面总共 1 条记录**（09-01，唯一 principle）；approval 队列空、13 个候选自 09-05 起等 Owner。整个生产治理史只有**一个 principle**（Model-Evidence-Reversibility-Verification Loop）贡献了 100% 注入与自报。

Flag 层面的体检结论（47 个注册 flag）：

- **5 个 flag 无可执行消费者（no-op/dead）**，其中 `painEvidenceAdmission` / `painEvidenceAdmissionDefault` 两个**默认开启**的 flag 的注册描述承诺「flag-off 回滚 Gate A」，但生产代码不存在该回滚路由——**文档化的 rollback 契约是假的**（P1）。
- `evolution_worker` 死 flag 残留成簇：flag + surface-registry 两条目 + lifecycle 过期条目 + live workspace 孤儿数据 + 隐藏 CLI 组。PRI-737 代码注释已自认「retires under a separate change」。
- 大量「已完成但默认关闭」的能力沉淀：progressive disclosure 三层、pain_diagnosis_persistence、codex_conversation_ingestion、abstraction_layer_v1 等——它们是复杂度审计最容易被 AI 误判的来源（"存在≠启用"）。

Workspace 层面（live 1.235.0，2026-09-11 经 console apply-full 更新）与代码默认有 **17 处漂移**，其中两处与「已毕业默认-on」直接矛盾（Owner 主动关闭），一处闭环配置自相矛盾（progressive disclosure L1+L2 开、L0 关）。

**总判断：系统不需要新增任何能力；需要的是一批 Owner 决策（启用/退役/清理）与 2 个 P1 契约修复。**

---

## 2. Feature Flag Matrix

权威来源（单一 SSoT）：`packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts` 的 `DEFAULT_FEATURE_FLAGS`（47 条）。quiet flag 生命周期由 `feature-flag-lifecycle.ts`（PRI-610 census，contract test 强制覆盖）管理。读取路径统一为 `.pd/config.yaml` 的 `features` 段（`pd-config-feature-flags.ts`；旧 `.pd/feature-flags.yaml` 已废，ADR-0016）。

分类定义：**A**=活跃且正常（有真实门控消费者）；**B**=已完成但默认关闭；**C**=无可执行消费者（no-op/dead）；**D**=风险 flag。

### 2.1 分类 C —— 无可执行消费者（本次审计最重要发现）

| flag | 默认 | live | 声称的消费者 vs 实际 | 最近改动 | 状态 |
|-|-|-|-|-|-|
| `painEvidenceAdmission` | quiet/**on** | on（+legacy 别名 on） | lifecycle census 声称 hooks/pain.ts、llm.ts、gate-block-helper.ts；**实际全仓零可执行读取**（仅注释/CLI 提示文案） | 2026-08-27 | **C + P1**：no-op；Gate B（TriggerController）是无条件路径 |
| `painEvidenceAdmissionDefault` | quiet/**on** | on | 同上；注册描述承诺「OFF 时 Gate A 重激活」——**无任何代码读它做路由** | 2026-08-27 | **C + P1**：假 rollback 契约 |
| `internalization_core_grounding` | quiet/on | on | census 声称 internaliz*/runner；实际 `dreamer-runner.ts:95` 硬编码 `coreGrounding: true` 默认值，flag 零读取 | 2026-08-03 | C：功能已无条件化，flag 成死键 |
| `empathy_observer` | quiet/off | **on**（Owner 开了） | census 声称 "openclaw-plugin observer wiring"；实际唯一生产引用是 Console Control Center 的 UI 展示/开关渲染。empathy 关键词检测（`empathy-keyword-matcher`）不经此 flag、无条件运行；observer service 文件不存在 | 2026-06-12 | C：开关是安慰剂 |
| `diagnostician_split_pipeline` | quiet/on | on | PRI-638 P1-B cutover 后唯一消费者是 `pd-config-effective.ts:194` 的 legacy-false 兼容折叠（防升级静默激活）；不再选择任何管线 | 2026-06-12 | C：兼容 shim；census 条目已过期 |
| `evolution_worker` | quiet/off | off | worker 已被 PRI-737 删除；剩余引用全是元数据：surface-registry 2 条 `disabledReason`、enum-labels、lifecycle 过期条目（还声称 "heartbeat registration, quarantined"）、`index.ts` 注释自认待退役 | 2026-06-02 | C：死 flag 簇（见 §5 DC-1） |

**P1 说明（假 rollback 契约）**：`pain-diagnostic-gate-policy.ts` 头注自述「remains as the rollback path when flags are OFF」，且其归档处置（PRI-454 step 6）的解除条件——「双 flag 生产 ON 满 30 天 + 5 条 MVP 路径验证 Gate B」——2026-06 起算早已满足，但从未执行。当前现状：Gate A 模块永久滞留 + 两个 no-op flag + 一篇承诺不存在行为的文档。任何 AI 按 flag 描述做「关 flag 回滚」操作都会**以为**回滚了（实际行为不变）——这正是 §1「AI 开发误判复杂度来源」的活标本。

### 2.2 分类 B —— 已完成但默认关闭

| flag | 默认 | live | 完成度与真实消费者 | Owner 决策点 |
|-|-|-|-|-|
| `pain_diagnosis_persistence` | off | off | 链路完整已接线：`pain-signal-runtime-factory.ts:787`（持久化）+ `diag-rootcause-runner.ts:176`（Stage A prompt）。live 关 → `pain_diagnoses` 表 0 行（从未启用过） | 是否启用收集根因归因证据 |
| `codex_conversation_ingestion` | off | off | Slice A 已接线（pd-hook/codex-setup/health-codex + governance-observation-store）；默认关是隐私设计（flag-off = 零 transcript 读，test-spied） | Slices B-D + R1 consent 后是否 default-on |
| `abstraction_layer_v1` | off | off | 门是活的：`shouldUseSharedHostRuntime`（plugin index.ts:145，进程级缓存）选择 shared host-runtime vs legacy 路由。**默认 off = OpenClaw 生产走 legacy 路由** | parity 验证后 cutover 或放弃（census 退休条件二选一） |
| `rulecode_context_v2` | off | **on** | 消费者真实（`rule-host-writer.ts:828`、run-rulehost:172）。#1616（PRI-741）刚又加强 v2 面 | 验证后毕业 |
| `l2_dreamer` | off | off | 消费者真实（runtime-adapter-resolver + consumer-cycle） | 毕业或放弃 |
| `artifact_summary_redundancy` | off | **off** | 消费者真实（base-peer-runner + context-trace）。**live 配置矛盾**：closure profile 开了 L1+L2 却留 L0 关（设计毕业条件是三层一起验证） | 补齐 L0 或记录偏差 |
| `context_manifest_budget` | off | **on**（09-03 closure profile） | 同上真实 | 同上 |
| `progressive_evaluator` | off | **on**（09-03 closure profile） | 同上真实 | 同上 |
| `diagnostician_async_cli` | off | off | 消费者真实（pain-record.ts:354）；等 orchestrator | 毕业或放弃 |
| `signal_collector` | off | **on**（但 `internalAgents.agents.signalCollector.enabled=false`） | flag 门真实（signal-collector-host.ts:424）。**配置自相矛盾**：flag 开、agent 绑定关——LLM 深判断路径仍休眠 | 对齐两处开关 |
| `correction_observer` | off | **on** | 门真实（plugin index `shouldStartCorrectionObserver`）。live `correction_samples`=0（无匹配或休眠，证据不足以下结论） | 观察毕业窗口（census 已给 6 个月无激活退役线 2026-12-02） |
| `principle_receipt_self_report` | off | **on** | 消费者真实；live 已产出 12 条 self_reported ledger——**是「默认关但 live 验证有效」的正例** | 可考虑毕业 |
| `anonymous_product_telemetry` | off | **on**（Owner 09-04 显式开启） | consent granted + **09-11 导出成功**——三级门控（flag+consent+eligibility）端到端实证工作 | 毕业窗口观察 |
| `intent_engineering` | off | **on** | 消费者真实（4 处）；live `intent_decisions`=0（无 INTENT.md 场景触发过） | dogfood 验证 |

### 2.3 分类 A —— 活跃且正常（27 个，列身份即可）

Core（默认 on，不可省略禁用）：`prompt`、`code_tool_hook`、`defer_archive`（三者为 MVP channels，经 `enabledChannels` 消费）、`rulecode_safety_controls`、`rulecode_owner_live_decision`（runtime-activation + ActivationsConsoleModel 双消费）、`internalization_full_chain`、`code_rule_capability`、`host.codex`（flag 机制正常，但见 §4 Gap-6 运行时不可达）、`new_user_onboarding`。
Quiet-on：`internalization_auto_consumer`、`story_a_approval_completion`、`feedback_channel`、`release_manager_shadow`、`release_manager_write_authority`（→ D）、`diagnostician_core_grounding`、`diagnostician_llm_degradation`（消费者真实 base-peer-runner:1012；**live 被 Owner 显式关闭**，走 legacy 硬失败路径——机制正常，决策需复核）、`failed_tasks_observability`、`evaluator_artificer_repair_loop`、`artificer_output_retry`、`principle_receipt_block_copy`（**live 被 Owner 关闭**）、`principle_receipt_ledger`、`principle_governance_projection_v2`、`failed_task_recovery_console`、`governance_experience_v1`。
Gone：`nocturnal`、`idle_trigger`（行为性消费者为零；`idle_trigger` 在 `proven-channel-baseline.ts:141` 只是 legacy 文本探测关键词）。

### 2.4 分类 D —— 风险 flag

- `release_manager_write_authority`（quiet/on）：默认开启的更新写权威。注意其有效性**依赖环境**：需 `PD_RELEASE_METADATA_URL` 且管线发布 artifact target，否则逐请求回退 legacy（`release_manager_refused_pre_transaction:<reason>`）。live transactions 目录显示 console-apply-full 已在实际使用。风险不在 flag 本身，在于「默认 on + 环境依赖」的组合容易被误判为已全面接管。
- `diagnostician_llm_degradation`（live=off）：Owner 关闭了已毕业 flag，当前生产走 rate-limit 硬失败。若非有意，属配置事故。

---

## 3. Runtime Capability Matrix

live workspace = `D:\.openclaw\workspace`（`~/.pd/install.json` 唯一注册 workspace；插件 1.235.0；Console 18800 端口在听；日志/应用更新至 09-11）。

| Capability | 代码存在？ | flag enabled？ | runtime 可达？ | 真实数据产生？ | 证据 |
|-|-|-|-|-|-|
| Pain 捕捉 | ✅ | ✅（默认路径） | ✅ OpenClaw + pd-cli | ✅ 13 events（openclaw 7 + 无 host 6），101 pain_detected / 16 pain_recorded；origin：user_manual 12 / system_infer 1 | trajectory.db，最近 09-11 |
| Pain 入口自动化 | ✅ | ✅ | ⚠️ 弱 | ⚠️ 12/13 是手动录入 | 自动捕捉面几乎未产出 |
| Diagnosis（split 三段） | ✅ | ✅（live on） | ✅（agents 全绑定 flatkey-ds） | ✅ 198 tasks：168 succeeded / 25 failed（多为 evaluator input_invalid、max_attempts_exceeded，最近 09-09）/ 2 NHR（rollout_reviewer，09-01 起） | state.db tasks |
| pain_diagnoses 持久化 | ✅ | ❌（flag off） | ❌ | ❌ 0 行 | pain_diagnosis_persistence 从未启用 |
| Candidate | ✅ | ✅ | ✅ | ✅ 42（29 consumed / **13 pending 自 09-05**） | state.db principle_candidates |
| Approval | ✅ | ✅ | ✅ | ⚠️ approvals=0、activation_decisions=0（队列空；历史经 consumed 走完） | state.db |
| Activation | ✅ | ✅ | ✅ | ⚠️ **累计 1 条**（09-01，prompt 通道）；activation_control_states 空 | state.db activations |
| 注入（prompt 注入面） | ✅ | ✅ | ✅ | ✅ 173 次 prompt_injected——**100% 来自唯一 principle** | principle_applications |
| RuleHost 拦截 | ✅ | ✅（code_tool_hook core on） | ✅ 已布防 | ❌ **gate_blocks=0、rule_blocked=0、auto_correct=0**——从未拦截过 | trajectory.db + ledger |
| Receipt ledger | ✅ | ✅（live on） | ✅ | ✅ 185 行（173 injected + 12 self_reported），最近 09-11 17:01 | state.db |
| Console governance | ✅ | ✅（governance_experience_v1、failed_task_recovery_console on） | ✅（:18800 LISTENING，pid 38508） | ✅ 更新史 1.227→1.235 全经 console 链 | ~/.pd/transactions + update-history.json |
| Codex host | ✅ | ✅（host.codex on） | ❌ **未安装**：`~/.codex/config.toml` 无 PD hook、`~/.codex/hooks/` 空、workspace 无 `host-tool-semantics/codex.json`、pain host_kind 无 codex | ❌ | 只读核查 09-12 |
| Evolution worker | ❌ 已删（PRI-737） | flag 残留 | ❌ | ❌ evolution_events/tasks=0；孤儿 json 残留 | 见 §5 DC-1 |
| 匿名产品遥测 | ✅ | ✅（live 显式开） | ✅ | ✅ 09-11 导出成功 | ~/.pd/product-telemetry.json |

**矩阵一句话**：从 pain 到「principle 被注入并自证」的半环是真实、新鲜、有数据的；从「审查 → 激活 → 拦截行为 → 效果级 receipt」的另外半环在生产上接近空转。这不是缺陷爆发，而是 MVP 闭环尚未被 Owner 输入喂满的形态——但它是「AI 误判复杂度」的最大来源：代码、flag、registry 全部声称这些面存在。

---

## 4. Reality Gap List（代码默认 vs 真实配置/运行）

| # | Gap | 严重度 | 说明 |
|-|-|-|-|
| G-1 | 假 rollback 契约（painEvidenceAdmission* 双 flag） | **P1** | 见 §2.1。flag 描述、模块头注、census 三处文档均描述不存在的路由行为 |
| G-2 | live 关闭了已毕业 flag `diagnostician_llm_degradation` | **P1**（若非有意） | 生产 rate-limit 走硬失败；与 PRI-571 毕业决策矛盾，需 Owner 确认是否有意 |
| G-3 | progressive disclosure L1+L2 on / L0 off | P2 | 违反设计的分层验证前提（census 毕业条件=三层一起）；closure profile 注释自称可回滚（docs/pipeline-closure/closure-profile.md） |
| G-4 | `signal_collector` flag on 但 agent 绑定 off | P2 | 同一能力两个开关状态相反；LLM 深判断实际休眠 |
| G-5 | `empathy_observer` live on 但为安慰剂开关 | P2 | Owner 以为开了一个观测器，实际无行为（§2.1） |
| G-6 | `host.codex` on 但 Codex 集成未安装 | P2 | flag 声称的能力在 live 不可达；无 codex.json 声明、无 hook |
| G-7 | 未知 flag 键 `model_training`、`trainer`（gone） | P3 | 不在注册表，每次加载产 "unknown flag ignored" warning；历史残留 |
| G-8 | live 配置 `code_rule_capability: category: quiet` | P3 | 类别漂移；F14-1 保证注册表类别权威，无行为影响，纯噪音 |
| G-9 | legacy 别名与 canonical 并存（`pain_evidence_admission_default` + `painEvidenceAdmissionDefault`） | P3 | PRI-609 归一化处理正常（同值无警告），可清理 |
| G-10 | live workspace 内 3 个 config .bak + state.db.bak（09-03） | P3 | 数据残留；按 §18 走归档而非直接删 |
| G-11 | telemetry `workspaceExports` 两个 hash，一个 09-04 后停更 | P3 | 疑似旧 workspace 残留 hash，无生产影响 |
| G-12 | surface-registry 与 flag 注册表矛盾（`service:correction-observer`/`startup:correction-observer` 标 core/enabledByDefault=true，flag 实为 quiet/off 决定启动） | P3 | surface guard 日志会声称 core surface 已启用，与真实门控不一致，误导诊断 |

---

## 5. 删除候选排序（仅列证据，**不在本工单删除**）

排序依据：误判风险 × 残留量 × 证据完备度。每项给出 producer/consumer/runtime 三证。

| # | 候选 | Producer | Consumer | Runtime 证据 | 建议 |
|-|-|-|-|-|-|
| DC-1 | `evolution_worker` flag + surface-registry `service/startup:evolution-worker` 条目 + lifecycle 过期条目 | 0（worker 已删，PRI-737） | 0 可执行（仅元数据自指） | live：flag=off、evolution_events/tasks=0；代码注释自认待退役 | **最高优先**。一个 PR 内：删 flag + 2 registry 条目 + census 条目（需 contract test 同步） |
| DC-2 | live `.state/evolution_queue.json`、`evolution-scorecard.json` | 0（全仓唯一 writer 是测试 fixture） | 0 生产 reader | live 存在但无人写读 | 归档（§18：preservation first，移入 legacy-archive/ 或备份后删） |
| DC-3 | `painEvidenceAdmission` + `painEvidenceAdmissionDefault` flag + Gate A 归档模块（`pain-gate/pain-diagnostic-gate-policy.ts` + plugin adapter）+ 2026-06 track doc | 0 | 0 可执行 | live 从未 flag-off 过；PRI-454 解除条件早已满足 | Owner 决策后按 track doc 的既定退出程序执行；**先修文档再删码** |
| DC-4 | `internalization_core_grounding` flag | 0（runner 默认值已硬编码 true） | 0 | live on 但无行为 | 删 flag + census 条目 |
| DC-5 | `empathy_observer` flag（或反向：实现 observer） | 0 | 仅 Console UI 渲染 | live on、零行为 | Owner 二选一：删 flag，或立项真 observer（当前状态最差——看起来开着） |
| DC-6 | `diagnostician_split_pipeline` flag + PRI-638 折叠 shim | 1（effective-config 兼容层） | 升级安全（防静默激活） | live=true（可安全摘除该键） | 保留 shim 至确认存量 workspace 无 legacy-false 后移除；live 键可清 |
| DC-7 | live config 未知键 `model_training`/`trainer` + legacy 别名键 + category 漂移 | — | 0（加载时 warning+忽略） | 每次加载产生噪音 warning | 低风险配置清理 PR |
| DC-8 | `scripts/nocturnal/`（整目录）+ `scripts/pipeline-health.ts` 中 nocturnal 引用 | 0 生产 | dev-script 自身 | gone flag 对应实现 | 随 MVP-Gone 清理批处理；低优先 |
| DC-9 | 隐藏 CLI 组 `pd evolution tasks/list/show`（读 evolution_tasks 表） | 表 producer 已死 | 0 数据（0 行） | live 0 行 | 随 DC-1 同批评估；hidden 不产生误判，优先级低 |
| DC-10 | live workspace `*.bak-*` 文件（config×3 + state.db 三件套） | — | — | 09-03 Gate B 毕业备份 | 按备份策略归档；勿直接删（§18） |

明确**不是**候选（扫描中排除，防误删）：`story-a-demo`/`golden-trace`（PRI-730 已证为生产组件）、`workspace-guidance-migration`（活行为，PRI-730 已移交 Owner 决策）、`dead_letter_pains`/`evolution_events` 空表结构（管线契约表，producer 存在）。

---

## 6. 禁止修改区域

1. **安装面**（AGENTS §1.1 硬规则）：`~/.pd/runtime/**`、`~/.openclaw/extensions/principles-disciple/**`、live workspace `.pd/**` 与 `.state/**`。本次审计全程只读（`sqlite3 -readonly`、无写操作）。变更安装行为的唯一路径：改仓库 → 重构建 → installer 发布。
2. **主 checkout 暂存工作**：`D:\Code\principles` 当前有他人暂存的 42+ 文件（与 origin/main 的 42 文件差异无关）。本报告以 untracked 文件落盘，未触碰任何已跟踪/暂存状态。
3. **Gate A 归档模块**：处置权在 PRI-454 既定程序 + Owner，不得顺手删。
4. **lifecycle census 与 flag 注册表**：受 contract test 强制（"feature purgatory = 0"），任何增删必须同步 census，本报告的建议均已按此标注。
5. **PRI-730 已裁决项**：runtime-selector（已删）、workspace-guidance-migration（待 Owner）、story-a-demo（保留）——不重复立项。

---

## 7. 下一步建议（全部等 Owner 决策，本工单到此停止）

按影响排序：

1. **P1 决策：假 rollback 契约处置**（G-1/DC-3）。三选一：(a) 执行 PRI-454 既定退出（删 2 flag + Gate A 模块，同步文档）；(b) 把回滚路由真的接上；(c) 仅修文档声明 Gate B 不可回退。推荐 (a)——解除条件早已满足。
2. **P1 复核：`diagnostician_llm_degradation` live=off 是否有意**（G-2）。若无意，一条 config 改动恢复毕业行为。
3. **P2 批准 DC-1+DC-2 清理 PR**：evolution_worker flag 簇 + 孤儿数据归档（PRI-737 未竟的 "separate change"）。
4. **P2 对齐双开关**：signal_collector flag↔agent 绑定（G-4）；progressive disclosure L0 补齐或记录偏差（G-3）。
5. **P3 配置卫生 PR**：未知键/别名/类别漂移/备份归档（G-7~G-10，DC-7/DC-10）。
6. **战略层输入**（无需行动，供路线判断）：RuleHost 零拦截 + 单 principle 现状意味着「内化→拦截」的价值主张尚未在生产被检验过；13 个 pending 候选是现成的 Owner 审查队列，比任何新能力都更接近产品验证。

---

### 附：审计证据快照

- 基线：`4dce7d942`（origin/main，2026-09-12 fetch）；审计树 `D:/pd-labs/pri749-audit-tree`（detached，已用毕待清）。
- live 安装：plugin 1.235.0（09-11 更新，update-history 全链 success）；owner registered 2026-08-29；consent granted；Console :18800 LISTENING。
- DB 计数（09-12 采集）：pain_events 13 / tool_calls 4786 / gate_blocks 0 / principle_events 117 / principle_candidates 42（13 pending）/ activations 1 / approvals 0 / principle_applications 185（173 injected + 12 self_reported）/ pain_diagnoses 0 / tasks 198（168/25/2NHR/1pending/2retry）/ evolution_events 0 / evolution_tasks 0 / dead_letter_pains 0 / intent_decisions 0。
- flag 总账：注册 47（core 9 / quiet 36 / gone 2）；census 36/36 quiet 全覆盖；可执行消费者为零者 6（§2.1 前 5 + gone 的行为性消费者为零）。
