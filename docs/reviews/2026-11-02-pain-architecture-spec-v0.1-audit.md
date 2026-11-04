# SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.1 独立架构审查报告

**日期:** 2026-11-02
**性质:** 只读架构审查 / SPEC 证伪尝试
**被审对象:** `docs/archive/specs/SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001-v0.1.md`（未跟踪文件，未入库）
**审查基线:** `main@457bbf0fcd8df85c069b78ce60858acf742fe970`（== `origin/main`，同基线）
**方法:** 5 个并行子代理沿真实源码调用链调查（OpenClaw 管线 / Codex+WorkBuddy 采集链 / 队列与准入 / 旧机制依赖普查 / 外部宿主源码与运行环境），全部结论要求 文件:行号 证据。
**证据等级约定:** Static = 源码静态证据；Test = 测试钉住；Runtime = 真实工作区只读检查（`D:\.openclaw\workspace\.pd\`）；Deployment = 安装目录只读检查。无法验证标 UNVERIFIED。

---

## Part 1 — Executive Verdict

**结论：READY_WITH_REQUIRED_CHANGES。**

总体方向（Pain=Owner 相关行为偏差、错误≠Pain、复用 OpenClaw 两阶段检测、删除旧机制、不建新架构）与仓库现实兼容，且大量"复用现有能力"的主张属实。但以下三个问题必须在实施前修订 SPEC，否则会造成能力退化或建立在错误前提上的设计：

1. **跨宿主共享确认队列的前提不成立**（§4.3/§7）。三宿主默认使用**不同 workspace、不同 `trajectory.db`**（`install-layout/src/index.ts:243-249`、`codex-adapter/src/pd-hook.ts:233-243`、`openclaw-plugin/src/core/workspace-context.ts:218-228`），单宿主库内 `host_kind` 无区分意义；真正的阻塞是 `signal_confirmations.user_turn_rowid INTEGER NOT NULL UNIQUE` 绑定 OpenClaw 专属 `user_turns` 行，且生产者/消费者代码都在 openclaw-plugin 包内。"只加一个 host_kind 字段"低估了变更面。
2. **高精度直通 + 子串匹配 + 学习闭环自动扩充 = 误报链，SPEC 不仅未修，反而要拆掉 WorkBuddy 唯一防线**（§3.2）。`scanKeywords` 是纯子串 `includes`（`principles-core/src/runtime-v2/signal-collector/keyword-stage.ts:31`），高精度词表含日常口语（`host-runtime/src/governance-signal-admission.ts:113-124`），学习词 TP≥3/FP=0 自动升 high 直通（同文件:167-179），confidence 无门控。SPEC 假设"防引用/转述误报由共享检测路径统一处理"——**共享路径没有任何防护**。去掉 WorkBuddy `startsWith` 前缀过滤（`governance-signal-admission.ts:1078`）前必须先在 core 建立统一的引用/位置防护。
3. **Phase A 先删后建存在检测真空**（§9）。Tool Failure Pain 是 Codex/WorkBuddy **当前唯一自动 Pain 源**（`host-runtime/src/production-pain-evidence.ts:613-621`）；`evidence-triage` 同时是手动 `/pd-pain` 的准入门（`openclaw-plugin/src/hooks/pain.ts:573-598`）。先删它们、后落 Phase B，两宿主将只剩显式 Owner Statement。

---

## Part 2 — Assumption Ledger

| ID | SPEC 假设（§） | 证据 | Status | Impact | Recommendation |
|---|---|---|---|---|---|
| A1 | 共享检测核心在 `runtime-v2/signal-collector/`，含 `scanKeywords`/`buildLlmPrompt`/`mapLlmResultToOutput`（§3.1） | keyword-stage.ts:21；core/signal-collector.ts:23,64 | VERIFIED | — | — |
| A2 | `SignalLlmClassifier`/`PiAiRuntimeAdapter` 属于该核心（§3.3） | `SignalLlmClassifier` 在 openclaw-plugin/signal-collector-host.ts:147,774；`PiAiRuntimeAdapter` 在 runtime-v2/adapter/ | PARTIALLY_VERIFIED | 共享分类器需先下沉（见 F4） | 明确下沉目标为 host-runtime |
| A3 | Stage 1 三分支（high→直接准入 / ambiguous→Stage2 / no-match→发现预算）（§3.2） | host:241-253,277,478-488（discovery 6/h） | VERIFIED | high 直通无确认环节（见 F3） | SPEC 应写明直通风险与防护前提 |
| A4 | Stage 2 现输出含 EMPATHY/WEAK/SEMANTIC_CONFUSION/PARALYSIS，要删（§3.3） | types.ts:89-104（实际枚举 `correction\|empathy\|none`）；llm-stage.ts:14-25；host:331-348 | PARTIALLY_VERIFIED | SEMANTIC_CONFUSION 枚举全库不存在；这是**代码变更**不是开关 | §3.3 改写为"契约变更清单" |
| A5 | `discoveryRateLimitPerHour` 存在（§3.4） | host:65,478-488 = 6/h | VERIFIED | — | — |
| A6 | 歧义候选可进持久化确认队列（§3.4） | queue 存在（trajectory-schema.ts:98），但消费者 `correction_observer` **默认 OFF**（feature-flag-contract.ts:194）；Runtime：15 行、09-28 后零新增、confirmed 仅 2 | PARTIALLY_VERIFIED | 队列在生产实质停摆 | 见 Owner 决策 D3 |
| A7 | 同步 Hook 不被 LLM 阻塞（§3.4） | OpenClaw fire-and-forget host:277；Codex 5s 无 LLM（pd-hook.ts:195, SYNC_DETECTION_CONFIG enableLlmStage:false）；WB 12s 自杀线（wrapper.cjs:55-61） | VERIFIED | — | — |
| A8 | WEAK→GFI 分流、GFI 阈值触发活跃（§4.1/§6） | host:718-730；llm.ts:298-307 | VERIFIED（活跃但诊断已被 triage 阻断，仅写无用 pain_events 行；Runtime 见 19 行 llm_paralysis） | 收益=停写无用行 | §6 区分"停写"与"删触发" |
| A9 | Empathy Inferred 自动 Pain 分流活跃（§6） | `empathy_inferred` 生产不可达：`buildEmpathyObservation` 全仓零调用；source-descriptors.ts:99 owner_confirm 不可达 | **CONTRADICTED** | 已是死代码，删除无收益（无害） | §6 修正该行 |
| A10 | Tool Failure / Repeated / RuleHost Block 自动 Pain 存在（§6） | after-tool-call-helpers.ts:406-533；ppe:613-621；gate-block-helper.ts:198-275（仅 OpenClaw 旧路由） | VERIFIED（RuleHost Block 仅 OpenClaw；Repeated 在 Codex transcript 路径本就不生效 gsa:870 不传参） | 见 F2/F7 | 按路径拆分删除 |
| A11 | Fatal Intercept Pain 存在（§6） | lifecycle.ts:98-103,152-168：painType 伪装 `tool_failure`、score 100、**绕过 triage 直通诊断** | VERIFIED（比 SPEC 描述更严重） | 当前最恶劣的活跃自动 Pain | 优先级提前，见 F-P0 补充 |
| A12 | Codex 只依赖 high-precision 关键词、无 LLM 纠正检测（§4.2） | gsa:746,766-775 仅 `STRONG && high` 准入 | VERIFIED | — | — |
| A13 | `codex_conversation_ingestion` 默认关、不扩大授权（§4.2） | feature-flag-contract.ts:405；Runtime：config.yaml 未显式、governance_* 全 0 行 | VERIFIED | 摄入三缺口见 F6 | 开启前先修缺口 |
| A14 | WB 15s 同步 Hook 不能等 LLM（§4.3） | hooks.json timeout:15 + wrapper 12s 自杀线 | VERIFIED | — | — |
| A15 | WB 无前置 Assistant Turn / 无 Transcript（§4.3） | WB 零 transcript、不写 user_turns（hr/index.ts:277） | VERIFIED | — | — |
| A16 | `host.workbuddy`/`workbuddy_live_keyword_pain` 默认关（§4.3） | feature-flag-contract.ts:339,404；Runtime config 未显式 | VERIFIED | — | — |
| A17 | 队列跨宿主共享只需加 `host_kind`（§4.3/§7） | 三宿主**不共享 DB**（install-layout:243-249 等）；`user_turn_rowid NOT NULL UNIQUE` 绑 OpenClaw rowid；生产/消费在 openclaw-plugin | **CONTRADICTED** | §4.3/§7 设计前提错误 | 见 F1 |
| A18 | WB Worker 现有能力可消费待确认记录（§4.3） | WB worker 仅 reconcile/bare-sweep/diagnose 三步（workbuddy-adapter/src/worker/workspace-worker.ts:170-215），无队列消费逻辑 | **CONTRADICTED** | 需新增 worker 步骤（实质新职责） | §4.3 明示 |
| A19 | PainIngress（OpenClaw/CLI）与 governance-signal-admission（Codex/WB）两套准入分工明确（§5.1） | PainIngress 是纯函数语义层（pain-ingress.ts:21-23）；Codex/WB `ensureGovernanceDiagnosticianTask` **硬编码** `provenance:'host_context_bound'`（gsa:1269），不经 PainIngress | PARTIALLY_VERIFIED | §4.4"同一 Pain 语义"当前未达成 | 见 F5 |
| A20 | evidence-triage 只服务旧 Pain 来源、可整体删除（§6.2） | 生产调用点 8 处，含手动 `/pd-pain` 准入（pain.ts:573-598）与 Codex/WB tool-failure（ppe:613-621、gsa:870-871） | **CONTRADICTED** | 整删将切断手动 Pain 准入 | 先迁移再删，见 F2 |
| A21 | admission-gate 与 TriggerController 职责不同、应保留 admission-gate（§6.2） | admission-gate=诊断后门（admission-gate.ts:50）；TriggerController=诊断前（triage+cooldown） | VERIFIED | — | — |
| A22 | GFI 核查 RuleCode 依赖后可全量删除（§6.3） | 内置 RuleCode 读 `currentGfi`：**零**（唯一命中是 code-validator.ts:24 校验 fixture）；但 Owner 健康观测面活跃（`/pd-pain` pain.ts:139-226、Console HealthCheckModel.ts:277-320、CLI pd-cli/src/index.ts:781）；`tool_calls.gfi_before/after` 在 REQUIRED_COLUMNS（ppe:319） | PARTIALLY_VERIFIED | 外部部署规则 UNVERIFIED | 见 F8/D4 |
| A23 | 代码基线 `main@457bbf0fcd8d85c…`（头部） | 实际 HEAD `457bbf0fcd8df85c…`（SPEC 字符串少一个 `f`，39 位） | **CONTRADICTED**（笔误） | 基线引用不可解析 | 修正 SHA |
| A24 | "不新增 Worker/队列/flag/表"约束可行（§7） | 分类器工厂下沉 host-runtime 即可复用（core 已有 agent binding，pd-config-agent-binding.ts:156,250）；WB worker 加一个消费步骤不算新 Worker | PARTIALLY_VERIFIED | 可行但 §4.3 需如实声明新职责 | 修订表述 |

---

## Part 3 — Critical Findings

### P0

**F-P0-1 队列跨宿主共享前提不成立（§4.3/§7.5）**
- 现象：SPEC 提出"只允许在现有 `signal_confirmations` 表增加 `host_kind` 字段"实现跨宿主共享队列。
- 现实：三宿主 workspace 不同 → `trajectory.db` 不同（Static：`install-layout/src/index.ts:248-249`"never auto-reused"、`codex-adapter/src/pd-hook.ts:233-243`、`openclaw-plugin/src/core/workspace-context.ts:218-228`）。单宿主库内 `host_kind` 无意义。真正阻塞：`user_turn_rowid INTEGER NOT NULL UNIQUE`（`trajectory-schema.ts:98`）要求 OpenClaw 专属 `user_turns` rowid，而 Codex/WB **从不写 user_turns**（`host-runtime/src/index.ts:277`）；id 由 `sha256(sessionId:userTurnRowid)` 派生（`openclaw-plugin/src/core/trajectory.ts:1350-1357`）；生产者（signal-collector-host.ts:423）与消费者（correction-observer-service.ts:84-161）都在 openclaw-plugin 包内，Codex/WB 禁止依赖该包（codex-adapter/src/pd-hook.ts:56）。
- 影响：按 SPEC 实施会在错误前提上做 schema 变更，仍无法跨宿主。
- 建议：改为"每宿主在**自己库内**持久化待确认候选 + 各自 Worker 消费"；OpenClaw 的 `signal_confirmations` 保持原样不动。Codex/WB 的候选持久化载体需 Owner 在 D3/D5 选型（倾向复用各自已有表加状态，而非改 OpenClaw 专属契约表）。

**F-P0-2 Phase A 先删后建 = Codex/WorkBuddy 检测真空 + 手动 Pain 断链（§9）**
- 现象：Phase A 先删"工具失败自动 Pain 准入"与 evidence-triage，Phase B 才接入共享检测。
- 现实：① Tool Failure Pain 是 Codex/WB 当前唯一自动 Pain 源（ppe:613-621；WB 还有裸 Pain 补扫 `admitBareHostPains`，gsa:1462-1565，删除时须同步删 WB worker:177 的依赖与报告字段）；② evidence-triage 当前是手动 `/pd-pain` 的必经准入门（pain.ts:573-598，`isOwnerManual:true`），不是"只服务旧来源"。
- 影响：两阶段之间，两宿主只剩显式 Owner Statement；手动报告若迁移不当直接失效。
- 建议：Phase B（共享检测上线并通过验收）先于 Phase A 的这两项删除；或将 Phase A 拆为 A1（纯停写：semantic/gfi/paralysis 行、fatal intercept、empathy 死代码）与 A2（能力替换型删除：tool-failure、evidence-triage 收缩），A2 以 B 验收为前置。

**F-P0-3 高精度直通误报链，且 SPEC 要拆掉最后防线（§3.2）**
- 现象：high 命中 → STRONG 同步直通准入，`needsLlmConfirmation=false`（core/signal-collector.ts:34-45），无确认环节；唯一闸门是 5/h/session 限流 + canonical id 去重（host:736-749）。
- 误报链：子串 `includes` 匹配（keyword-stage.ts:31，引用/转述即命中）× 高频口语词表（gsa:113-124："我说的是""都说了""谁让你""又搞错"）× 学习闭环 TP≥3 且 FP=0 自动升 high 直通词表（gsa:167-179）× confidence 无门控（测试钉死 "low confidence still → STRONG"）。
- SPEC 风险：§3.2 认可"High precision → 直接进入纠正信号准入"，同时主张 WorkBuddy `startsWith` 防线（gsa:1078）"由共享检测路径统一处理"——共享路径无任何引用/位置防护，去掉 startsWith 后 WB 退化为 Codex 现状（"他说这是错的"即 STRONG）。
- 建议：在 core 增加统一防护（引用剥离/引号内不命中/句中位置权重）作为移除 startsWith 的**前置条件**写入 SPEC；并将"学习词自动升级直通"加置信度或确认门。

### P1

**F-P1-4 Stage 2 二分契约是代码变更，非现状（§3.3）**
- 现契约 `{is_feedback, type: correction|empathy|none, confidence, reason}`（signal-collector/src/types.ts:89-104；TypeBox schema :113-119）。`mapLlmResultToOutput` 忽略 confidence（core/signal-collector.ts:64-94）；被纠正 assistant turn 锚定靠宿主层 `referencesAssistantTurnId`（host:207、prompt.ts:306-315）——Codex/WB worker 路径无此信息。SPEC 列出的 SEMANTIC_CONFUSION 枚举全库不存在（等价物是 P_CONFUSION_ZH/EN 字典规则，dictionary.ts:26-52）。
- 影响：CORRECTION/NONE 二分需要改 prompt（llm-stage.ts:14-25）+ schema + 映射 + empathy 歧义降级路径（host:331-348）。SPEC"复用现有"表述掩盖了变更面。
- 建议：§3.3 列出明确契约变更清单；保留 reason 等原始字段供 Diagnostician，不必新增复杂模型。

**F-P1-5 Codex/WorkBuddy 缺 PainIngress 语义层，"同一 Pain 语义"未达成（§4.4/§5.1）**
- `ensureGovernanceDiagnosticianTask` 硬编码 `provenance:'host_context_bound'`（gsa:1269），不传 painIngress；桥接端走 legacy payload 分支（pain-signal-bridge.ts:377-382）。
- 建议：在 gsa 内从 marker payload 构造 `PainIngressReport` 并调 `evaluatePainIngress`（Connection Before Creation），而非新增第三套准入。这同时消除 SPEC §5.1 承认的 WB 实现差异的主干。

**F-P1-6 Codex transcript 增量摄入三个硬缺口（§4.2）**
- ① revert 会话文件名 `rollout-<ts>-<thread>_<rollout>.jsonl`（codex-rs rollout/recorder.rs:101-103、rollout_file_name.rs:44-48）与 PD 解析器"按 `-` 切末 5 段校验 UUID"（host-runtime/src/codex-transcript-locate.ts:34-44）不兼容 → `transcript_path_invalid`；② 压缩归档 `.jsonl.zst`（compression.rs:26,63,93）PD 只认 `.jsonl`；③ 新会话 rollout 延迟建档（recorder.rs:900-903），SessionStart 时路径可能不存在。
- 影响：开启 `codex_conversation_ingestion` 后 catch-up 会**静默漏数据**（违反 rc-9 no-silent-fallback）。SPEC §4.2 依赖该机制"处理待确认纠正"。
- 建议：SPEC §4.2 增加前置修复项；打开 flag 前必须修 ①②。

**F-P1-7 `canUpgrade=false` 不阻断升级——SPEC §6 的删除描述建立在错误策略理解上**
- `triage-policy.ts:155-158`：`upgradeable = canUpgrade || isRisky!==undefined || consecutiveErrors!==undefined`；Rule2/Rule3 对任何 evidence_only 来源生效（注释 :149-154 自认）。三条生产 tool_failure 路径全传布尔 `isRisky`（after-tool-call-helpers.ts:194,487；ppe:593,613；gsa:868,870）→ `tool_failure.canUpgrade:false` 从未生效。测试 `triage-policy.test.ts:421-426` 未传升级标志，名不副实。
- 影响：删除自动 Pain 必须按真实调用链（Rule2 isRisky、Rule3 consecutiveErrors≥4）逐路径处理，不能只删 Rule1/descriptor。
- 建议：SPEC §6 增补"按调用链删除"清单；顺带修正 source-descriptors.ts:29-34 的误导性文档。

**F-P1-8 GFI 全量退役范围过宽（§6.3）**
- GFI 现状："不再用于 Pain（triage 阻断）+ 不再影响宿主决策（内置 RuleCode 读 `currentGfi` 为零；态度注入已于 PRI-291 删除 prompt.ts:429-431），但仍是 Owner 健康观测面"：`/pd-pain` GFI 条（oc/commands/pain.ts:139-226）、Console "GFI 健康度"（pd-console HealthCheckModel.ts:277-320）、CLI `pd runtime gfi`/snapshot/canary/diagnostics-export、operator-health-read-model.ts:178-192。`tool_calls.gfi_before/after` 参与 `REQUIRED_COLUMNS` schema 校验（ppe:319）；session-tracker 同时持有 receipt 链依赖状态（session-tracker.ts:434-484），只能删 GFI 字段不能删 tracker。
- UNVERIFIED：已部署用户自定义 RuleCode 是否读 `input.session.currentGfi`。
- 建议：Phase C 边界改为"删 Pain 路径 + 停写 + 列保留停用"；健康观测面与外部规则核查独立成 Owner 决策（D2/D4）。

### P2

- **F-P2-9** 双准入内部三段近乎逐行重复：tool-failure 评分（gsa:853-872 ≈ ppe:585-621）、去重探针 SQL（gsa:887-899 ≈ ppe:652-668）、pain_events INSERT（gsa:909-910 ≈ ppe:681-682）；另有两套独立冷却 Map（trigger-cooldown-tracker.ts 与 ppe:610-612,685-695）。退役 tool-failure 后可顺带合并。
- **F-P2-10** `evidence-triage/admission-events.ts` 全部工厂函数 269 行生产零调用；`buildEmpathyObservation`/`buildLlmDetectionObservation` 零调用。可独立于本 SPEC 安全删除。
- **F-P2-11** 无用 pain_events 行仍在生产写入：llm.ts:323-331 在 triage 判 evidence_only **之前**已写行；Runtime 证据：`pain_events` 101 行中 llm_paralysis 19 行（最新 10-30）。SPEC 收益真实，但 §6 应写明对 semantic/gfi/paralysis 的动作实质是"停止写行 + 删触发代码"。
- **F-P2-12** 同义双 flag 键 `painEvidenceAdmissionDefault` 与 `pain_evidence_admission_default` 并存于生产 config.yaml（单一真相隐患，P4 级）。
- **F-P2-13** `signal_confirmations` 生产停摆：15 行（confirmed 2 / rejected 7 / abandoned 6），09-28 后零新增；消费者 flag `correction_observer` 默认 OFF。歧义候选确认路径事实上 Owner 从未消费。
- **F-P2-14** `PiAiRuntimeAdapter` 建在 pi-ai 的**临时兼容层**上：pin 1.2.0，`@earendil-works/pi-ai/compat` 头部明示"Temporary compatibility entrypoint… deleted with the coding-agent ModelManager migration"（pi-mono packages/ai/src/compat.ts:1-11），`getModel` 已 @deprecated（:64-65）。适配器头注释仍写"0.84.2"（漂移）。应登记向 `createModels()` 迁移。
- **F-P2-15** Codex promotion 证据死写：`governance_observations.retention_class='promoted'` 无任何 Diagnostician 读取者（生产 0 行）。SPEC §4.2 保留 promotion 前应补 reader 或承认无价值。
- **F-P2-16** §6 表格两处与现实不符：Semantic Confusion 行混淆两机制（lifecycle.ts:111-117 的 `[SEMANTIC CONFUSION]` 从不发 Pain，只写 memory/*.md；真正写行的是 llm.ts:248-260）；Empathy 行见 A9（已死）。

### P3

- **F-P3-17** 文档/元数据漂移：SPEC 基线 SHA 笔误（A23）；adapter 头注释版本漂移；`AGENTS.md §1.1` 称插件 core 为 symlink，实际 `~/.openclaw/extensions/principles-disciple/` 是全量拷贝（Deployment 证据：零 reparse point，bundle 与 `~/.pd/runtime` 字节相同）。
- **F-P3-18** 运行环境信号：安装版 `~/.pd/active.json` productVersion 2.8.0@0ff5f9f03，落后 main 4 个 PR（principles-core 1.298.1 vs 1.298.2）；`~/.openclaw/principles-disciple.json` 将 workspace 指向 `C:\Users\Administrator\.codex\pd-workspace` 而非 `D:\.openclaw\workspace`（运行时影响 UNVERIFIED）。
- **F-P3-19** Hook 超时模型不对称：OpenClaw 侧 PD 自设 10s fail-open（before_reset 两侧均无超时=无界）；Codex 侧宿主硬 5s、同步阻塞、每事件 Node 冷启动；且宿主将 `before_tool_call` 设为 **fail-closed**（openclaw plugins/hook-runner-global.ts:44-48）——"PD 永不阻塞主代理"在该 hook 不成立。SPEC 应按"5s 内必须返回、重活归 Worker"建模。

---

## Part 4 — Current Architecture Map（真实三宿主 Pain 采集流程）

### OpenClaw（生产默认路径 = 旧路由，`abstraction_layer_v1` 默认 OFF，feature-flag-contract.ts:340）

```
用户消息 → before_prompt_build (prompt.ts:282, isUserInteractionTrigger host:75,
  runId 去重 :379-394)
  ├─ Stage 1 detectSync (host:203) → scanKeywords 子串匹配 (keyword-stage.ts:31)  [同步]
  │   ├─ high → STRONG 直通 routeStrong (host:241-253) → 限流5/h (host:736-749)
  │   │     → canonical_pain_id 去重 (trajectory-schema.ts:174)
  │   │     → emitPainDetectedEvent (pain.ts:128) → PainIngress (pain.ts:166)
  │   │     → PainToPrincipleService.recordPain autoIntake (pain.ts:113,239)
  │   │     失败→ dead_letter_pains (pain.ts:283-300)
  │   ├─ ambiguous → fire-and-forget Stage 2 (host:277)
  │   │     SignalLlmClassifier+PiAiRuntimeAdapter (host:774,807)
  │   │     ├─ 成功 → routeStrong/routeWeak
  │   │     └─ 失败/超时 → queueUnconfirmedForBatch → signal_confirmations (host:411-440)
  │   │          [消费者: CorrectionObserverService 15min 周期, flag correction_observer 默认 OFF]
  │   └─ no-match → discovery 预算 6/h (host:478-488)
  └─ 同步写 user_turns (host:224-238)
