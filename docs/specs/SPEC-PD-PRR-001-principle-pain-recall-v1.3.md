# SPEC-PD-PRR-001 v1.3 — Principle Pain Recall
## 先验证历史经验的行为增量，再最小化实现三宿主按需回忆

| 项目 | 决议 |
|---|---|
| 日期 | 2026-10-17 |
| 版本 | v1.3（基于 v1.2 + Gate A Reality Audit 实证结果逐条修订；v1.1/v1.2 保留不覆盖） |
| 状态 | **REVIEW READY — Gate A 已完成（GATE_A_AUDIT_COMPLETE）；Gate B 实验方案已就绪但未获授权（EXECUTION PENDING）** |
| 产品收益 | **UNPROVEN** |
| 工程范围 | **Gate A 审计 ✅ → Gate B A/C 价值实验（方案就绪待批准）→ Gate C 单宿主 LIST+DETAIL(summary) Pilot → Gate D 按证据扩展** |
| 最终产品目标 | OpenClaw、Codex、WorkBuddy 三宿主支持；**不等于三宿主同时开工** |
| 范围外 | 首版 Raw、MCP、向量库、自动注入、后台调度、全库检索、独立 Outcome 引擎、通用 lineage 图引擎 |
| 远端基线 | `702d922339851f54579a4f159a91c801af9810b2`（Gate A 审计基线 2026-10-17 实证；实施时重核） |
| Gate A 审计报告 | `docs/implementation-reports/SPEC-PD-PRR-001-v1.2-gate-a-reality-audit-20261017.md`（A-01～A-07） |
| Gate B 实验方案 | `docs/specs/SPEC-PD-PRR-001-Gate-B-experiment-plan-20261017.md` |
| Owner 决策卡 | `docs/specs/SPEC-PD-PRR-001-Gate-B-owner-decision-card-20261017.md`（D-01～D-05，全部 PENDING） |
| Gate A→B 准入矩阵 | `docs/specs/SPEC-PD-PRR-001-Gate-A-to-B-admission-matrix-20261017.md` |
| 参考 | v1.1、v1.2（SHA256 `4422F14F2A6CBCD20F0AC50515E92622BAB77C0ABC0C819D06988CC89CEBD465`）、`.tmp/prr-spec-review-20261016/REVIEW.md`、`SPEC-PD-PRR-001-v1.2-reality-audit-corrections-20261017.md`（F-01～F-16） |

> **实施授权说明**：本文件修订产品/工程 SPEC，不构成运行付费模型、读取未经授权的生产私人历史、修改宿主/数据库、创建 PR、部署或者全量实施的授权。Gate A 只读审计已完成；Gate B 真实数据执行需要 Owner 批准决策卡 D-01～D-05；C 阶段生产改动与 D 阶段范围扩展分别在各自门禁单独批准。任何尚未实施或未测试的事项标为 NOT_RUN，不能写 PASS。

---

## 0. Executive Decision：为什么从 v1.1 调整

PD 已能将 Pain/Owner Correction 提炼为可治理原则，但 Agent 获得的通常是抽象原则，而不是形成原则时的具体历史场景。在边界模糊的任务上，历史可能提供有益证据。然而**是否改善最终行动和减少 Owner 纠正尚无真实对照支持**。

因此先验证两项相互独立的假设：

- **H1（信息价值）**：在其他条件相同时，给予 Agent 正确、相关、有限的既有历史证据，比只给予同一条 Principle 能显著改善特定边界任务的行动质量/Owner 成本，且不造成不可接受的历史误用。
- **H2（产品实现价值）**：Agent 自主按需查询现有证据，能够在实际宿主中可靠得到 H1 的收益；该收益足以覆盖额外工具元数据、推理、时延、安装及长期维护成本。

**H1 尚未通过时，不建设三宿主产品能力。H1 通过 ≠ H2 通过。** H1 由人工准备的“Oracle evidence”进行 A/C 对照，H2 通过最小单宿主 Pilot 的 A/B 对照检验。

### 0.1 不变的产品设计

1. 默认 L0 仍仅注入现有原则；没有新的自动历史检索，也不改变 Prompt 注入预算、选择策略或 RuleHost。
2. 只处理经 Ledger/Candidate/Task/Pain 权威链证明属于该原则的历史；形成与复用区分。
3. Owner 原话、历史轨迹、模型诊断、Outcome 严格分栏；无出处则降级，不伪造。
4. 读取完全只读；不新增数据库表、迁移、向量库、后台 Worker 或持久化记忆。
5. 原始历史披露与「允许应用原则」不是同一种许可；未经核实授权不开放 Raw。
6. 三宿主是长期一致性的目标；**单宿主试验绝不能宣称“三宿主已交付”**。

### 0.2 从 v1.1 撤回的实施要求

- 撤回「三宿主全部接入以后再做行为增量实验」的顺序。
- 撤回 MVP 必须支持 L3 Raw、通用分页/offset、多级历史片段、Outcome 查询的要求。
- 撤回任何已经决定使用 OpenClaw 专有 Raw 读取方法作为跨宿主共享基座的暗示。
- 撤回声称「未调用严格 0 Token」或「Query 引擎不调用 LLM，所以 Agent 总成本无增加」。
- 撤回用简单 trustedContext 字符串字段证明 Agent 读取授权的假设。
- 撤回因新工具设计存在而重新实现原则身份判定。

### 0.3 从 v1.2 到 v1.3 的修订基础（Gate A 实证）

v1.3 不是新方向，而是 **v1.2 + Gate A Reality Audit（PRI-997/998/999，基线 702d9223）实证结果**的正式修订：

1. Gate A 的 A-01～A-04 交付已完成并有真实源码/夹具证据支撑；A-05～A-07 是**提案，不是已批准的生产配置**。
2. 合成夹具审计 30/30 断言通过（fixture-ledger 13/13 + fixture-sqlite 17/17，2026-10-17 本会话重放复现）。
3. `resolveLedgerActivationId` 确认为既有身份权威；ACTIVATION 与拟议 Recall 使用同一 canonical 规则一致性验证通过——**复用即可，不需要也不允许新增身份算法**。
4. `PainChainReadModel` 可作为既有反向证据链读取基础扩展；其 candidate→Ledger 双匹配 `Map.set` last-write-wins 覆盖风险**仍未在真实数据中量化**，列为 Gate B 重点验证项。
5. `SqliteConnection(readonly:true, bootstrapIfMissing:false)` 实证可用于严格零写访问；**不能**将 `listGovernanceObservations/openStore()` 误认为零写读取路径（已实证 WAL/schema-ensure 写副作用）。
6. PR #2048（702d9223 已合并）的 `createWorkspaceBehaviorEvidencePort` 是可复用的严格只读证据能力；**它是 Owner 挑选工具 ID 的内部化管线端口，不是通用 Recall，也不是完整 Recall 实现**——二者重叠与差异必须放入复用矩阵（§1.6），禁止建立第二套证据读取权威。
7. 真实数据覆盖率全部 `NOT_MEASURED`（未授权读取真实样本，分母未知，**不是 0 也不是 100%**）；宿主能力不等价：Codex observation/correctionEvidence 的 Agent read-back 仍 `NOT_COVERED`，WorkBuddy transcript 采集 consent 未立项。
8. F-01～F-16 校订逐项落实见 §10（Gate A 审核定案表）；未决 Owner 决策集中在决策卡 D-01～D-05。

---

## 1. 可核实的生产事实与必须复用的权威

以下均来自 **702d9223（Gate A 审计基线，2026-10-17）**的实证核查（A-01～A-04）。**路径与行号为审计参考位置，不能代替实现时重新读取真实代码。**

### 1.1 原则身份：已有权威，严禁再造

- `packages/principles-core/src/runtime-v2/activation/ledger-identity.ts:121–174` 已有 `resolveLedgerActivationId(artifact, deps)`。其判定先验证 Ledger 可用性、结构化 direct ID 的 Ledger 成员资格，否则通过 Dreamer Artifact / Candidate lineage；0/多匹配不猜测。
- `activation/activation-dispatcher.ts:197–223`（`:204` 调用）已消费该权威，在任何状态变更前完成身份解析。
- 夹具验证（TEST_FIXTURE，13/13）：带成员 UUID 直查 resolved；非成员 UUID `unresolved:principle_not_in_ledger`；candidate 映射多匹配拒绝猜测；不可读 Ledger `ledger_unavailable`。**与拟议 Recall 的 canonical 规则一致性验证 PASS。**
- `packages/host-runtime/src/active-principle-prompt.ts:61–129` 已有 `readPromptActivationCandidates`，负责 Prompt Flag、Activation、Artifact 和 excludePrincipleIds 的投影；生产读取 state.db 已采用 `readonly:true, bootstrapIfMissing:false`（`:90`）。**注意（F-11）**：候选集合 ≠ 实际注入集合——`buildActivePrinciplePromptContext`（`:131–`）的预算截断（RUNTIME_V2_PRINCIPLE_BUDGET）、fair-rotation、排除集都会进一步删减，Recall 资格若绑定注入历史需以渲染侧事实为准。
- `prompt-activation-reader-contract.ts` 的渲染 ID 可回退到 `principleDraft.title`，**渲染 ID 不天然等于 canonical Ledger ID**；因此要从可信已下发对象关联 Artifact，再用现有解析器归一身份，而不能按标题或 Statement 相似度匹配。

**契约**：复用 `resolveLedgerActivationId`，不要创建新的“这究竟是哪条原则”的身份算法。若当前可见 ID 对应多个 Artifact，或解析结果与已下发关联不一致，返回 unresolved/ambiguous；不得 last-write-wins。身份解析归共享 Core 所有，具体 Agent 是否有权访问此证据由宿主准入层负责，**Core 不反向依赖 host-runtime**。

### 1.2 Ledger：不能吞掉不可用状态（F-03/F-04 精确化）

- `packages/principles-core/src/principle-tree-ledger.ts:153–174` 的 `readLedgerFileState(stateDir)` 返回 `ledger` 与 `availability = ok | empty | unreadable`；`loadLedger():453–454` 只返回 ledger，会把 unreadable/空情形变成表面上的空数据。
- 夹具精确断言（TEST_FIXTURE）：文件不存在与零字节/仅空白都返回 `empty`（**三态本身不区分这两种原因**；若需细分根因，另行核对文件存在性+size，不改写既有三态）；`JSON.parse` 失败 → `unreadable`；**`['[]','"str"','12345','null']` 四种语法合法但结构非法文件全部报 `ok`（parseHybridLedger 宽松解析归空，ledger-codec.ts），不是 unreadable**。
- **契约**：Recall 必须使用保留 `availability` 的读取入口；错误映射为四类结果：`ok(有数据)` / `ok_but_empty_ledger`（含结构坏损被归空，需语义审查） / `empty`（真空账本或零字节） / `unreadable`。不得为 Recall 改变全局 `loadLedger` 行为；不能把权限拒绝/损坏 JSON 渲染为"0 个 Pain"。

### 1.3 Pain 形成与复用关系

- `packages/principles-core/src/runtime-v2/pain-chain-read-model.ts:55–88` 已知 `derivedFromPainIds` 在当前形成路径存 **candidateId**（`buildCandidateToLedgerEntryMap:68`，源码注释明确"the field stores candidate ids despite its legacy pain-oriented name"），并且 `reuseEvidence[]` 通过 `candidateId` 链接已存在的原则（`:78–86`；Ledger 写入方 `principle-tree-ledger.ts:528–701`）。
- `intake-to-internalization-bridge.ts:39,248–323` 可在诊断任务种子保存 `candidateId`、`sourcePainId`、`sourceTaskId`、`sourceArtifactId` 等；`sourcePainId` 在 60+ 生产/测试位置被消费，**存在多个任务拓扑，不存在单一固定链假设**。
- **双匹配覆盖风险（Gate B 重点验证项）**：`buildCandidateToLedgerEntryMap` 对 candidate→Ledger 归属使用 `Map.set()`，同一 candidateId 出现在多个 principle 条目（或 `derivedFromPainIds` 与另一 principle 的 `reuseEvidence` 交叉）时**后写覆盖先写且无冲突检测**（`:68–88`）；反向查询若只取 map 会把 last-write-wins 当真实归属。
- Ledger 的 `reuseEvidence[]` 可携带直接 `painId`、`candidateId`。

**契约**：只返回持久化关系能证明的形成、复用案例。先用现有证据/任务来源字段，尽量不引入通用图遍历；证据链断裂则降级。通过 canonical Pain ID 的精确引用核验，不把 Candidate ID 当 Pain ID。形成与复用合并时去重并保留来源事实。**正查得 list 或显式 ambiguous，不得沿用 Map last-write-wins**。跨库不一致时不能伪造已确认案例。

### 1.4 历史证据来自不同宿主，不限于 OpenClaw

| 来源类别 | 已知生产入口或事实（702d9223） | 关键约束 |
|---|---|---|
| OpenClaw | `openclaw-plugin` 的 `trajectory.ts` Pain/User Turn/RowId、blob/excerpt 读取（`getCorrectionTurnByRowid` 三级回退，PRI-844） | RowId 恢复正文≠证明轮次属于目标 Pain（仍需 lineage 证明）；Core 不得反向依赖 OpenClaw 整包；可写 `TrajectoryDatabase` 构造即有写副作用（mkdirSync/pruneUnreferencedBlobs），**Recall 只读路径禁止经它打开** |
| Codex | `host-runtime/governance-signal-admission.ts:600–622` 写入 `governance_observation:<logicalKey>`；显式 Owner 语句还有 `correctionEvidence`（owner_statement / codex_explicit_prefix，经 sanitizeString 脱敏） | observation 来源不可遗漏；有 observation 不意味着有完整 Raw；**Agent read-back（observation/correctionEvidence）当前 NOT_COVERED（F-08）**，Codex 与其他宿主能力不对等，不得宣称三宿主对等 |
| WorkBuddy | WorkBuddy Host Adapter + 治理工作区；hook 事件链（`workbuddy_pd_hook_event_log`，ADR-0027 冻结 source kind）；capability 自报 unknown | **transcript 采集 consent 未立项（F-08）**：无独立 self-report 通道、recorder 自报 unsupported；数据侧三宿主最弱；不得以 Codex 行为或 CodeBuddy CLI 文档推断 |
| 手工/摘要 Pain | 只有结构化描述/诊断摘录、或 retention 到期正文置 NULL（`retention_class ∈ {operational, promoted, expired, rolled_back, quarantined}`） | 可披露已授权摘要；过期/隔离正文不可恢复，按 class 过滤并映射 `unavailable`+reason，不当作空 |

**共享能力（PR #2048，702d9223 已合并）**：`host-runtime` 的 `BehaviorExamplePackAssembler`（PRI-484/PRI-992）、`assembleBehaviorHistory`（behavior-history.ts）、`createWorkspaceBehaviorEvidencePort`（workspace-behavior-evidence.ts:49）——better-sqlite3 `{readonly:true, fileMustExist:true}` 于 `.state/trajectory.db` + 单事务快照 + fail-loud typed error，全程零写（夹具实证：缺库 typed throw 不创建；读后无新表、无 WAL 翻转）。输入是 **Owner 显式选定**的工具调用 ID（`sourceNegativeToolCallId` + 1..3 `positiveToolCallIds` + Owner 期望结果），输出是内部化 worker 的 BehaviorExamplePack；消费方为内部化管线，**无 Agent 可调用入口**。真实复用机会与"不能重复实现"清单见 §1.6 复用矩阵。

- `packages/principles-core/src/runtime-v2/store/context/trajectory-turn-reader.ts` 只提供按 Session 的 User Turn 摘录/Assistant Turns；**不是跨宿主通用精确原文读取器**。
- `packages/host-runtime/src/governance-observation-store.ts:764–803` 的 `listGovernanceObservations()` 内部调用 `openStore()`；而 `openStore():337–352` 使用可写连接、`journal_mode=WAL`（`:345`）与 `ensureGovernanceObservationSchema`（`:299–318`, `:327/346`）。夹具实证：**缺库时优雅降级 `trajectory_db_not_found` 且不创建；已存在库会被 WAL/schema-ensure 写副作用触碰——不得把此现有 API 直接当无副作用的 Recall 只读入口（F-06）**。
- `packages/principles-core/src/trajectory-store.ts:96–106` 已有 `openTrajectoryDbReadonly()`（缺库抛 `TrajectoryDbUnavailableError`，不静默创建）；只允许按既有源所有权补少量必要的单条精确只读方法。若已有字段经脱敏可从 Pain 摘要直接提供，不为满足“未来 Raw”扩展读取代码。

### 1.5 现有宿主集成资产

- OpenClaw：现有 `registerTool` 接入；如果选择该宿主 Pilot，需核对实际 Tool SDK、`openclaw.plugin.json` 的 `contracts.tools`、toolMetadata/policy 与真实 Gateway 发现。
- Codex：目前使用 `plugins/principles-disciple/.codex-plugin/plugin.json` 的 Marketplace 插件，已有 `skills/` 与 bundle 测试；旧 `codex-host-installer.ts` 全局 Hook 新安装路径已退休。若选择 Codex Pilot，只在当前插件体系扩展。
- WorkBuddy Desktop：现有 `packages/workbuddy-adapter/plugin/` skeleton 尚无 Skills；默认 OFF；`resolveWorkbuddyWorkspace` 使用独立的 `~/.workbuddy/pd-workspace`。如后续选用须实测 Desktop 插件技能加载及 Installer 缓存，不以独立 CodeBuddy CLI 推断。
- **宿主选择是 Gate A 的客观决策**，不先指定最熟悉的宿主，也不预先开发三套工具。

### 1.6 复用矩阵（PR #2048 重叠能力 + 禁止第二套读取权威，F-05）

Gate A 实证：`createWorkspaceBehaviorEvidencePort` 的打开/快照/关闭模式与 Recall LIST+DETAIL(summary) 所需的"严格只读 trajectory.db 单条精确读取"属**同一能力家族**。Gate C 若实现 Recall：

| 能力 | 权威所有者 | Recall 决策 |
|---|---|---|
| 原则身份解析 | `resolveLedgerActivationId`（core，dispatcher 消费） | **复用**；禁止新身份算法 |
| Ledger availability 三态 | `readLedgerFileState`（core） | **复用**；不得用 `loadLedger` 判可用性 |
| trajectory.db 严格只读打开 | `openTrajectoryDbReadonly`（core）与 `createWorkspaceBehaviorEvidencePort`（host-runtime）的 `{readonly:true, fileMustExist:true}` + 快照事务模式 | **复用同一能力家族的打开策略**；新增的最小单条只读查询跟随该源所有权 |
| Owner 选定工具证据的窗口读取 | `createWorkspaceBehaviorEvidencePort`（内部化 worker 管线） | **复用即可，禁止复制实现**；不把它误称 Recall |
| governance observation 列表 | `listGovernanceObservations`（含写副作用） | **禁止**作为 Recall 只读入口；observation 单条读取须经既有 source owner 增加约束只读查询或豁免（Owner 决策） |
| OpenClaw 原文恢复 | `getCorrectionTurnByRowid`（openclaw 插件） | Recall 只读路径可按现有所有权调用；首版不为证明 Raw 完整性反向依赖整包 |
| Pain 反向链读取 | `PainChainReadModel` 类既有读取层（pd-cli trace/health、pd-console 消费） | **扩展既有读取层**，不新造读模型；双匹配歧义必须显式化 |