并行旧线：llm_output (llm.ts:175) → DetectionService/PARALYSIS/GFI 阈值 (:248,283-292,298-307)
  → 写 pain_events (:323-331) → TriggerController (evidence_only 阻断诊断, :342-355)
工具失败：after_tool_call → after-tool-call-helpers.ts:406-533 (Rule2/Rule3 升级)
Gate Block：gate-block-helper.ts:198-275 (score 45, Rule1/Rule3)
Fatal Intercept：lifecycle.ts:152-168 (score 100, 绕过 triage 直通)
Correction Sample Reject：samples.ts:53-70 (绕过 triage 直通)
WEAK → trackFriction 喂 GFI (host:718-730)
```

### Codex（flag: `host.codex` 默认 ON；`codex_conversation_ingestion` 默认 OFF）

```
Hook (Marketplace plugins/principles-disciple/hooks/hooks.json, 全部同步 5s, 每事件 Node 冷启动)
UserPromptSubmit/PostToolUse → pd-hook.ts:252 flag 门 → ingestion flag ON 时
  ingestLiveObservation → governance_observations (ingestion.ts:75-129)
  → await runGovernanceAdmission (pd-hook.ts:195) → admitGovernanceSignals (gsa:1030)
     correction 候选: evaluateCorrectionSignal→collectSync(enableLlmStage:false, gsa:746)
       仅 STRONG&&high 准入 (:766-775)；ambiguous → not_a_signal
     tool_failure 候选: admitToolFailure (gsa:835)
  → 单事务写 pain_events+governance_signal_admissions+限流桶 (:790-818)
  → ensureGovernanceContinuation (:1374): promoteAdmittedGovernanceEvidence (≤12轮,
     gsa:1332) + ensureGovernanceDiagnosticianTask asyncMode 入队 (gsa:1210,
     硬编码 provenance='host_context_bound' :1269)