**禁止重复实现**：身份解析、WAL/schema-ensure 式 observation list、OpenClaw 可写 `TrajectoryDatabase` 包装读取、第二套 Evidence Assembler。**禁止建立第二套证据读取权威**——凡既有权威可得的数字，不得出现两个来源。




---

## 2. 阶段门禁、执行授权与停止机制

### Gate A — Reality Audit（当前允许的唯一第一阶段）

**目标：** 在增加生产功能前确认现有数据是否足以代表“原则形成时的真实经验”，并冻结可用性和授权边界。只读，不调用付费模型、不读取未授权私人原文、不对生产数据库执行迁移、修复或清理。

A1. 对齐实际远端 HEAD，检查并行 PR 和未提交更改；在隔离的检查环境读取源码，绝不重置本地 main。  
A2. 根据 §1 核实身份解析、Ledger 状态、来源结构、各宿主实际落库拓扑；形成 `Host × Evidence Source` 证据矩阵。  
A3. 从已允许用于评估的样本建立**完整分母**：形成/复用、各宿主来源、exact / excerpt_only / context_only / unavailable、unreadable/deleted、可用摘要、隐私限制。不能只挑三条恢复成功的案例。  
A4. 由 Owner 明确确认可以使用的字段、使用的模型/环境及保留规则；如果授权未确定，仅输出字段目录/计数，**不展开私人内容**。  
A5. 验证并记录：谁实际确认 Active Principle/Prompt Eligibility、哪一个配置控制 disable/revoke、当前 OS/Shell 有哪些无法防止的直接读取能力。  
A6. 评估“正确历史补充有用”的任务是否存在：不等于必须先建设自主检索；允许脱敏离线人工挑选案例。  
A7. 确认实现中哪些模块已被复用、哪一项缺失最小读取方法；冻结不可引入的新模块和跨包依赖方向。

**必交审计物：**

| 物品 | 内容 |
|---|---|
| A-01 Data Map | Principle→Artifact→canonical Ledger ID→Candidate/Task→Pain 的可达关系与异常数 |
| A-02 Evidence Coverage | 各宿主、各 evidence source 的分母、有效摘要率、精确锚点率、删除/过期/不可用数 |
| A-03 Read-only Proof Plan | Ledger availability、state.db、trajectory.db、governance observation 读取是否可真正 read-only |
| A-04 Disclosure Matrix | Owner 批准的字段范围、宿主 consent/enablement 覆盖、关闭/撤回行为、Shell 残余权限 |
| A-05 Pilot Host Decision | 在 OpenClaw/Codex/WorkBuddy 中选最易验证价值且最少新增连接的**一个**宿主，说明其他宿主暂缓 |
| A-06 Value Dataset Proposal | A/C 可执行对照任务、评分标准、需用模型与费用估计、时间/成本边界 |
| A-07 Uncertainties | 所有未能验证的事实及下一步证据 |

**Gate A 通过条件：** 存在代表性、合法可用、来源可核验的历史资料；已有 Identity/Source 的优先级明确；首次对照任务的成本与披露已可供 Owner 审核。若授权无法确定、关联大量歧义或证据覆盖不足，Gate A = BLOCKED，不得借新数据库或回填修补。

**Gate A 完成 ≠ B 的付费模型调用已授权。**

**Gate A 完成记录（2026-10-17，基线 702d9223）**：A-01～A-04 交付完成，30/30 合成夹具断言 PASS；本机真实数据覆盖率逐项 `NOT_MEASURED`（未授权读取，分母未知）。审计结论详见 `docs/implementation-reports/SPEC-PD-PRR-001-v1.2-gate-a-reality-audit-20261017.md`；A-05（Pilot 宿主建议：Codex 首选/OpenClaw 次选/WorkBuddy 暂缓）、A-06、A-07 为提案。**Gate A 审计完成与"Gate B 值得投入"是两个判断**：B 的就绪性由 §2 Gate B 准入矩阵 + Owner 决策卡裁决，当前 `GATE_B_EXECUTION_BLOCKED`（D-01～D-05 均待 Owner 裁决）。

### Gate B — 价值验证前置：A/C 对照（仅经 Owner 批准）

**核心问题：** 人工把正确历史交给 Agent，在相同原则和任务条件下，是否比只看原则更能做对事？

> **Gate B 准入、退出、失败与回滚条件（v1.3 冻结；可执行设计详见 Gate B 实验方案文档）**
>
> - **准入（Gate B 可启动的全部条件，缺一不可）**：① 决策卡 D-01 数据与成本授权明确（读取字段清单、脱敏要求、外部模型调用次数与预算上限、撤回方式）；② D-02 召回资格边界经 Owner 裁决；③ Pilot 宿主（D-05）选定且其证据读取范围已授权；④ B0 预注册（任务集、评分标准、STOP 条件、成本上限）在查看任何结果前冻结；⑤ 授权 workspace 内的只读读取已通过准入矩阵全部条目。
> - **退出（正常收口）**：A/C 对照按预注册执行完毕并出具 11.2 格式报告 → CONDITIONAL GO（进 Gate C 提案）/ STOP / UNPROVEN 三态之一，由 Owner 确认。
> - **失败语义**：合成夹具预演失败（本轮文档阶段允许，仅代表方案不可执行）→ 修方案不修数据；真实执行中发生越权读取、敏感泄露、数据库写副作用 → **立即 STOP 并回滚**：终止进程、留取脱敏事故记录、撤销 D-01 授权待重审，不放宽边界继续。
> - **回滚**：Gate B 纯观察操作，无生产写入；回滚 = 撤销授权 + 销毁本机临时脱敏样本 + 记录 NOT_MEASURED 恢复，无生产数据迁移需要撤销（`DB/文件状态在进程退出后保持原样` 是验收断言之一）。

组别定义：

| 组别 | 条件 | 可以证明什么 |
|---|---|---|
| A（Baseline） | 同一 Agent/模型/宿主已有能力、同一原则，无附加历史 | 原则本身的表现 |
| C（Oracle History） | 完全相同条件，另外提供经过来源确认、长度受限、Owner 允许披露的历史证据 | **历史信息本身**的潜在增量 |
| B（自主检索） | 相同原则，另有可选 Recall Tool/Skill；在 Gate C 才运行 | 实际产品获取历史的增量 |

**不要在 Gate B 假装 B 已具备。** 人工提供历史 C 组不是“Agent 会自主查找历史”的证据。

数据集必须至少覆盖三个任务类型：  
(1) 原则抽象不足、历史有帮助的边界任务；  
(2) 原则已经足够，不应额外查询的任务；  
(3) 旧 Pain 场景与当前约束不同，若生搬硬套可能造成错误的反例。  
其中应包含真正需要做出决定/生成结果的新任务，而非仅要求复述过去的事故。

**控制要求：**
- 所有任务、参考答案/可判标准、费用上限、不能接受的隐私/安全事件、停止时点**在查看结果前冻结**；用原有测试工具/评审，不建设实验平台。
- 同一模型、版本、温度（若可控）、工具预算、环境、原则文本、任务输入一致，A/C 在干净上下文独立运行；顺序与配对预先确定，不能用前组的执行结果污染后组。
- 历史材料最多允许 C 组加入事前冻结的内容；不得为提高 C 组成绩偷偷增加额外高优先级指令、人工解题提示、修改原则或修正任务。
- 内容仅使用经 Owner 明确许可和必要脱敏的材料，先评估费用及是否发送第三方模型；若未经批准，则 B 阶段 NOT_RUN。
- 评判尽量盲于组别；使用结果与当前约束的正确性，不能因模型恰好“说出了旧历史”就给高分。
- 衡量全部任务的质量、错误泛化、Owner 介入次数与实际/估计纠正时间、总 Token、推理/等待时延和实施维护开销，**不能只统计成功使用历史的样本**。
- 以实际数据描述不确定性和代表性；不虚构固定 20% 的成功门槛或样本数。

**Gate B 继续/停止规则：**

| 观察 | 裁决 |
|---|---|
| C 组相对 A 无可观察收益，或旧历史导致不可接受的错误泛化 | **STOP PRODUCT EXPANSION**；调查原则质量/任务设计或其他瓶颈；不建设 Recall 产品接入 |
| C 组在预先定义的目标任务改善，隐私与额外成本可接受 | **GATE B CONDITIONAL GO**；允许提议单宿主 C 阶段及其预算 |
| 样本/任务不足、结论不稳定 | **UNPROVEN**；限定补充实验，不依据不充分证据三宿主扩展 |
| 显示收益仅来自额外的强制提示而非历史事实 | **STOP / REDESIGN EXPERIMENT**；不能认定 Recall 本身有价值 |
| 发生敏感数据泄露或不可接受的 Owner 权限误用 | **STOP immediately** |

“STOP”是停止**当前工程投资**，不是据小样本声称学术上证明 Recall 永远无效。

### Gate C — 单宿主最小 Pilot（B 通过且经 Owner 单独批准后）

**目的：** 验证 Agent 能自主、按需获得 Gate B 有用的历史，并取得可接受的**净**改善。