Stop → ingestTranscriptDelta 增量解码 (ingestion.ts:175-312) [flag ON 才有]
离线补拉: catchUpCodexIngestion (catch-up.ts:71-137) [三缺口见 F-P1-6]
显式 Owner Statement: "PD记录痛苦：" 前缀 (pd-hook.ts:333), 不受 flag 门控 (:55-57)
Worker: catch-up → reconcile → PainSignalBridge.executePendingDiagnosis
  (workspace-worker.ts:281,289,332-340; LLM 能力经 pain-signal-runtime-factory.ts:387,495,710)
全路径 exit 0 fail-open (pd-hook.ts:493-628)
```

### WorkBuddy（flag: `host.workbuddy` 默认 OFF；`workbuddy_live_keyword_pain` 默认 OFF）

```
UserPromptSubmit timeout:15 (hooks.json:39-48), wrapper 自设 12s 自杀线 (wrapper.cjs:55-61)
pd-hook.ts:268/294 双 flag 门 → 原生会话身份校验 (:298-301)
→ startsWith 预过滤 (gsa:1078) → collectSync → admitTrustedWorkbuddyLiveCorrection
  (gsa:1091, trustedWorkbuddyLive) → ensureGovernanceDiagnosticianTask 同步入队
零 transcript、零 user_turns、无前置 assistant turn
显式 Owner Statement: explicit-owner-statement.ts:5-53 (受 host.workbuddy 门控)
Worker: reconcile(跳过 promotion) → admitBareHostPains(扫 tool_failure 裸 Pain score≥70,
  gsa:1462-1565) → PainSignalBridge 诊断 (workspace-worker.ts:170-215) [无 catch-up]