> **Gate C 准入/退出/失败/回滚（v1.3 冻结）**
>
> - **准入**：Gate B CONDITIONAL GO + Owner 对 D-03（Codex 证据读取若为 Pilot 前置）等遗留决策的裁决 + 选定宿主 Pilot 范围 SPEC 单独评审批准。
> - **退出**：C-T01～C-T18 场景 + A/B 自主对照全部出具报告 → PILOT PASS / FAIL / UNPROVEN。
> - **失败**：确证无法用现有只读能力安全实现 LIST+DETAIL、或净收益为负 → 撤销 Tool/Skill 暴露（C-PR03 回滚路径），保留现有数据与原则能力，Recall 标记 NOT_RUN。
> - **回滚**：停用入口（feature flag / kill switch / 移除 Skill），不迁移数据、不删证据；回归验证 L0 注入/RuleHost/审批不受影响（C-T17）。

**唯一必做产品范围：**
- 一套共享、确定性的反向只读查询；
- 一个只读的 Agent 可调用入口（按选中的宿主实现）；
- 两个操作 `list` 和 `detail(summary)`；
- 输入按真实 Principle ID；形成/复用关系可核验、去重；缺失证据有明确状态；
- 摘要可来自可信持久化 Pain/诊断/Owner Correction 摘录，且分清来源类型；
- 查询结果有界、脱敏；不重建历史、不过度展开；
- 宿主当前批准范围内的工作区、原则可见性与禁用状态得到真实校验；
- Tool/Skill 不修改现有 Hook/RuleHost，也不在每轮自动调用。

**Gate C 特意不做：** Raw、读取整段对话、跨宿主新适配、MCP、新数据库索引、分页 API、单独 Outcome 查找、相似度重排、统一实验平台。对于历史原文缺失，不以原文不可用为借口扩大首版范围。

**Pilot 宿主选择**由 Gate A 的真实证据覆盖率、清晰授权、当前实际使用量、最小接线成本及可运行 E2E 决定；选择 OpenClaw/Codex/WorkBuddy 之一。共享 Core 禁止固化宿主私有数据拓扑；但**不要求在 C 阶段为未选宿主安装或实现 Agent Tool**。

**测量**：先做明确要求使用工具的功能正确性 E2E，再在无“必须检索”指令的任务中进行 A/B，对比调用意图、历史匹配质量、当前行动、错误迁移、全任务 Token/时延/Owner 成本。真实存在净改善且能维护时才考虑 Gate D。收益仅来自 C 组，而自主 B 组没有改善时，优先改**发现/触发/摘要质量**，不可自动扩成 MCP 或三宿主。

### Gate D — 分项增量扩展（证据与批准驱动）

> **Gate D 准入/退出/失败/回滚（v1.3 冻结）**
>
> - **准入**：Gate C PILOT PASS + 每项新增（宿主/Raw/MCP）均有独立提案、覆盖率/授权/成本证据与单独 Owner 批准。
> - **退出**：按 §7.4 每宿主 8 项验收逐项 PASS 或明确 NOT_RUN。
> - **失败**：某宿主无法满足真实授权/安装/调用验证 → 该宿主停在该阶段，不得以其他宿主 PASS 推断。
> - **回滚**：每项扩展按宿主现有禁用/卸载语义回退，不引入跨宿主共享状态；Raw/MCP 扩展失败仅下线对应能力。

- 三宿主最终覆盖是产品目标，不是 Gate C 的验收项。
- 每新增宿主单独评估证据来源、Owner 披露范围、插件安装/升级/禁用、真实 Agent 工具发现和 E2E。只薄化宿主边界，不复制身份解析/Pain 查询 SQL。
- Raw 只有同时满足：需要的行为增量、可靠精确原文锚点、足够覆盖率、脱敏/删除语义明确、Owner 专项披露批准，才作为独立提案；**不因有 L2 就自动开放 L3**。
- MCP 只有已证实 Skill+CLI / Host Tool 无法满足时，经新的复现与成本裁决才考虑本地只读 stdio；不能为了统一三宿主接口而先搭服务。
- 无证据表明需要向量检索、自动规则升级或新记忆库时，始终排除。
- 最终如果要宣布“三宿主 PRR GA”，则 OpenClaw、目标 Codex 产品面、WorkBuddy Desktop 各需独立真实安装与调用 PASS；单宿主完成仅能标为 Pilot PASS。

---

## 3. 历史披露与信任模型（Gate A 必须冻结）

### 3.1 首版披露上限

C 阶段默认只讨论**已证实允许 Agent 阅读的摘要字段**。对每类来源，Gate A 必须出具矩阵：

| 要核实的列 | 例子（需要填写真实事实） |
|---|---|
| hostKind / governance workspace | openclaw/codex/workbuddy；当前工作区唯一权威路径 |
| data category | Principle statement、Pain 摘要、诊断摘要、Owner Correction 摘录、原文、Tool Facts |
| actual source | ledger、pain_events、observation、artifact、turn/Blob |
| existing consent / enablement | 何种 Owner 配置、何时授权、覆盖哪些数据类别 |
| enforcement owner | 哪个已投产函数或现有 OS 机制在**读内容之前**验证 |
| revoke / disable | 关掉宿主或撤回原则后的实际行为 |
| retention / deletion | quarantined、expired、deleted 时是否立即不可读 |
| Shell residual risk | Agent 自带 Shell/文件权限能否绕过产品工具的弱约束 |
| status | approved / not_covered / unsupported / unverified |

**原则被批准激活 ≠ 历史私人文本自动获准披露。** 不得把 `visibility:'agent_active'`、`--host workbuddy` 或模型可填的 `--workspace` 当成认证。真实原文未被授权时 C 阶段无 Raw；若摘要/纠错摘录同样未被覆盖，则必须先决策是否能披露最小事实，不能暗中扩大。

**四种披露能力必须区分（Gate A A-04 实证，对应 F-08）**：Codex `getCodexIngestionDisclosureText()`（G2A 冻结）授权的是 **capture**（读 transcript，32 条/7 天窗口）/**retention**（治理生命周期）/**diagnosis egress**（升级片段发配置 LLM API）三件事；**agent read-back 在冻结文本中只字未提**。因此：Codex observation、correctionEvidence、Tool Facts 对 Agent 的 read-back 一律 `NOT_COVERED`；OpenClaw Pain 摘要/诊断/read-back 同样 `NOT_COVERED`；WorkBuddy 无 transcript 采集 consent（未立项）。这些项目的披露与否只能由 Owner 决策产生（决策卡 D-01/D-03/D-04），**授权状态在裁决前为 `PENDING`，不是"默认允许"也不是"默认禁止production"**——查询行为按"无资格→拒绝"处理。

### 3.2 Agent / Operator 分离

- Operator CLI 的 OS 权限与用户显式调试能力，不自动成为 Agent 的产品权限。
- OpenClaw Host Tool 可以借助可信 SDK invocation 的工作区上下文、已有 Tool Policy、宿主启停与 Activation 判断；不能信任模型输入的 workspace。
- Codex/WorkBuddy Skill + CLI 由 Agent 的 Shell 启动时，Skill 文本不具备强隔离能力；如果 Agent 本来就能读取多个数据库，普通 CLI 参数不能从系统层面禁止它。此边界须报告真实 OS/沙箱权限，不能假装“隐藏 --workspace 参数”能阻止直接文件读取。
- 优先复用已有 Owner Governance 和客户端沙箱，不建立新的通用授权服务；若现有边界无法满足项目要求的实际保密级别，则对应宿主 BLOCKED。
- 禁用一个宿主不能自动禁用其他宿主的独立 Operator 访问；两者语义需明确并测试。

### 3.3 当前原则可见性

Gate A 必须确定该宿主当前 Agent 是否只可以查询**实际注入到本轮 Prompt 的原则**，或所有**当前有效且允许 Agent 看见的已激活原则**。二者不等价；既有 Prompt Fair Rotation、预算截断、Host Overlap Exclusion、Activation 通道限制都可能产生不同集合（A-T 矩阵已给出差异来源的静态证据，真实轮次分布 NOT_MEASURED）。

**默认更保守的设计候选：** 仅查宿主已经有依据允许向该 Agent 披露的有效原则；先用 `readPromptActivationCandidates`/已有策略拿到可用对象，再用 `resolveLedgerActivationId` 验证 canonical identity。具体可见集合必须以真实生命周期和信任上下文验证并冻结；**不能把“所有 Ledger 原则”暴露给工具**。如果无法安全确定是否当前允许披露，则拒绝并返回明确 reasonCode。

**OWNER_DECISION_REQUIRED（v1.3 冻结，对应决策卡 D-02）**：

1. Recall 资格边界取"本轮实际注入集合"还是"宿主有权披露的有效激活集合"（推荐后者，误召回风险更低）；
2. **已停用（deactivated）、已撤回（revoked）、从未有效激活的原则是否具备 Recall 资格——未经 Owner 明确裁决前，一律视为无资格（不可查询），不推定默认值**；
3. 资格集合与各宿主披露范围的交集如何随宿主启停（`features.prompt.enabled`、`host.codex.enabled`、`codex_conversation_ingestion`、`host.workbuddy`）联动，须在实现前冻结为可测试的投影规则。

### 3.4 历史内容处理

- Owner 原话、诊断者分析、已有规则、Tool Facts 在结构化响应中分别标注；不可把模型“诊断”当 Owner Correction。
- 原始语句作为不可信数据呈现，禁止被提升为新的 System/Owner 指令，不执行里面的命令。
- 先脱敏后截断；部分摘要中也可能包含密钥、私人信息，不能因为非 Raw 就跳过检查。
- 宿主禁用、撤回、保留期终止、删除/隔离后的不可见性必须在查询时生效；不能从复制缓存中“复活”。
- 检索失败时不打印敏感绝对路径、异常堆栈、Row 内容；只返回有界状态及稳定 reasonCode。




---

## 4. 单宿主 Pilot 的最小查询契约（仅 Gate C 启动）

### 4.1 一个服务权威、一个宿主入口

首版**没有 Raw Mode、分页 Cursor 或独立 Case 持久化 ID**。唯一面向 Agent 的能力建议命名 `pd_principle_experience`。选中宿主是 Tool 还是 Skill+CLI，由 Gate A 事实决定。为实现检索可能需要一个共享 Core 函数/Reader，但不强制新建独立 `PrincipleExperienceReadModel` 类；能扩展既有只读读取层就不复制。

概念类型（**不是已实现接口**）：

~~~ts
type RecallRequest =
  | { mode: 'list'; principleId: string; limit?: number }
  | { mode: 'detail'; principleId: string; painId: string };

type RecallResult =
  | { status: 'ok' | 'partial'; mode: 'list' | 'detail'; /* verified payload */ }
  | { status: 'not_found' | 'denied' | 'unavailable' | 'invalid_input' | 'error'; reasonCode: string };