永不 exit 2 (pd-hook.ts:16-19)
```

**上下文对齐（Diagnostician 实际可见）**

| Context | OpenClaw | Codex | WorkBuddy |
|---|---|---|---|
| Current User Message | user_turns + correctionEvidence | evidence.note 截断；显式时全文 | 同 Codex |
| Previous Assistant Turn | assistant_turns (TrajectoryTurnReader) | **unavailable**（worker 未注入 reader；governance_observations 存了但无读取者） | **unavailable** |
| Transcript | turns 回退 | promote 了但 Diagnostician 不读 | 无 |
| Task Intent | unavailable | unavailable | unavailable |
| Tool Calls | tool_calls | tool_calls + transcript exec facts | tool_calls |
| Owner Principles | 共用 PainSignalBridge 装配 | 同 | 同 |
| Historical Corrections | correction_keywords.json + signal_confirmations | 仅共享词典 | 同 Codex |

**共享 SignalCollector 判定：有条件能。** 依赖已就位（两 adapter 均依赖 `@principles/core/runtime-v2`，ESM 一致，PiAiRuntimeAdapter 已是注册 I/O seam）；阻碍：① 分类器工厂只在 openclaw-plugin（需下沉 host-runtime）；② 队列表绑定 OpenClaw rowid（见 F-P0-1）；③ Stage 2 只能在 Worker 内跑（Hook 预算 5s/12s）。

---

## Part 5 — Legacy Dependency Map

| 机制 | 生产活跃? | 状态与处置 |
|---|---|---|
| Semantic Confusion | 半活 | lifecycle.ts:111-117 版本只写 memory 不发 Pain（可删）；llm.ts:248-260 版本写 pain_events 行但诊断被 triage 阻断（**停写即可**） |
| GFI Threshold | 半活 | llm.ts:298-307 触发存在、诊断被阻断、仍写行；GFI 其余部分见 F-P1-8 |
| LLM Paralysis | 半活 | llm.ts:283-292；Runtime 19 行 llm_paralysis；处置同上 |
| Empathy Inferred | 死代码 | `empathy_inferred` 不可达；删除无收益无害；注意 evidence-chain-contract.ts:330-345 读模型须保留历史字符串 |
| WEAK Signal | 活 | 唯一效果喂 GFI（host:718-730）；GFI 退役后自然消亡 |
| Tool Failure Pain | **活（三宿主）** | Codex/WB 唯一自动 Pain 源；需 Owner 决策替换时机（D1） |
| Repeated Tool Failure | 活（OpenClaw） | Codex transcript 路径本就不生效（gsa:870 不传 consecutiveErrors） |
| RuleHost Block Pain | 活（仅 OpenClaw 旧路由） | 共享路由 deny 只 persistGateBlock 不发 Pain（gate.ts:848）；随旧路由 cutover 消亡 |
| Fatal Intercept Pain | **活且绕过一切门控** | score 100 直通诊断；SPEC 六表中优先级应最高 |
| Correction Sample Reject | 活 | samples.ts:53-70 绕过 triage；trajectory.ts:1332 与 samples.ts 双写可能产生重复行 |

**evidence-triage 处置**：不是"只服务旧来源"。8 个生产调用点中 2 个是手动 Pain 与共享路由 tool-failure。最小路径：先切断 llm.ts/after-tool-call/gate-block 的 6 处旧调用（其中 llm.ts:342 实际已无法 admit），手动 Pain 路径迁移/内联 cooldown 后，整删 evidence-triage + triage-adapter(98行) + trigger-cooldown-tracker(119行) + raw-observation-adapter(25行)。"只删 applyUpgradeRules 保留 1400 行恒等映射引擎"反而更不简单。admission-gate.ts 不动。

---

## Part 6 — SPEC Section-by-section Review

**§0 Architecture Decision** — 正确：六项目标与 Owner 方向一致，"删除多余机制"符合现状（确有大量半活机制在写无用行）。缺失：未给出每项目标的可观察验收（mvp-q-2）。

**§1 Pain Semantics** — 正确：定义、Evidence-not-Diagnosis、Error-not-Pain 与 ADR-0010/0014 兼容；不建新 Owner 模型的克制正确。不清：§1.3 "RuleHost 正确阻止危险操作"不得为 Pain——但"RuleHost **错误**阻止 Owner 已授权操作"（治理机制自身偏离 Owner 意图）未声明归属；按本定义应可成为 Pain Evidence，建议补一句区分正确治理与错误治理。审计任务书 §7.4 亦要求此项。

**§2 Pain Signal Sources** — 正确：两类来源边界清晰；§2.3 supporting evidence 不自动建 Pain 与现状一致。缺失：显式 Owner 报告的防重复/身份约束未提（现状已有 explicitOwnerStatement 跳过关键词的路径，gsa:751-757，建议引用为现状而非新设计）。审计任务书 §3.2 提出的 Signal Capture / Pain Evidence / Pain Diagnosis 三层区分，SPEC §1.2 已隐式覆盖，建议显式命名以免隐性偏差发现能力被误认为已实现——自动纠正检测只是当前可落地的高价值信号，不是 Pain 全部来源，建议 §1 加一句能力边界声明。

**§3.1 Reuse SignalCollector** — 基本正确；`SignalLlmClassifier`/`PiAiRuntimeAdapter` 的归属描述不准（A2）。"不新建 UnifiedPainDetector" 正确。

**§3.2 Stage 1** — 三分支与现状一致；**"直接进入纠正信号准入"把现状的误报风险固化进规范**（F-P0-3）；startsWith 移除前提错误（同上）。建议增加防护前置条件与学习词升级门。

**§3.3 Stage 2** — 目标正确；但"不再输出 EMPATHY/WEAK/SEMANTIC_CONFUSION/PARALYSIS"中 SEMANTIC_CONFUSION 不存在于现契约，且这是跨 prompt/schema/映射/降级路径的代码变更（F-P1-4）。被纠正 assistant turn 的锚定在 Codex/WB 不可得，SPEC §4.3 已诚实声明 WB 限制，但 §3.3 未声明同 Limitation 适用于 Codex worker 路径。

**§3.4 Cost and Failure Boundaries** — 四项边界全部属实（A5-A7）。缺：确认队列生产停摆事实（F-P2-13）未反映；"歧义候选可以进入现有持久化确认队列"对 Codex/WB 而言该队列不可用（F-P0-1）。

**§4.1 OpenClaw** — 保留项全部存在且属实。删除项中"Empathy 自动 Pain"已是死代码（A9）；"WEAK→GFI 分流、GFI 阈值触发"活跃属实。`llm_output` Hook 的 legacy funnel（DetectionService/PARALYSIS/GFI + 写行）SPEC §6.2 提及移除检测逻辑——正确，但需注意 llm.ts:323-331 写行发生在 triage 之前，删除必须覆盖写行点。

**§4.2 Codex** — 保留项属实；"不再只依赖确定性 high precision 关键词"是真实差距（A12）。缺：transcript 摄入三缺口（F-P1-6）与 promotion 死写（F-P2-15）；5s Hook 预算下的耗时模型（UNVERIFIED，未实测）。

**§4.3 WorkBuddy** — 现状描述准确（A14/A15/A16）。**队列共享方案前提错误**（F-P0-1）；"由现有 WorkBuddy Worker 消费"高估了现有能力（A18）；startsWith 移除缺防护前提（F-P0-3）。

**§4.4 Cross-host Invariant** — 方向正确；但"同一 Pain 来源边界"当前被 gsa:1269 硬编码 provenance 破坏（F-P1-5），需把 PainIngress 接入 gsa 才能成立。"允许不同上下文采集、不伪造证据"与三宿主上下文现实（Part 4 表）一致，值得肯定。

**§5 Admission** — "不新增第三套准入"正确；两入口职责确实不同（A19：语义层 vs 事务性准入），但 Codex/WB 缺语义层的现状未如实描述（F-P1-5）。§5.3 禁止清单合理。

**§6 Legacy Retirement** — 表格 10 行中 2 行与现实不符（A9、Semantic 行混淆），3 行低估严重度或漏路径（Fatal Intercept 绕过、tool-failure 是 Codex/WB 唯一自动源、evidence-triage 兼任手动门）。§6.1 保留证据清单正确。§6.2 "在所有调用点完成迁移后删除"表述正确但未列调用点清单（Part 5 已给）。§6.3 见 F-P1-8。

**§7 Complexity Constraints** — 约束 1-10 与"有条件能"的共享方案兼容；但需在 SPEC 内如实声明：分类器工厂下沉、WB worker 新增消费步骤、Codex/WB 候选持久化载体选型——三者都不是"新架构"但是实质代码变更面。

**§8 Acceptance Criteria** — Positive/Negative 表与语义一致。Cross-host Tests 中"同一信号不会创建重复 Pain"需注意 Correction Sample Reject 双写现状（Part 5）；"LLM 超时不会被误认为 NONE"与现状一致（超时→入队）。缺失：引用/转述误报的 Negative 用例（"他说这是错的"应不命中高精度直通）——这正是 F-P0-3 的验收缺口。另缺 api 超时/工具失败在**删除后**的回归确认（不产生 pain_events 行）。

**§9 Migration Plan** — 顺序风险见 F-P0-2。GFI 独立成 Phase C 正确（应更独立：与 Pain 清理分开的 PR 序列，健康观测面另决策）。"三阶段均不得触碰生产部署/数据库迁移"与现状冲突：加字段/放宽约束本身就是 schema 变更，措辞应改为"需显式迁移步骤与回滚路径"。

**§10 Documentation Alignment** — 合理；补充：`AGENTS.md §1.1` symlink 描述与实际不符（F-P3-17），若确认全量拷贝为新常态应同步。

**§11 Final Decision** — "成功标准是删除了多少机制"方向正确；建议补一句镜像标准：**"没有损害已成熟能力"需要用 Phase B 先行的验收证据来证明，而不是时间顺序上的承诺。**

---

## Part 7 — Simpler Alternative（推荐方案）

方向与 SPEC 一致，调整三点结构与两点载体：

1. **顺序重排**：
   - **Phase 0（无争议快赢，可独立 PR）**：删 `admission-events.ts`（269 行零调用）与 `buildEmpathyObservation`/`buildLlmDetectionObservation`；修双 flag 键；停写 llm.ts:323-331 的 semantic/gfi/paralysis 无用行；下线 Fatal Intercept 与 Correction Sample Reject 的绕过直通（这两处是现行不变量违反，不依赖任何新能力）。
   - **Phase B'（共享检测，先行）**：分类器工厂下沉 host-runtime → Codex Worker Stage 2（flag 默认关）→ WorkBuddy Worker Stage 2 → core 增加引用/位置防护 → 验收通过后才开始能力替换型删除。
   - **Phase A'（退役，以 B' 验收为前置）**：tool-failure 三路径、RuleHost Block、evidence-triage 收缩（手动路径先迁移）、`admitBareHostPains` 同步退役。
   - **Phase C'（GFI 有界退役）**：删 Pain 路径 + 停写 + `gfi_before/after` 列停用保留；健康观测面与外部 RuleCode 核查按 D2/D4 处理。
2. **队列载体**：不改造 `signal_confirmations`。OpenClaw 原样保留；Codex/WB 在**各自库内**用现有表承载 pending 候选（`governance_signal_admissions` 已有 `host_kind` 列与 `UNIQUE(logical_observation_key)` 幂等，最小改动是状态维度；备选是 WB/Codex 各自轻量 pending 行），Worker 周期内同步执行 Stage 2（Worker 无 5s 预算限制，天然是 LLM 的正确位置）。零新表、零跨宿主 schema 耦合。
3. **语义统一**：在 `ensureGovernanceDiagnosticianTask` 内构造 `PainIngressReport` 调 `evaluatePainIngress`（复用 pain-ingress.ts 纯函数），消除 provenance 硬编码——这是"同一 Pain 语义"的最小实现，不需要新层。

复杂度净变化：无新包/新 Worker/新表/新 flag；删除量显著大于新增量；与 §7 十条约束全部兼容。

---

## Part 8 — Proposed SPEC Changes（不直接修改原 SPEC）

| 章节 | 修改类型 | 建议要点 |
|---|---|---|
| 头部 | 修正 | 基线 SHA 补 `f`；注明 SPEC 文件本身未入库 |
| §1.3 | 补充 | 区分"RuleHost 正确阻止"（非 Pain）与"RuleHost 错误阻止 Owner 已授权操作"（可成 Pain Evidence）；"治理机制自身偏离 Owner 意图"纳入语义 |
| §1 末尾 | 补充 | 能力边界声明：自动纠正检测是当前可落地的高价值信号子集；隐性/长期偏差发现依赖 Diagnostician 现有能力，本次不新增 |
| §3.2 | 改写 | 高精度直通增加前置条件：core 级引用/位置防护上线 + 学习词升级门；startsWith 移除以防护上线为前提 |
| §3.3 | 改写 | 列出契约变更清单（prompt/schema/映射/empathy 降级路径）；删除 SEMANTIC_CONFUSION 字样；声明 Codex worker 路径同样缺被纠正 turn 锚定；保留 reason 供诊断 |
| §4.2 | 补充 | 前置修复：revert 文件名解析、`.zst` 归档、延迟建档；promotion 死写处置（补 reader 或承认无价值） |
| §4.3/§7 | 改写 | 删除"跨宿主共享队列 + host_kind"方案；改为"各宿主库内 pending 载体 + 各自 Worker 消费"；声明 WB worker 新增消费步骤；声明 `signal_confirmations` 保持 OpenClaw 原样 |
| §5.1 | 补充 | 声明 gsa 接入 PainIngress 语义（Connection Before Creation），作为"同一 Pain 语义"的实现路径 |
| §6 | 修订 | Empathy 行改"已死代码，随删"；Semantic 行拆两机制；Fatal Intercept 标注"绕过门控、优先下线"；tool-failure 行标注"Codex/WB 唯一自动源，删除以 Phase B' 验收为前置"；evidence-triage 行附 8 调用点清单 |
| §6.3 | 收窄 | GFI 退役边界：Pain 路径+停写+列停用保留；健康观测面/外部规则核查移交 Owner 决策 |
| §8 | 补充 | Negative 用例：引用/转述句不得命中高精度直通；删除后工具失败不产生 pain_events 行；双写去重用例 |
| §9 | 重排 | Phase 0（快赢）→ Phase B'（先行）→ Phase A'（退役，前置=B' 验收）→ Phase C'（GFI 有界）；"不得触碰数据库迁移"改为"schema 变更需显式迁移与回滚步骤" |

---

## Part 9 — Minimal Implementation Roadmap

| PR | 范围 | 前置 | 测试要求 | 回滚 |
|---|---|---|---|---|
| PR-0 | SPEC 修订（Part 8）+ Owner 决策（Part 10） | 无 | — | — |
| PR-1（Phase 0） | 死代码删除 + 停写无用行 + Fatal Intercept/Sample Reject 下线 + 双 flag 键收敛 | PR-0 | 现有 triage/pain 回归 + 新增"删除后无 pain_events 行"断言 | 纯删除，git revert 即回 |
| PR-2 | 分类器工厂下沉 host-runtime + Codex Worker Stage 2（flag 默认关） | PR-0 | 共享工厂契约测试 + Codex worker 集成测试（flag off 无行为变化） | flag 关 + revert |
| PR-3 | core 引用/位置防护 + 学习词升级门 | PR-2 | 引用/转述 Negative 矩阵 + 现有关键词回归 | 独立函数级回滚 |
| PR-4 | WB Worker Stage 2 + 各宿主 pending 载体（D5 选型落地） | PR-2 | WB worker 消费测试 + 12s Hook 预算回归 | flag 默认关 |
| PR-5 | gsa 接入 PainIngress 语义 | PR-2 | provenance/lineage 契约测试 + canonical identity 回归 | 函数级 |
| PR-6（Phase A'） | tool-failure/RuleHost/evidence-triage 退役 | PR-2/3/4 验收 + D1 | 三宿主 Negative 全表 + 手动 Pain 迁移回归 | 分路径开关回退（借现有 flag 边界） |
| PR-7（Phase C'） | GFI 有界退役 | D2/D4 | RuleHost 决策不变回归 + gfi 列停用后 schema 校验绿 | 列停用即可逆 |

每个 PR 交付时按 AGENTS §13 报 Complexity Delta；全程不自动开启任何默认关闭的生产 flag。

---

## Part 10 — Owner Decisions

**D1 Tool Failure Pain 删除与 Codex/WB 检测真空期**
代码审计无法决定：删除后到 Stage 2 验收前的真空是否可接受，属产品风险偏好。选项：① 保留 tool-failure Pain 至 Phase B' 验收（推荐——零真空，但退役推迟）；② 接受真空期，换取更早简化（Codex/WB 仅剩显式报告 + 纠正检测）。

**D2 GFI Owner 健康观测面去留**
`/pd-pain` GFI 条、Console "GFI 健康度"、CLI `pd runtime gfi` 是活跃产品面；删除它们是产品决定而非代码决定。推荐：保留观测面（GFI 降级为纯健康指标），仅删 Pain 路径——符合 SPEC §6 表中 Fatal Intercept 行"转为运行时健康记录"的同款逻辑，且避免 Console/CLI 三处联动改动。

**D3 歧义候选确认队列的定位**
生产事实：`signal_confirmations` 09-28 后零新增、Owner 从未消费（confirmed 2/15），消费者 flag 默认 OFF。SPEC §3.4 将其列为主路径之一。代码审计无法决定：是继续投入（修 F-P0-1 载体问题并默认开启 consumer），还是承认 Stage 2 直接判定为主、队列降级为 OpenClaw 本地兜底。推荐后者。

**D4 外部部署 RuleCode 的 `currentGfi` 依赖核查授权**
静态审计已达边界：内置规则零依赖，但已部署用户自定义规则不可达（UNVERIFIED）。需要 Owner 授权对真实 workspace 的 principle ledger / 激活实现做一轮只读扫描（含 `D:\.openclaw\workspace\.pd\`），或在知情前提下接受残余风险再执行 Phase C'。

---

## Part 11 — Evidence Quality & UNVERIFIED 清单

- **Static**: 全部 文件:行号 引用（main@457bbf0f）。
- **Test**: 直通行为（signal-collector.test.ts:24）、"low confidence → STRONG"、triage 名不副实用例（triage-policy.test.ts:421-426 vs :203,:253）、WB 前缀锁定（governance-signal-admission.workbuddy-live.test.ts:97,118）。
- **Runtime**: `D:\.openclaw\workspace\.pd\`（只读 immutable）：state.db 53.8MB（tasks 1410/pain_diagnoses 78/dead_letter 0，**无 pain_events 表**）；trajectory.db 41.6MB：pain_events 101（openclaw 95、host_kind NULL 6；user_correction 47/manual 33/llm_paralysis 19，最新 10-30）、signal_confirmations 15（09-28 后零新增）、governance_observations/rollouts/signal_admissions **全 0**；config.yaml：三个 SPEC 相关 flag 均未显式（=默认关）、signal_collector=true、correction_observer=false、双 admission 键并存、含明文 ingest_token（本报告不引用其值）。
- **Deployment**: 安装插件 2.2.12 与 main 同版、bundle 字节一致；`~/.pd/active.json` 2.8.0@0ff5f9f03 落后 main 4 PR；插件目录为全量拷贝非 symlink。
- **UNVERIFIED 汇总**：外部部署 RuleCode 对 `currentGfi` 的依赖；Codex 5s 预算下 flag-on 摄入链实测耗时；WB 12s 内 WAL 争用表现；`principles-disciple.json` workspace 指向的运行时影响；双 flag 键 loader 实际消费哪个（可由代码审计解决，非 Owner 事项）；宿主 guardHook 外层异常包裹（before_tool_call fail-closed 的实际暴露面）；Marketplace 插件中 McpTool handler 配置形态。

---

## Part 12 — Final Self-review 与最终裁定

1. 是否通读 SPEC 全文？——是（558 行全文 + 逐节审查 Part 6）。
2. 是否读关键实现而非只看入口？——是（五个子代理均下钻到函数/SQL/测试层）。
3. 是否沿调用链验证旧机制？——是（十机制逐个给出生产路径判定，Part 5）。
4. 是否遗漏宿主？——否（三宿主 + pi-ai 运行时 + 两套宿主源码）。
5. 是否将历史设计误认为当前实现？——反向错误已捕获：SPEC §6 的多处"删除"对象实为半活/死代码（A8/A9），报告已按现状重述。
6. 是否错误建议删除仍被使用的基础设施？——已防范：evidence-triage 的手动 Pain 门、session-tracker 的 receipt 依赖、gfi 列的 schema 校验、健康观测面均被明确保留。
7. 是否提出不必要的新抽象？——否；推荐方案全部为"连接现有能力"（gsa 接 PainIngress、Worker 内跑 Stage 2、复用现有表加状态），零新表零新 flag。
8. 是否存在更简单方案？——Part 7 即为对 SPEC 顺序与载体的简化；未设计第四套架构。
9. 是否保留 Pain 的长期行为偏差语义？——是；§1 语义未被削弱，且建议显式声明"自动纠正检测≠Pain 全部来源"。
10. 代码可证事实与架构推断是否分开？——是；全部推断标注于 Part 11 UNVERIFIED 与各 Owner 决策。

**最终问题：如果由我负责 PD 长期维护，会批准当前 SPEC 吗？**
不会原样批准；会在 Part 8 修订后批准。理由：SPEC 的语义层（§1/§2）和"删除优先"的架构立场正确且经证据支持，值得执行；但 §3.2/§4.3/§7 的三个技术前提（直通无防护、跨宿主共享队列、只加一个字段）与 §9 的实施顺序会在执行中造成误报扩大、错误 schema 变更和检测真空——这些修订成本远低于事后修复成本。变更本身不动摇 SPEC 的任何核心目标。