// 独立的可信接入层在查阅正文前完成：真实宿主/工作区/权限/Activation 验证。
// Core 仅接收由此形成的、有代码证明的受信对象及精确 ID；
// 不能把可伪造的字符串 "host=codex" 当授权证据。
~~~

- 参数无 workspace、SQL、sessionId、路径、任意 Artifact ID 和 raw level；不允许 `--host` 冒充调用身份。
- `mode=list` 必须有 principleId、limit 可选；`mode=detail` 必须同时有真实 principleId 和 painId。无效组合拒绝。
- limit 默认 5，最大 20，首版仅需有限目录；如果同一原则超过 20 个 Pain，报告 `hasMore: true` 与计数，不为此构建复杂分页或新索引。
- 排序使用现有可信时间 DESC、painId 作稳定第二键；时间缺失明确 null，并给确定性次序。
- 每次调用先校验已许可的 Principle，可读来源只限已核实链接；不能查询所有原则、全库聊天或跨宿主 workspace。
- 读取实现**不调用模型**；但 Agent 为发现、决定、执行 Tool、处理结果可能产生模型调用和额外 Token，必须记入 Gate C 全任务成本。

### 4.2 LIST：只要可核验的 Pain 目录

示意 JSON（值为**虚构测试样例**，不是用户真实历史）：

~~~json
{
  "status": "partial",
  "mode": "list",
  "principleId": "ledger-id-example",
  "cases": [
    {
      "painId": "pain-example",
      "sourceKinds": ["created"],
      "summary": "经授权的历史摘要",
      "summarySource": "pain_event",
      "evidenceQuality": "excerpt_only",
      "occurredAt": "2026-09-01T08:00:00Z"
    }
  ],
  "hasMore": false,
  "unresolvedSourceCount": 1,
  "degradedReasons": ["one_legacy_source_unlinked"]
}
~~~

**LIST 只返回经过证明的案例**。形成与复用重合时同一 Principle+Pain 去重，保留所有真实 sourceKinds；无法确认的关联不进入 `cases`，通过 `unresolvedSourceCount` 和有限的状态记录，不泄漏无权限的其他 ID 或数据详情。

`summary` 优先选现有已持久化 Pain 描述，源字段明确标记；若只有候选/诊断摘要且来源校验通过，必须写 `summarySource`、`evidenceQuality`，不能冒充原话。摘要字段未获准披露时不返回其正文。

### 4.3 DETAIL：仅摘要字段，不暴露 Raw

~~~json
{
  "status": "partial",
  "mode": "detail",
  "principleId": "ledger-id-example",
  "painId": "pain-example",
  "sourceKinds": ["created"],
  "pain": {
    "summary": "获准披露的历史 Pain 摘要",
    "source": "pain_event",
    "evidenceQuality": "excerpt_only"
  },
  "correction": {
    "summary": null,
    "source": null,
    "evidenceQuality": "unavailable"
  },
  "diagnosis": {
    "summary": "已有、可核验的诊断摘要",
    "source": "diagnostic_artifact",
    "evidenceQuality": "excerpt_only"
  },
  "degradedReasons": ["correction_unavailable"],
  "truncated": false
}
~~~

- detail 前重新确认目标 painId 在该原则的已验证形成/复用关系中；不得因用户提供 ID 就跳过 LIST 的关系校验。
- `correction` 仅有可审计 Owner 证据时出现；Codex 的 `correctionEvidence` 是否可用须由真实 consent 与来源级别决定；仅有模型诊断时不得合成 Owner Correction。
- `diagnosis` 必须标为 `diagnostic_assessment` 类别及对应来源，不能描述为已验证的客观根因。
- 正文预算建议 LIST 每条有界，DETAIL 响应整体以实际可用文本限在 5,000 字符以内；截断一律显式标记。预算值需在 Pilot 前冻结并测试。
- Outcome 不进入首版查询；如无独立可信 Outcome，不把形成/复用/激活当“后续行为成功”。
- **严禁** `detail(raw)`、全 session history、邻近时间回退与多级证据片段读取。若未来需要，按 Gate D 的新决策开发。

### 4.4 证据质量、顶层状态及错误码

字段 `evidenceQuality`：

| 等级 | 含义 | MVP 可返回 |
|---|---|---|
| `exact` | 具体来源/关联 ID 均核实，摘要与正确 Pain 绑定 | 是（不代表对外开放 Raw） |
| `excerpt_only` | 可以证明摘要出处，但为截断摘录 | 是；必须给 `truncated`/来源 |
| `context_only` | 仅证明同一 Session/Task，不能精确归于该 Pain | 仅作已标注上下文，不能充当 Owner Correction |
| `unavailable` | 数据未保留、删除、无权限、链路断裂或不支持 | 正文字段 null，明确 reason |

顶层 `status` 仅 `ok | partial | not_found | denied | unavailable | invalid_input | error`。用稳定 `reasonCode` 区分 `ledger_unreadable`、`ledger_empty`、`identity_ambiguous`、`pain_not_linked`、`host_disabled`、`permission_denied`、`evidence_deleted`、`source_unverified`、`trajectory_db_missing`、`schema_unavailable` 等。不可把 `unavailable` 当空正常列表，也不能将缺 Correction 当作某条原则不存在。错误说明有界且脱敏。

### 4.5 非功能与兼容约束

- 不调用 Tool 时绝对不新增历史数据库查询或历史正文 Prompt 注入；固定 Tool Schema/Skill 元数据成本单独测量，不承诺“0 Token”。
- 主动查询不得生成数据库、初始化旧 Schema、改变 WAL、写入业务事件/修复历史或创建常驻后台。既有宿主自身遥测与业务只读的影响分别报告。
- 不修改旧 `pd trace show --pain-id`、Agent Prompt Serializer、Activation 或 RuleHost 行为；不修改已有 Owner 审批/回滚语义。
- 已有 WorkBuddy 专属治理 workspace 必须保留，不能把不同宿主数据库自动合并。
- 工具失败不得触发修改/补齐来源的自愈操作。
- 不新建跨宿主新统一权限平台；当前最小 Pilot 仍需确实可证明的披露边界。
- 查询延迟、全任务 Token/模型费用由实验实测；首版不凭空做 p95 的产品收益承诺，更不为达标先建缓存/索引。

---

## 5. 保留原有数据与读取权威的具体方案

### 5.1 Principle Identity 与 Ledger

建议查询路径：

~~~text
真实宿主当前允许展示的 Activated Principle
          ↓（可信 activation / artifact reference）
现有 readPromptActivationCandidates 或等价宿主 eligibility 投影
          ↓
现有 resolveLedgerActivationId（Ledger-aware）
          ↓
readLedgerFileState（保留 ok/empty/unreadable）
          ↓
唯一 canonical Ledger Principle ID
          ↓
形成关系 derivedFromPainIds(candidate IDs)
或复用关系 reuseEvidence(candidateId, painId)
          ↓（现有 Store/任务字段验证）
canonical Pain ID
          ↓
获准披露的持久化摘要 / 可信纠错摘要
~~~

注意：`readPromptActivationCandidates` 在 `host-runtime`，`resolveLedgerActivationId` 在 `core`。应通过既有注入/函数依赖实现对接，**不得让 Core import host-runtime，也不得新建另一套 Ledger ID resolver**。

### 5.2 可靠只读：数据库不可用就返回状态

- **SQLite 严格只读合同（v1.3 冻结合同，Gate C 实现必须逐条满足并有红灯测试）**：
  1. 所有只读访问显式 `SqliteConnection({workspaceDir, readonly:true, bootstrapIfMissing:false})` 或等价 better-sqlite3 `{readonly:true, fileMustExist:true}` 打开；
  2. **禁止 bootstrap**：缺库必须返回 `trajectory_db_missing`/`schema_unavailable` 类 reasonCode，绝不创建文件/目录（危险默认实证：`readonly:true` 缺省 `bootstrapIfMissing` 即会以写模式 bootstrap 创建 `.pd/state.db`，任何新调用方必须显式传 `false`）；
  3. **禁止 schema migration/ensure**：不调用 `ensureGovernanceObservationSchema` 或任何 CREATE/ALTER/版本写入；
  4. **禁止 WAL 写副作用**：不设 `journal_mode`、不做 checkpoint；对已存在库也不允许（夹具实证 WAL/schema-ensure 是现 list 入口的真实写副作用）；
  5. **验收断言**：每条只读路径的测试须验证"进程退出后 DB 文件与目录状态保持原样"（含 journal mode、mtime、文件集）；
  6. 单事务快照模式优先复用 `createWorkspaceBehaviorEvidencePort` 的打开策略（§1.6）。
- Ledger 使用 `readLedgerFileState` 的 `availability` 而不是 `loadLedger` 的空表象。空账本/缺失、解析损坏/不可读分别测试。
- state.db 使用已存在的 `SqliteConnection({workspaceDir,readonly:true,bootstrapIfMissing:false})` 路径。
- trajectory.db 优先使用 `openTrajectoryDbReadonly(workspaceDir)`；不能读则报告，绝不自动 `runtime init`。
- `governance_observation` 精确读取必须在真正只读的 DB 连接下进行：**不能直接复用当前含 schema 初始化的 `listGovernanceObservations`/ `openStore()` 作为 Read-only**。如果摘要已直接在可信的 Pain/Task 证据中，则优先少读一次库；若必须走 observation，最小实现是给既有 source owner 增加单条带约束的只读查询，不另建新表、索引或包装全套 Store。先确认其 sourceRef、retentionClass、不可见状态和现有回收语义，再宣称可用。
- `getCorrectionTurnByRowid` 仅还原指定用户轮次的文本，不自动证明它对应目标 Pain，也可能回退到 excerpt。首版不为了证明 Raw 完整性反向依赖 OpenClaw 插件。
- WorkBuddy 的真实来源也须列入 Gate A 矩阵，不以 “与 Codex 同样有 Hooks” 推论同等 Evidence Coverage。

### 5.3 ID 与失效来源细节

- 创建关联 `derivedFromPainIds` 的每个元素需作为 candidateId 验证；可通过原始任务 seed 的 `sourcePainId` 或现有受信 lineage 找真实 Pain；不得笼统使用候选标题/时间相似度。
- 复用关联 `reuseEvidence` 的 `painId` 必须与该 Candidate/Task 关系交叉核验；禁止把未经核实的 Ledger record 单独作为“证据已完备”的证明。
- Candidate→Principle 映射冲突、一个 ID 命中多个不同来源、Artifact title fallback 歧义一律返回 unavailable/partial 和原因，不沿用 Map 最后一项覆盖策略。
- `sourceRef` 可以指向 `governance_observation:<logicalKey>`。按真实保持策略和宿主数据权威读取；过期、隔离、删除记录不能返回内容；不进行 fallback 全会话遍历。
- 若旧数据无法追溯，返回已知事实和 unavailable，**不为这个功能回填或修正历史数据**。

---

## 6. 三宿主范围与延后实现纪律

| 宿主 | Gate A 必须审计 | Gate C 是否实施 | Gate D 的扩展验收 |
|---|---|---|---|
| OpenClaw | Tool SDK、Manifest、Tool policy、workspace、Pain/Turn 证据 | **仅当被选为首个 Pilot** | 真实 Gateway 发现、调用、禁用、安装更新 |
| Codex | Marketplace Skill、$pd-setup、pinned runtime、governance observation、Shell/授权 | **仅当被选为首个 Pilot** | 目标 Codex CLI/Desktop 产品面分别验证；不用旧全局 Hook Installer |
| WorkBuddy Desktop | Plugin Skeleton/Skills 发现、独立 workspace、默认 OFF、历史数据实际形态 | **仅当被选为首个 Pilot** | 真实 Desktop 执行、缓存升级、禁用/卸载和证据来源验证 |

Gate C 选择单宿主不意味着 Core 可以无视另外两个宿主已存在的来源事实；至少 Gate A 必须证明设计不会制造 core→OpenClaw 或 core→Codex 专有实现的反向依赖。**但不因此在 C 阶段额外搭三套适配测试/交付组件。**

如 Codex/WorkBuddy 通过 Skill+CLI 实现：
- 使用现有已安装的 Marketplace/Plugin Skill 目录及可定位的 PD CLI wrapper；
- 不单独实现相同 SQL/查询，不偷偷切换默认工作区；
- Skill 提示是 Agent 帮助文档，不是强制策略或访问控制；
- 禁用后入口的真实表现需要记录，不能以 Mock Skill 存在性充当授权证明。

如 OpenClaw 通过 Tool 实现：
- 使用真实 `registerTool` 调用契约，以及实际 Manifest `contracts.tools`、Tool metadata/policy；
- 读取必须绑定受信调用上下文；
- Tool 存在不代表所有 Agent 默认可调用，也不允许强行默认开启未获授权的工具。

**只有 Gate D 经批准才做剩余宿主及 Raw/MCP。**




---

## 7. 测试与验收：先验证价值，再验证产品

### 7.1 Gate A 真实性与证据源矩阵

| ID | 检查 | 必须得到的证据 |
|---|---|---|
| A-T01 | 使用现有 resolveLedgerActivationId | 与 ActivationDispatcher canonical 判定一致，无二套 Resolver |
| A-T02 | 同一 Prompt 可见 ID 关联多个 Artifact | 拒绝歧义，不按标题猜测 |
| A-T03 | readLedgerFileState: ok/empty/unreadable | 不可读不能被误报为 0 案例 |
| A-T04 | derivedFromPainIds 实际是 candidateId | 反查 canonical Pain；形成/复用语义不混 |
| A-T05 | 不同任务拓扑的 sourcePainId | 仅确认真实已有来源，不凭假定的单一 Diagnostician 链 |
| A-T06 | Codex governance_observation-only | 精确关联或明确标为不支持，纳入分母 |
| A-T07 | observation store 的现有 list 读路径 | 识别 writable openStore/WAL/schema ensure；不得作为纯只读 |
| A-T08 | 仅摘要、已删除、已过期、无法恢复的来源 | 明确计数并说明不能恢复的字段 |
| A-T09 | WorkBuddy Desktop 证据路径 | 从当前生产结构核实，而非借用 CodeBuddy CLI 假设 |
| A-T10 | 各宿主披露与撤销 | 列举生产函数/配置和未覆盖数据，非虚构的权限标签 |
| A-T11 | 已有第三方模块/PR 的复用情况 | 报告重复建设风险、正确源所有权和边界 |
| A-T12 | 实验样本是否可合法使用 | 允许来源、类型分母、敏感信息与外部模型规则 |

A-T03/07 要在安全的临时数据库夹具中验证缺文件与已有文件情形；“审计通过”不是在生产 DB 上运行 schema ensure 再口头说只读。

### 7.2 Gate B A/C 实验矩阵

B-T01：相同原则、相同模型和任务、固定任务评价标准，A 与 C 独立干净上下文。  
B-T02：历史确有帮助的情境（考察是否准确选择适用范围）。  
B-T03：原则已足够的情境（考察有无额外干扰/不合理等待）。  
B-T04：旧历史与新事实冲突的反例（考察负迁移/过度套用）。  
B-T05：人工 Oracle 证据确有稳定的 Pain 关系、来源、长度限制和 Owner 同意。  
B-T06：盲评最终动作/产物，不以背诵历史评分。  
B-T07：全部任务纳入成本，包括无改进、未使用证据和出错任务。  
B-T08：停止触发、遗漏样本、不确定性、预算使用记录完整。  
B-T09：不为了提高 C 组成绩修改原原则或系统指令。  
B-T10：不对未获得批准的数据/付费模型进行调用。

记录每个 case 的来源、评判结果、错误泛化、Owner 纠正时间/代理指标、输入/输出 Token、额外模型轮次、时延。实验规模与容忍阈值由 Owner **运行前**批准，不编造一个固定百分比判 PASS。

### 7.3 Gate C Core/CLI/宿主最小实现

| ID | 场景 | 预期 |
|---|---|---|
| C-T01 | 已存在一条有效 formed 关系 | list 返回唯一 canonical Pain ID |
| C-T02 | 后续多个 reused Pain | 均准确关联；同一 Pain 去重 |
| C-T03 | candidateId 被误当 painId | 明确测试拒绝错误解读 |
| C-T04 | 关联 Candidate/Pain 不一致、或双重原则映射 | 拒绝猜测，不返回错误案例 |
| C-T05 | Ledger 不可读、trajectory DB 不存在、schema 不兼容 | 返回 unavailable，绝不“正常 0 条” |
| C-T06 | 有效 Pain 仅摘要，无原文 Correction | 返回可信摘要，Correction=null/不冒充原话 |
| C-T07 | 仅有 Codex observation/sourceRef | 若 Gate A 允许该来源，则正确只读；否则明确不支持，不伪造 |
| C-T08 | 删除/过期/隔离、无披露资格 | 不读正文、拒绝或字段为空 |
| C-T09 | 宿主禁用、未授权 Principle、撤回原则 | 不允许通过 Recall Tool 越过原治理语义 |
| C-T10 | 超长、注入恶意指令、秘密/PII 字符串 | 脱敏、限长，不执行历史命令 |
| C-T11 | 输入有 workspace/raw/异常参数组合 | 拒绝；Agent 不能通过 Tool 改写可信上下文 |
| C-T12 | Query 内数据库缺失 | state.db/trajectory.db 不自动创建，业务数据/Schema 不被改写 |
| C-T13 | 真实宿主已安装包发现 Skill/Tool | 不能仅依赖测试桩；返回实际来源摘要 |
| C-T14 | 真实 Agent 明确要求 list→detail | 工具被执行，详情 Pain 与 list 关联一致 |
| C-T15 | Agent 没有提出 Recall | 不查询历史，不改 L0、审批、RuleHost |
| C-T16 | 真实 Agent 自主选择（不要求查询） | 记录自然调用、无关任务过度调用与最终效果 |
| C-T17 | 当前宿主卸载/禁用/升级 | 原有功能不回归；Recall 不留下越权入口 |
| C-T18 | 历史误用反例 | Agent 能保持当前更高优先级约束，不把历史变成新指令 |

**真实宿主功能 E2E 与自主实验必须分开判定。** 若在明确要求检索时不能调用 Tool，则集成失败；若无提示时模型没选择调用，不一定是集成失败，但自主产品收益仍不可认为已证实。

### 7.4 Gate D 三宿主产品验收

每个新增宿主至少分别证明：

1. 真正安装/启用的插件版本与 Manifest/Skill 发现；
2. 实际工具或 Skill 自主执行的请求/响应；
3. 该宿主正确 governance workspace/授权与关闭路径；
4. 当前数据库中真实形成/复用或缺失证据的处理；
5. 模型在适当与不适当场景下的选择行为；
6. 打包升级、禁用、卸载、撤销后的兼容；
7. Token/延迟/运维复杂度相对单宿主基线；
8. 未调用时 L0 注入、RuleHost、Owner 审批回归。

不能用 OpenClaw PASS 推断 Codex PASS，也不能用 CodeBuddy CLI PASS 推断 WorkBuddy Desktop PASS。

---

## 8. 生产实现最小工作包（Gate B GO 后才授权）

### C-PR01：Shared Read Query（仅需 LIST+DETAIL）

- 从现有 Ledger availability、resolveLedgerActivationId、Task/Candidate/PIArtifact、trajectory-store 等模块找最小组合；
- 增加原有 Store 缺少的、必要的少量只读查询函数，严禁内建新的通用 Evidence Graph / Resolver/Reader 类族；
- 仅对已授权的摘要来源进行投影；Observation 如需读取，留在既有数据所有者模块中用只读连接补单条读取；对没有可信来源直接 unavailable；
- 不生成状态、不缓存原文、不加表/索引、不改 Scribe/Diagnostician/RuleHost；
- 红灯测试覆盖身份、形成/复用、异常与无写入行为。

### C-PR02：仅一个真实宿主的 Agent Access

- 在 Gate A 选定宿主的**已有** Tool 或 Marketplace Skill 路径增加一个最小接入；
- 若需要 CLI，只增加可被已安装 runtime 定位的独立只读命令；已有 `pd trace show` 不变；
- 不建立新安装器；用已有插件更新/打包测试覆盖；
- 实际 Tool/Skill 发现、Shell/OS 权限、disabled 与 workspace 确认后再称 Pilot 接入完成；
- 其他两个宿主**不进入此 PR 的代码变更范围**，除非为兼容性明确不变性增加已有 fixture 测试。

### C-PR03：真实行为对照与独立复审

- B/A 对照 + 非强制触发任务；统计最终行动正确性、错误泛化、Owner 纠正和整体成本；
- 运行当前宿主、共享核心、RuleHost 既有回归；对未运行测试写 NOT_RUN；
- 输出实现复杂度和复用清单，明确 C-PR01/02 的新增生产文件、净行数、runtime dependency、schema、服务；
- 如果收益不足或隐私/权限未闭合，撤销 Tool/Skill 暴露，保留现有数据与原则能力，不对历史作任何迁移。

**不要求先创建“7 个 PR 包”或按三宿主分拆开发。** 实现单位服从已批准的最小 Pilot 与现有仓库团队流程。只有 Gate D 才根据新增宿主实际需要提出独立 PR。

---

## 9. 复杂度账本与停止约束

| 维度 | v1.2 Gate C 上限思路 | 如果必须扩大 |
|---|---|---|
| 新持久化事实权威 | 0 | 不允许为 Recall 新建 |
| SQLite schema/迁移 | 0 | 降级或另行产品决策；不自动迁移 |
| 新常驻服务/后台流程 | 0 | Gate C 不批准 |
| 新模型查询/检索排序 | 0（仅查询实现自身） | 另行提出成本与必要性 |
| 新跨宿主数据算法 | 0 | 所有宿主共享一个 Core 事实核验权威 |
| 新公开接口 | 最小 1 个 list/detail 契约 | 需提供旧接口无法表达的证据 |
| 新宿主适配 | **恰好 1 个** | 其他宿主只能 Gate D 批准 |
| Raw/全 Session | 0 | 需来源覆盖率、授权和单独 Gate |
| 新缓存/向量索引 | 0 | Gate C 不批准 |
| 安装/更新回归 | 仅选定真实宿主 | Gate D 再按宿主单独确认 |
| 行为与维护成本 | 实际测量 | 无可接受净收益则停止扩展 |

**复杂度要诚实记账**：新增文件/净 LOC/依赖数、跨包边界、错误面、Installer/CLI/Skill 后续维护费、模型上下文与等待时延。比起虚构一个总 LOC 上限，更重要的是每个新抽象有不可替代的消费方；若原有数据投影已足够完成 Gate B，则不为“架构优雅”写新查询框架。

---

## 10. v1.1 独立评审核查闭环

| 评审项 | 裁决 | v1.2 落点 |
|---|---|---|
| V1 收益验证太晚 | **采纳** | §0 H1/H2、§2 Gate B 前置 A/C、Gate C A/B、停止规则 |
| V2 四层读取与三宿主超出最小价值验证 | **有条件采纳** | §2 C 只需单宿主 LIST+DETAIL，Raw/MCP/其他宿主放 Gate D，三宿主仍是最终目标 |
| E1 重复实现原则身份解析 | **采纳** | §1.1 既有 resolveLedgerActivationId/readPromptActivationCandidates，§5.1 不另建 Resolver |
| E2 漏 Codex observation 与可写读取 | **采纳** | §1.4 各宿主 Evidence Source，§5.2 禁止直接用可写 openStore |
| E3 loadLedger 丢 availability | **采纳** | §1.2/§5.2 使用 readLedgerFileState，区分 empty/unreadable |
| E4 原文披露范围未冻结 | **采纳** | §3 逐宿主数据与授权矩阵，摘要许可先验证，Raw 首版禁止 |
| 可能将“无收益”断言为方向已被证伪 | **修正口径** | §2 Gate B 的 STOP 仅停止投资，UNPROVEN 不作统计否定 |
| 三宿主必须最终可用 | **保留原产品意图** | §2 Gate D/§7.4 的产品范围完整验收 |

**注意：** 表格中的“采纳”表示 SPEC 文档改变；不表示对应生产实现已完成、源码已全部修复、许可已获得或试验已通过。

### 10.1 v1.3 Gate A 审核定案（F-01～F-16 逐项核查，2026-10-17）

状态含义：RESOLVED＝在 v1.3 文档/审计中已闭环；OWNER_PENDING＝只能由 Owner 决策（决策卡）；GATE_B_TASK＝列为 Gate B 重点验证项；GATE_C＝Gate C 阶段处理。

| # | 发现 | v1.3 结论 |
|---|---|---|
| F-01 | 远端前进到 702d9223 并新增 PR #2048 | **RESOLVED**：基线更新为 702d9223；PR #2048 能力并入 §1.4/复用矩阵 §1.6 |
| F-02 | v1.2 为本地未跟踪文件 | **RESOLVED**：v1.3 基于 SHA256 校验过的 v1.2 副本修订；v1.2 与本校订文档随本轮文档 PR 一并纳入版本控制（不改写原内容） |
| F-03 | readLedgerFileState 三态不细分"不存在 vs 零字节" | **RESOLVED**：§1.2 四类结果映射（含 ok_but_empty_ledger）；不改写既有三态 API |
| F-04 | parseHybridLedger 结构异常宽松归空 | **RESOLVED**：§1.2 明确"语法合法但结构非法 → ok+空账本"，语义审查义务入契约 |
| F-05 | PR #2048 与 Recall 的重叠判断 | **RESOLVED**：§1.4 共享能力段 + §1.6 复用矩阵；Port ≠ Recall，禁止第二套读取权威 |
| F-06 | listGovernanceObservations 有写副作用 | **RESOLVED**：§1.4/§5.2 禁用为 Recall 入口；写副作用含缺库/存在库两分支均已实证 |
| F-07 | Gate A 审计与 Owner 冻结职责错位 | **RESOLVED**：审计票已 DONE（Linear PRI-997/998/999），结论 OWNER_DECISION_REQUIRED；Gate B 就绪性另判 BLOCKED |
| F-08 | capture/retention/egress/read-back 四能力区分 | **RESOLVED**：§3.1 增补；Codex read-back NOT_COVERED 列入 §1.4；WorkBuddy consent 未立项列为即便 Pilot 也暂缓的依据（决策卡 D-04） |
| F-09 | 真实覆盖率分栏规则 | **RESOLVED**：SOURCE_STATIC/TEST_FIXTURE/NOT_MEASURED 标注体系贯穿 §1 与审计报告；无虚构百分比 |
| F-10 | C 组 Oracle 材料限制 | **RESOLVED**：§2 Gate B 控制要求 + 实验方案文档材料规则；Raw 上界试验只能独立探索 |
| F-11 | candidate 集合 ≠ 注入集合 | **RESOLVED**：§1.1/§3.3 注明 render/budget/rotation 差异来源；真实差异分布 NOT_MEASURED，Gate C 测量 |
| F-12 | Linear CLI 权威路径 | **RESOLVED**：用户级 `~/.agents/skills/linear-cli/`（CLI 完成 start/comment/status；未调用 handoff） |
| F-13 | 只读边界字面混淆 | **RESOLVED**：审计于自建隔离目录运行夹具与报告；生产源码/真实 DB/宿主配置零改动（git status 前后证明） |
| F-14 | 审计票 Done 与准入 GO 分离 | **RESOLVED**：三票已 Done；GATE_B_EXECUTION_BLOCKED 维持 |
| F-15 | 结果必须可追踪 | **RESOLVED**：报告落在 `docs/implementation-reports/`，随本轮 PR 提交，脱敏关键发现同步 Linear 评论 |
| F-16 | “显著改善”不可事后定义 | **RESOLVED**：§2 Gate B 控制加 B0 预注册强制；实验方案文档定义业务可理解改善口径与 UNPROVEN 语义 |

**GATE_B_TASK（Gate B 重点验证项）**：PainChainReadModel 双匹配覆盖风险（`buildCandidateToLedgerEntryMap` Map.set last-write-wins）在真实数据中的发生频率与错误归属后果（关联审计 U1/U2）。
**OWNER_PENDING（决策卡裁决项）**：D-01～D-05 全部；在裁决前所有涉及真实数据、费用、宿主与授权的动作保持 `OWNER_DECISIONS_PENDING`。

---

## 11. 发布裁决、证据报告与 DoD

### 11.1 阶段状态

| 字段 | 当前值 |
|---|---|
| SPEC | v1.3 REVIEW READY；未冻结 |
| REALITY AUDIT / Gate A | **COMPLETE（2026-10-17，基线 702d9223；A-01～A-04 交付 + A-05～A-07 提案；30/30 夹具 PASS）** |
| VALUE / Gate B | **EXPERIMENT_PLAN_READY / EXECUTION BLOCKED（依赖决策卡 D-01～D-05 Owner 裁决）** |
| VALUE H1 / H2 | UNPROVEN / UNPROVEN |
| PILOT / Gate C | NOT_APPROVED / NOT_RUN |
| OPENCLAW HOST | NOT_RUN（Pilot 次选，未实施） |
| CODEX HOST | NOT_RUN（Pilot 首选建议，未实施） |
| WORKBUDDY DESKTOP HOST | NOT_RUN（暂缓，consent 未立项） |
| RAW | OUT_OF_SCOPE |
| MCP | OUT_OF_SCOPE |
| THREE-HOST GA | NOT_STARTED |
| RELEASE | NO-GO（尚无实现/实测证据，不是功能不可能） |

### 11.2 Gate 结束报告模板

~~~text
SPEC-PD-PRR-001（v1.3 或执行时对应版本）
Phase/Gate: A | B | C | D
Remote baseline / branch / workspace clean status:
Owner authorizations for data / model cost / production change:
Source coverage matrix (denominators, not cherry-picked):
Identity resolver reused / Ledger availability handling:
Evidence source & read-only proof:
Privacy / visibility / revoke decision & OS residual limits:
A/C or A/B task list, blind scoring, negative-transfer cases:
Final actions / Owner correction time / model cost / latency:
Selected Pilot host and why; other hosts NOT_RUN status:
New prod files / net LOC / new dependencies / schema / services:
Existing Hook/Prompt/RuleHost regression:
Unresolved P0/P1/P2, unavailable data, STOP risks:
Decision GO | CONDITIONAL GO | BLOCKED | STOP | NOT_RUN:
Owner review / next explicitly authorized phase:
~~~

### 11.3 Gate A 完成定义

- [x] 已按最新源码重新核实 `resolveLedgerActivationId`、Ledger availability、两种 Pain 关系和 host-runtime Observation（702d9223，夹具 30/30）；
- [x] 各来源覆盖分母、不可用情况、敏感数据与删除/保留策略明确（真实数据覆盖率如实标 NOT_MEASURED）；
- [x] 有逐宿主披露字段/授权/禁用/工作区矩阵，实际 Owner 决策项单独列出（A-04 + 决策卡 D-01～D-05）；
- [x] 明确最小价值试验任务、方法、模型、时间和费用；未获授权不执行付费实验（Gate B 实验方案已出，执行待批准）；
- [x] 选出并说明一个合理 Pilot 候选宿主；不改动生产实现（A-05：Codex 首选建议）。

### 11.4 Gate B 完成定义

- [ ] A/C 测试、三类任务（有帮助/无必要/负迁移）在事先固定评价标准下执行；
- [ ] 对最终产物进行评估，不用回忆复述分数替代行动正确性；
- [ ] 全部任务成本、额外 Token/时延、Owner 干预和安全事件如实报告；
- [ ] 预先冻结的继续/停止条件生效，收益不足时停止扩展；
- [ ] Owner 明确批准或否决是否进入 Gate C。

### 11.5 Gate C 完成定义

- [ ] 只有一个选定宿主生产接入；LIST+DETAIL summary，有界只读无 Raw；
- [ ] Identity 使用既有权威，形成/复用/歧义/丢库按事实降级；
- [ ] 已证明所披露摘要获得适当许可，不能靠字符串 host 标签伪装；
- [ ] 真正安装/启用的宿主发现并调用；disabled/rollback 不破坏旧功能；
- [ ] 功能性 E2E 与 Agent 自主选择实验分别报告；
- [ ] A/B 的实际收益、历史误用、总成本与维护复杂度审计清楚；
- [ ] 其余宿主、Raw、MCP 显示 NOT_RUN / OUT_OF_SCOPE；
- [ ] 无未关闭 P0/P1，Owner 明确做 Gate D 决策。

### 11.6 Gate D / 三宿主产品正式完成定义

- [ ] 三宿主的真实入口和安装/升级/禁用 E2E 独立 PASS；
- [ ] 共用 Core 与证据质量契约，无宿主专有 SQL/ID 归因复制；
- [ ] 已按宿主真实授权处理摘要披露，Raw 仅专项批准后存在；
- [ ] 各宿主显示自主检索收益或标为 UNPROVEN，不夸大收益；
- [ ] 生产发布前复审、回滚方案、Owner 最终授权完成。

---

## 12. 参考、未决问题与保存原则

### 12.1 内部依据

- `docs/specs/SPEC-PD-PRR-001-principle-pain-recall-v1.1.md`：原完整架构 SPEC，**保留不覆盖，供回溯**。
- `docs/specs/SPEC-PD-PRR-001-principle-pain-recall-v1.2.md`：v1.3 的直接基线（SHA256 `4422F14F2A6CBCD20F0AC50515E92622BAB77C0ABC0C819D06988CC89CEBD465`）。
- `docs/specs/SPEC-PD-PRR-001-v1.2-reality-audit-corrections-20261017.md`：F-01～F-16 独立复核与执行校订（v1.3 §10.1 逐项定案）。
- `docs/implementation-reports/SPEC-PD-PRR-001-v1.2-gate-a-reality-audit-20261017.md`：Gate A 审计报告（A-01～A-07）。
- `docs/specs/SPEC-PD-PRR-001-Gate-B-experiment-plan-20261017.md`：Gate B 最小真实数据实验方案。
- `docs/specs/SPEC-PD-PRR-001-Gate-B-owner-decision-card-20261017.md`：Gate B Owner 授权决策卡（D-01～D-05）。
- `docs/specs/SPEC-PD-PRR-001-Gate-A-to-B-admission-matrix-20261017.md`：Gate A→B 准入矩阵。
- `.tmp/prr-spec-review-20261016/REVIEW.md`：独立评审及其 `evidence/` 固定源码快照（与 f7d47ae0 对应）。
- `activation/ledger-identity.ts`、`activation/activation-dispatcher.ts`、`principle-tree-ledger.ts`、`pain-chain-read-model.ts`、`governance-observation-store.ts`、`trajectory-store.ts`、`host-runtime` 的 `workspace-behavior-evidence.ts`/`behavior-history.ts`/`behavior-example-pack-assembler.ts` 和宿主插件打包文件： Recall 实现前需按当时 HEAD 重新验证的源码权威。

### 12.2 必须留待 Gate A/Owner 决策

1. 实际已可披露的 Pain/Correction 摘要字段及 consent；是否允许送到外部模型？
2. Agent 范围是本轮实际注入、还是所有当前有效已授权激活原则？具体由哪段生产代码证明？
3. 各来源 Evidence Coverage，尤其 Codex Observation 与 WorkBuddy 的真实持久化链接和删除语义。
4. 首个 Pilot 选哪个宿主，为什么能以最低实现/维护代价验证 H2？
5. Gate B 的任务、成功/停止阈值、费用、日期、外部模型数据使用限制。
6. 如果 Shell 原生能力允许读取超出 PD Tool 的本地文件，Owner 接受怎样的实际隔离边界？
7. 原则与历史摘要的合法组合是否足以改善行为，还是原则本身不明确/诊断错误才是瓶颈？

任何一个问题如果会影响真实数据权限、成本或发布语义，都不能在工程实现中偷偷替 Owner 作决定。允许因缺证据而报告 BLOCKED；不以搭建新系统填补空白。

### 12.3 外部接口与真实运行边界

- OpenClaw Plugin Manifest/Tools：https://docs.openclaw.ai/plugins/manifest
- Codex Plugin & Skills：https://developers.openai.com/plugins/build/plugins
- CodeBuddy 插件技能：https://www.codebuddy.ai/docs/cli/plugins-reference

外部文档说明某接口有实现路径，**不等于当前某个 OpenClaw Gateway、Codex Desktop/CLI 或 WorkBuddy Desktop 的 PD 插件已经安装且能自动使用**。Gate C/D 必须使用已安装真实产物实测。

---

**最终裁决：** v1.3 的状态是 `SPEC_REVISION_READY_FOR_REVIEW`：Gate A 审计已完成并冻结，Gate B 实验方案与 Owner 决策卡已就绪，**Gate B 真实执行授权仍为 PENDING（GATE_B_EXECUTION_BLOCKED）**；PRI-1000 与 Recall 实现均未启动。全量三宿主开发、Raw 和 MCP **均未获得本 SPEC 的启动授权**。只有历史经验对实际 Agent 判断有可接受的增量，并且最小自主读取能够可靠复现收益时，才按证据继续扩展。

**SPEC-PD-PRR-001 v1.3 END**

