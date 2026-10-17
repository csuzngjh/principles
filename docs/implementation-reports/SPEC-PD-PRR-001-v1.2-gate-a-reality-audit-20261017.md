# SPEC-PD-PRR-001 v1.2 — Gate A Reality Audit 报告（PRI-997 / 998 / 999）

| 项 | 值 |
|---|---|
| 审计日期 | 2026-10-17 |
| 审计者 | OpenCode（GLM-5.3-Flash Free）会话，非交互目标模式 |
| 代码事实基线 | `origin/main` = `702d922339851f54579a4f159a91c801af9810b2`（`git rev-parse origin/main` == `git ls-remote origin refs/heads/main`，已双核验） |
| 本地 HEAD | `39ebac3f56dc5394844284166c867d2266b159a7`（落后，仅只读，未 checkout/reset/merge） |
| 本地 HEAD 与基线关系 | `39ebac3f` 是 `702d9223` 的祖先（`git merge-base --is-ancestor` 验证） |
| LF 原 SPEC 校验 | SHA256 `4422F14F2A6CBCD20F0AC50515E92622BAB77C0ABC0C819D06988CC89CEBD465` ✅ 与校订报告一致 |
| 依据文档 | SPEC v1.2（本地未跟踪）+ `SPEC-PD-PRR-001-v1.2-reality-audit-corrections-20261017.md`（F-01～F-16）+ `SPEC-PD-PRR-001-Gate-A-Zcode-verified-20261017.md` |
| 关联 Linear | PRI-996（父）→ PRI-997/998/999（本轮 3 票，均已 In Progress→本报告交付）；PRI-1000 被三票阻塞 |
| 只读边界 | 未修改任何生产源码 / 真实 `.pd`、`.state`、`~/.pd/runtime` / 宿主配置 / Owner 治理状态 / 工作树既有用户文件；未运行付费模型；未创建 commit/PR |

> 证据标注约定：`SOURCE_STATIC`（固定 SHA 静态源码证据）、`TEST_FIXTURE`（完全合成数据的隔离夹具运行）、`AUTHORIZED_REAL_SAMPLE`（获授权真实样本）、`NOT_MEASURED`（无授权样本，分母未知）。本轮**零 `AUTHORIZED_REAL_SAMPLE`**：未读取任何真实私有历史。

---

## A-01 Data Map — Principle→Artifact→Ledger→Candidate/Task→Pain（PRI-997）

### 1. 身份解析权威：已存在，复用即可，无二套实现 ❗

| 事实 | 位置（702d922 基线） | 标注 |
|---|---|---|
| `resolveLedgerActivationId(artifact, deps)` | `packages/principles-core/src/runtime-v2/activation/ledger-identity.ts:121–174`。判定顺序：Ledger 可用性 → 结构化 `sourcePrincipleId`（必须为 Ledger 形状 UUID 且 Ledger 实际包含，否则数据漂移拒绝）→ Dreamer Artifact lineage（contentTrace `sourceTrace.dreamerArtifactId` 优先，`lineageArtifactIds` 含 `-dreamer-` 回退）→ Dreamer task seed `diagnostic_json.candidateId`（spelling 回退）。**0 或 多匹配一律 unresolved 拒绝猜测** | SOURCE_STATIC + TEST_FIXTURE |
| 消费者 | `activation/activation-dispatcher.ts:197–223`（`resolveActivationIdentity` 在任何状态变更前调用，`ledger-identity.ts` 由 `:23` 引入；line 204 调用） | SOURCE_STATIC |
| 无 title/文本相似度猜测路径 | resolver 全链仅用结构化 ID 与成员判定；不可读 Ledger 不归属 drift 而是显式 `ledger_unavailable`（PRI-915 语义） | SOURCE_STATIC |

**夹具证据（fixture-ledger，13/13 PASS，TEST_FIXTURE）**：
- 带 Ledger 成员 UUID 的直接 ID → `resolved`(direct_validated)；带非成员 UUID → `unresolved:principle_not_in_ledger`（不回退 lineage 猜测）；
- candidate 映射 2 条 Ledger 原则 → `unresolved`（拒绝猜测）；映射 1 条 → `resolved`(candidate_lineage);
- 不可读 Ledger → `ledger_unavailable`；
- ACTIVATION 与拟议 Recall 使用同一 resolver 的 canonical 规则一致性：**PASS**（复用即可，不需要也不允许新增身份算法）。

### 2. Ledger 可用性三态与宽容解析

| 事实 | 位置 | 标注 |
|---|---|---|
| `readLedgerFileState(stateDir)` | `packages/principles-core/src/principle-tree-ledger.ts:153–174`：文件不存在 → `{status:'empty'}`；零字节/仅空白 → `empty`；`JSON.parse` 失败 → `unreadable`（带 problem） | SOURCE_STATIC |
| `loadLedger()` | 同文件 `:453–454`，仅返回 `readLedgerFileState().ledger`，**丢弃 availability**——Recall 不得以它判定可用性 | SOURCE_STATIC |
| `parseHybridLedger(raw)` | `packages/principles-core/src/runtime-v2/principle-tree/ledger-codec.ts:155–163`：`isRecord(raw)` 为假（如 `[]`、`"str"`、`123`、`null`）→ 静默返回空 store，`readLedgerFileState` 报 **`ok`** 且账本为空 | SOURCE_STATIC + TEST_FIXTURE |

**夹具证据（F-03 / F-04 全部验证，TEST_FIXTURE）**：
- 缺文件 → `empty`；合法 JSON → `ok`；零字节 → `empty`；空白 → `empty`；坏 JSON → `unreadable`；
- **`['[]','"just a string"','12345','null']` 四种语法合法但结构非法文件全部报 `ok`**（不是 unreadable）——区分"账本真空"与"结构坏损被宽松解析归空"必须另行校验 `data.shape`/`principles` 内容，不能预设坏结构 → unreadable；
- `loadLedger()` 在 `ok` 与其他态都返回 store（无 availability 字段）——复证 E3。
- 结论：Recall 的错误映射应为四类结果：`ok(有数据)` / `ok_but_empty_ledger`（含结构坏损被归空的情况，需语义审查） / `empty`（真空账本或零字节，如需细分根因另查文件存在性+size） / `unreadable`。

### 3. Pain 形成与复用反向链

| 事实 | 位置 | 标注 |
|---|---|---|
| `derivedFromPainIds` 存的是 candidateId | `packages/principles-core/src/runtime-v2/pain-chain-read-model.ts:55–88`：`buildCandidateToLedgerEntryMap` 直接注释"**the field stores candidate ids despite its legacy pain-oriented name**"；`derivedFromPainIds[]` 元素按 `map.set(cid, e.id)` 建 candidate→ledger 映射 | SOURCE_STATIC |
| `reuseEvidence[]` 是独立来源 | 同文件 `:78–86`：`ev.candidateId` → `map.set(candidateId, e.id)`；Ledger 写入方 `principle-tree-ledger.ts:528–701`（`validateReuseEvidenceEntry`/`appendReuseEvidence:588`） | SOURCE_STATIC |
| **silent Map overwrite 风险确认** | 同文件 `:68–88`：同一 candidateId 出现在多个 principle 条目（或同一 principle 的 derivedFromPainIds 与另一 principle 的 reuseEvidence 交叉）时，`Map.set` 后写覆盖先写，**无冲突检测**。反向查询若只取 map（PainChainReadModel 现消费的方式），会将最后写入的归属当作真实归属。Recall 实现必须：正查得 list 或显式 ambiguous，不得沿用 last-write-wins | SOURCE_STATIC |
| Pain 反向链已有 Operator 权威 | `PainChainReadModel` 当前消费者：`packages/pd-cli/src/commands/trace.ts`、`health.ts`、`packages/pd-console/src/server/models/HealthCheckModel.ts`——**Recall 应扩展此类既有读取层，而不是新造读模型** | SOURCE_STATIC |
| Task `sourcePainId` 多拓扑 | `internalization/intake-to-internalization-bridge.ts:39,248,278,284,293,323`（可选字段）；`sourcePainId` 在 60+ 生产/测试位置被消费（dreamer-runner、base-peer-runner、pitask-metadata、sqlite-task-store、source-trace-locator 等）——不存在单一固定 Diagnostician 链假设成立，**candidateId 必须经 seed 的 `sourcePainId`/受信 lineage 反查真实 Pain** | SOURCE_STATIC |
| Identity resolver 对 dreamer seed 的依赖 | `ledger-identity.ts:97–109`：`candidateIdFromDreamerSeed(diagnosticJson)` 读 seed 顶层的 `candidateId`；与 bridge 写入字段一致 | SOURCE_STATIC |

**A-01 结论**：Principle→Artifact→canonical Ledger ID→Candidate/Task→Pain 反向关系**静态可达**，全部依赖已有权威（resolveLedgerActivationId + readLedgerFileState 保留 availability + PainChainReadModel 类读取层）。缺失：跨 candidate/Pain 歧义场景的显式 ambiguous 判定（PainChainReadModel Map.set 覆写是唯一已识别的错误归属风险）。**无需新增身份算法；无 lineage 图引擎需求**。

---

## A-02 Evidence Coverage — Host × Evidence Source 矩阵（PRI-998）

### SCHEMA_CAPABILITY（静态代码可达性，702d922 基线）

| Host | Source | 表/存储 | 与 Pain 关联锚点 | Recall 可用片段 |
|---|---|---|---|---|
| OpenClaw | Pain 事件 | `<ws>/.state/trajectory.db` `pain_events.canonical_pain_id`（写：OpenClaw `TrajectoryDatabase`） | canonical Pain ID 直查 | 摘要 + lineage |
| OpenClaw | User turns / Correction 证据 | 同库 `user_turns`（`raw_text` / `blob_ref` / `raw_excerpt` 400 字符摘录）+ `TRAJECTORY_BLOBS_DIR` blob 落盘 | `getCorrectionTurnByRowid(rowid)`（openclaw trajectory.ts:1161–1186， PRI-844）：raw → blob → excerpt 三级回退，text 为空返回 undefined | Rowid 恢复正文≠证明轮次属于目标 Pain——仍需 lineage 证明 |
| Codex | 治理观察 | 同库 `governance_observations`（由 admission 写入）：`visible_text` + `sanitized_tool_facts_json`，retention_class（operational/promoted/expired/rolled_back/quarantined） | `sourceRef = governance_observation:<logical_key>`（governance-signal-admission.ts:600/617）；显式 Owner 语句另有 `correctionEvidence{text,classification:'owner_statement',channel:'codex_explicit_prefix'}`（:573,622,956–962）经脱敏 | observation-only 情形必须纳入分母；有 observation ≠ 有完整 Raw，更 ≠ Owner Correction 已关联 |
| Codex | Tool 证据 / hook 事件 | `codex_pd_hook_event_log`（经 host-runtime `intervention-evidence-ingress.ts:43` 单一入口） | 同上 | — |
| WorkBuddy | Hook 事件 | `workbuddy_pd_hook_event_log`（冻结 source kind；ADR-0027; `workbuddy-evidence-recorder.ts`，best-effort 写入经共享 ingress） | 通过共享 pain 路径 | **无独立 transcript 采集 consent；行为观察 capability 自报 `unknown`**。不得以 CodeBuddy CLI 文档推断 Desktop 行为 |
| 手工/摘要 | Pain 结构化描述 | Pain 事件摘要字段（诊断/描述） | painId | 只能披露已授权摘要，不能伪造轮次 |
| 三宿主共享 | **PR #2048 行为证据能力** | `host-runtime`：`BehaviorExamplePackAssembler`（PRI-484/PRI-992）+ `behavior-history.ts` + `createWorkspaceBehaviorEvidencePort`（`workspace-behavior-evidence.ts`） | canonical Pain（`pain_events.canonical_pain_id`）→ **Owner 显式选定**的工具行为样例（`sourceNegativeToolCallId` + 1..3 `positiveToolCallIds` + Owner 自然语言期望结果）→ 行为事实/历史窗口 | **真实复用机会**：只读 sqlite（`readonly:true, fileMustExist:true`）+ 单事务快照 + `better-sqlite3` 直开，无创建无迁移；并有结构化 rc/ERR 防护与 fail-loud。**边界**：输入是 Owner 挑选的工具调用 ID，不是任意历史检索；输出是内部化 worker 的 BehaviorExamplePack，**不等于通用 Recall、也不证明 Owner Correction 原话关联**。消费方：codex workspace-worker、host-runtime internalization-consumer-cycle、openclaw 内部化服务、pd-cli runtime-internalization 命令——均为内部化管线，无 Agent 可调用入口 |

**与 Recall 的重叠判定（F-05 核心结论）**：`createWorkspaceBehaviorEvidencePort` 的打开/快照/关闭模式与 LIST+DETAIL(summary) 所需的"严格只读 trajectory.db 单条精确读取"为同一能力家族；Gate C 若实现 Recall 的 LIST，可复用该 Port 的打开策略与 pain lineage 锚点（`getPainEventByCanonicalId`），摘要类读取需新增的手段是：按已验证 Pain 关系抽取持久化 Pain 摘要/诊断摘要的**最小单条只读查询**（不建新 Reader 家族、不建通用 Evidence Graph）。**禁止重复实现**：身份解析、WAL/schema-ensure 式 observation list、OpenClaw 可写 `TrajectoryDatabase` 包装读取。

### EMPIRICAL_COVERAGE（真实数据分母）

**全部 `NOT_MEASURED`**。未获 Owner 授权读取真实工作区/DB 样本，因此：各 host × source 的真实分母、有效摘要率、精确锚点率、删除/过期计数、unavailable 占比一律未知——**不是 0%，不是 100%**，不写任何虚构命中率。`FIXTURE_ONLY` 统计仅来自下方 A-03 合成夹具，不得当作生产覆盖率。
（关联：PRI-959 手工 Owner 反馈取证范围决定仍开放，不在此裁决。）

---

## A-03 Read-only Proof Plan（PRI-997/998 共同交付）

### 每种读取入口的打开参数、副作用、失败合同（702d922）

| 入口 | 打开参数 | 副作用 | 缺库/缺 Schema 行为 | 标注 |
|---|---|---|---|---|
| `SqliteConnection({workspaceDir, readonly:true, bootstrapIfMissing:false})` | better-sqlite3 `{readonly:true, fileMustExist:true}` | 无（readonly 不设 WAL/pragma） | 抛错，**不创建任何文件/目录** | SOURCE_STATIC（sqlite-connection.ts:86–125）+ TEST_FIXTURE |
| **危险默认**：`SqliteConnection({workspaceDir, readonly:true})`（缺省 bootstrapIfMissing=true） | — | **会以写模式 bootstrap：创建 `.pd/state.db` + initSchema/migrate** | 缺库即创建 | SOURCE_STATIC（:103–121）+ TEST_FIXTURE。**任何新增的只读调用方必须显式传 false；`readPromptActivationCandidates` 已正确传 false（active-principle-prompt.ts:90）** |
| `openTrajectoryDbReadonly(workspaceDir)` | `{readonly:true}`（先 `existsSync` 判定） | 无 | 抛 `TrajectoryDbUnavailableError`（dbPath+reason），不静默返回空 | SOURCE_STATIC（trajectory-store.ts:96–106，rc-3/rc-9 注释）+ TEST_FIXTURE |
| `listGovernanceObservations` / 任何 governance observation list | **writable** `new Database(path)` + `busy_timeout` + **`journal_mode=WAL`** + **`ensureGovernanceObservationSchema`**（CREATE/ALTER/版本行写入）（governance-observation-store.ts:337–352, 299–318） | **对已存在 DB 有写副作用；missing DB 则优雅降级 `trajectory_db_not_found` 且不创建** | — | SOURCE_STATIC + TEST_FIXTURE。**Recall 不得直接复用此 list 作只读入口**（F-06 精确化：开启侧不会在缺库时新造 DB，但已存在库会被 WAL/schema-ensure 触碰） |
| PR #2048 `createWorkspaceBehaviorEvidencePort` | better-sqlite3 `{readonly:true, fileMustExist:true}`；单 `db.transaction` 读快照；`finally db.close()` | 无（缺 host tool declaration 时抛 typed `evidence_source_error`；不算forged proof） | 抛错，不建库 | SOURCE_STATIC（workspace-behavior-evidence.ts:1, 49–70）+ TEST_FIXTURE |
| OpenClaw `TrajectoryDatabase`（**不适用只读**） | 可写构造器：`mkdirSync(blobDir)` + `pruneUnreferencedBlobs()`（trajectory.ts:196–201, 313–329） | **构造即有写副作用** | — | SOURCE_STATIC。Recall 只读路径禁止经它打开 |
| `.pd/host-tool-semantics/<hostKind>.json`（authorization-adjacent） | 每个 host 独立声明文件；合并顺序无关；冲突 canonicalKind fail-loud | 无 | 无声明时报 invalid，**不回退 baseline**（ERR-114） | SOURCE_STATIC（host-tool-semantic-resolver.ts） |

### 夹具执行结果（全部合成数据，FIXTURE_ONLY，17/17 PASS）

1. SqliteConnection readonly+no-bootstrap：缺库 → 抛错且 **不创建 `.pd/state.db`、不创建 `.pd` 目录**；
2. 对照组：readonly 缺省参数（bootstrapIfMissing=true）→ **确实写模式 bootstrap 创建 state.db**（风险默认实证，任何新只读调用方需显式 false）；
3. `openTrajectoryDbReadonly` 缺库 → `TrajectoryDbUnavailableError` 且不创建 `.state`；
4. `listGovernanceObservations` 缺库 → 降级 `trajectory_db_not_found` 且**不创建文件**；已存在但无 governance schema 的合成库 → 返回 ok 且**顺带创建 governance_* 全套表并把 journal_mode 翻成 WAL**（写副作用实证——不得当只读入口）；
5. PR #2048 Port：缺库 → typed throw 且不创建；已存在 fixture 库 → 成功 assemble（`pain_events.canonical_pain_id` + `tool_calls` 两表最小数据），**结束后 govTables=0（无新增表）、journal_mode 保持 delete（无 WAL 翻转）**——纯读通过。

### 保留/删除/失效语义（A-08 类事实）

- `retention_class ∈ {operational, promoted, expired, rolled_back, quarantined}`（intervention-evidence-contract.ts:46–47 同名；observation 表 702d922:239）；过期/回滚写路径将 `visible_text` 与 `sanitized_tool_facts_json` **置 NULL**（governance-observation-store.ts:453–462、498–516）→ 到期正文不可恢复；quarantine 为"正文已丢、仅保留元数据"的审计态。Recall 必须按 class 过滤并把非 operational/promoted 映射为正文 `unavailable` + reason，而不是当作空。
- OpenClaw `user_turns` raw 可被 blob 离线化（inline threshold / `pruneUnreferencedBlobs` 7 天孤儿宽限）→ 即使有 rowid，正文也可能只有 excerpt（evidenceQuality 须标 `excerpt_only`；text 为空则返回 undefined——`unavailable` 真值可行）。

---

## A-04 Disclosure Matrix + 授权/撤回/Shell 边界（PRI-999）

### 字段 × 宿主矩阵（全部真实生产事实；未授权项不替 Owner 决定）

| 字段 | OpenClaw | Codex | WorkBuddy | 现有 consent 覆盖 | Agent read-back 缺口 |
|---|---|---|---|---|---|
| Principle statement 文本 | 注入 prompt（features.prompt.enabled，active-principle-prompt.ts） | 同（Marketplace plugin 注入） | host.workbuddy 默认 OFF（feature-flag-contract.ts:339） | **VERIFIED_EXISTING**——原则文本 Agent 本就可见（注入即披露） | 无（本来可见） |
| Pain 摘要（结构化描述） | 由 pain 路径持久化 | 同 | 共享 pain 路径 | 采集属 Pain 生命周期；**Agent 再披露无既有许可** | **NOT_COVERED**（需 Owner 决策） |
| 诊断摘要（模型诊断） | Diagnostician 输出持久化 | 同 | 同 | 诊断属内部流程；Agent read-back 无许可 | **NOT_COVERED**；且不得被当 Owner Correction |
| Owner Correction 摘录 | correction queue 400 字符摘录 + rowid 正文恢复（PRI-844） | `correctionEvidence`（owner_statement / codex_explicit_prefix，经 sanitizeString 脱敏，admission :573–622） | **无 self-report 采集通道**（recorder 自报 unsupported） | **capture 已授权**（见下），**read-back NOT_COVERED** | **NOT_COVERED** |
| Raw 原文 | user_turns raw/blob | observation `visible_text`（≤32 轮/≤7 天窗口） | 无采集 | capture-only；**Raw read-back 未批准** | **NOT_COVERED**；SPEC 首版 0 Raw 保持 |
| Tool Facts | tool_calls | `sanitized_tool_facts_json`（落盘前敏感格式脱敏） | hook 记录（capability 自报 unknown） | capture（ingestion consent 范围内） | **NOT_COVERED** |
| Codex 诊断外发 | — | G2A 冻结文本：升级证据发往配置的 LLM API（唯一外发路径） | — | VERIFIED_EXISTING（codex-disclosure.ts 全文 + guard 测试钉死） | 与 read-back 无关，不得混用 |

### capture / retention / diagnosis egress / agent read-back 四能力区分（F-08 核心结论）

Codex `getCodexIngestionDisclosureText()`（G2A frozen, zh/en 全文已核对，702d922）授权的是：
1. **capture**：读取可见 transcript（32 条/7 天；隐藏思考、系统提示、环境上下文丢弃）；
2. **retention**：operational 窗口 + 升级证据长期治理生命周期；
3. **diagnosis egress**：升级片段发送配置的 LLM API；
4. **agent read-back：文中完整冻结文本只字未提**——关闭时"根本不打开 transcript"，已存内容到期清除/显式清理，卸载不删证据。**开启 ingestion ≠ 允许 Agent 通过未来 Recall 读取任何历史**。五种状态（pending/granted/revoked/failed/flag_on_without_grant，codex-ingestion-consent.ts:52–79）全部以 per-workspace feature flag 为运行时权威。

### 提供者（enforcement owner）与撤回/禁用（真实函数）

| 能力 | 控制点 | 真实生产路径 |
|---|---|---|
| Prompt 注入启停 | `features.prompt.enabled`（.pd/config.yaml） | active-principle-prompt.ts:72–78 flag off → aborted；
| Codex 总闸 | `host.codex.enabled=false`（pd-disable kill switch：hooks 返回 neutral，无业务写入，幂等；plugin 本身不删） | skills/pd-disable/SKILL.md（702d922） |
| Codex 采集闸 | `codex_conversation_ingestion`（quiet，default off：flag-off=零 transcript 读取、零 observation 写） | feature-flag-contract.ts:404 |
| WorkBuddy 总闸 | `host.workbuddy`（quiet，default off；flag-off=neutral JSON+exit 0+observable skip、不 dispatch 不读 transcript） | feature-flag-contract.ts:339; plugin.json `defaultEnabled:false`；workspace 恒为 `~/.workbuddy/pd-workspace`（workspace-resolution.ts:27–45，**绝不回用其他宿主库**） |
| 撤回原则 / 停用宿主后的可见性 | 现有 Activation/Ledger 生命周期 | （Recall 尚未存在；Gate C 必须使 read-back 在闸检查之后执行——这是设计义务，不是已有能力） |

### 候选资格集合 vs 实际注入集合（F-11，二者不等价的代码证明）

`readPromptActivationCandidates`（active-principle-prompt.ts:61–129）返回 **candidate + excluded 划分**（Prompt flag gate、FIFO activation、artifact 校验、排除集）。真正的注入由 `buildActivePrinciplePromptContext`（:131–174+）决定：**预算截断（RUNTIME_V2_PRINCIPLE_BUDGET）、PRI-904 fair-rotation（roundKey）、oversized/dropped 分区、legacy FIFO 回退策略**都可能进一步删减。**结论：Agent "本轮实际收到的原则集合" = 渲染产物，不能由候选集合推断；Recall 资格若绑定注入历史，需要渲染侧事实而非 candidate 列表；更保守的候选设计（以宿主有权披露的有效激活原则为界）已在 SPEC §3.3 冻结为默认方向**。当前二者差异属实现层可测事实，本轮以静态证据说明差异来源，未运行真实注入窗口（NOT_RUN）。

### Shell 残余风险（真实 OS 边界）

- Codex/WorkBuddy 一旦走 Skill+CLI：Agent 拿着 Shell 即可 `node pd-cli ...` 或直接读 `.state`/`.pd` 文件——**Skill 文本不是访问控制**（SPEC §3.2 已冻结此判断）。 hiding `--workspace` 参数不能阻止直接文件读取；
- Operator CLI（`pd trace show --pain-id` 等，PainChainReadModel 消费者 pd-cli/trace+health）是 Operator 特权，与 Agent 产品权限分属不同信任上下文；
- OpenClaw Tool 路径可绑定可信 SDK invocation 上下文（`registerTool` 在 openclaw-sdk.ts:186 有类型面，但**当前插件未注册任何 Agent Tool；openclaw.plugin.json 无 contracts.tools**）——新增工具属真实宿主面改动，Gate C 处理；
- **无法由 PD 生产代码阻止的读取**=宿主 Sandbox/客户终端既有能力（保持，不新增授权服务）。

### Owner 必须决策的事项（OWNER_DECISION_REQUIRED 清单）

1. A4/A6：是否允许 Gate B 使用**脱敏后**的 Pain/CORRECTION 摘要送第三方模型（含哪些字段、长度预算、模型清单与费用上限）；
2. Recall 资格边界：本轮实际注入集合 vs 宿主有权披露的有效激活集合（§3.3 默认保守式需 Owner 确认）；
3. Codex observation-only 与 `correctionEvidence` 摘录在 read-back 语义下是否成为可披露摘要源（现 NOT_COVERED）；
4. WorkBuddy：是否先补 transcript/Pain 采集 consent 再谈 Pilot（现数据侧最弱）；
5. PRI-959（手工 Owner 反馈是否计 pain 证据）——本审计不裁决。

---

## A-05 Pilot 宿主候选比较（建议，不执行）

| 维度 | OpenClaw | Codex | WorkBuddy Desktop |
|---|---|---|---|
| 历史 Evidence 丰富度 | **最佳**：canonical Pain + user_turns raw/blob/excerpt（exact 锚点可达） | 中：observation-only 为主；`correctionEvidence` 有；exact 前 12 轮升级存在 | 最弱：hook 事件链 + 无 transcript consent；capability 自报 unknown |
| 最小新增连接 | 需要 manifest `contracts.tools`/Tool SDK 注册（现有类型面在、无实例） | **已具备 5 个 Marketplace Skills + workspace worker；新增 1 Skill + 1 只读 CLI 命令即可** | 需新增 Skills 目录 + Installer 缓存实测（实测项最多） |
| Consent/披露地基 | Pain 采集属默认治理；无独立 G2A 式 read-back 冻结文本 | **G2A 披露文本/consent 流/kill switch 已存在**（可扩展为 read-back 授权决策的最短路径） | 无（需先立项 consent） |
| 即时可用 E2E 差距 | 要先注册真实 Tool | Skill+CLI 即可跑，但 Shell 隔离弱 | 最高（Desktop 实机链路未验证） |
| 风险 | 无 Tool 实例先例 | Shell 残余读取风险恒存（矩阵中如实呈现） | 数据侧不足，收益验证会被证据面拖垮 |

**建议**：以 **Codex 为首选候选**（B 阶段数据授权流程可以 G2A 文本延伸决策、Skill+CLI 最小接线、已有 worker/脱敏管线），**OpenClaw 为次选**（证据最富，但要先做 manifest/tool 注册，宿主面改动大于 Codex），**WorkBuddy 暂缓**（NOT_RUN；等 consent 立项）。该建议仅供 Owner 在 Gate B 批准时复核，本轮不实施任何宿主接入。

---

## A-06 Gate B 实验提案骨架（可批准卡片，未执行）

- **假设**：H1（正确历史 > 仅原则）与 H2（自主按需 recall 可靠变现 H1）分别验证（SPEC §0）。
- **组别**：A（同原则无历史）/ **C（人工 Oracle，材料遵守与预期 Pilot 同级数据类别+脱敏+长度预算+授权，F-10）**。Raw 上界试验若另做，仅记独立探索，不作 Gate C GO 依据。
- **任务集**（SPEC §7.2）：历史有帮助（a）、原则已足够（b）、旧情境与新约束冲突的负迁移（c），含真正需产出新动作的任务，非复述事故。
- **控制**：任务/评分/费用上限/隐私红线/停止点在查看结果前冻结（B0 预注册）；同模型/温度/工具预算/原则文本/输入，A/C 独立干净上下文；评判盲于组别；统计全部任务成本与净行动质量，不挑成功样本。
- **费用与样本**：`NOT_MEASURED`——待 Owner 批准字段/模型/预算后由 Owner 定注册（任何固定阈值/样本数均不预设）。
- **停止**：C 组无可观察收益、旧史导致不可接受错误泛化、或出现敏感泄露 → STOP 当前工程投资（不同等于"方向被证伪"）。
- **Gate C 的 A/B**（自主 B 组）仅在 B 条件 GO 且 C 阶段单独批准后于选定宿主进行。

---

## A-07 Uncertainties（未能验证的事实与下一步证据）

| # | 未决事实 | 原因 | 下一步 |
|---|---|---|---|
| U1 | 各宿主真实数据覆盖率/分母 | 未授权读真实历史（F-09 分栏规则） | Owner 授权范围后最小只读采样（或授权统计） |
| U2 | candidate↔多个 principle 的生产发生频率 | 依赖真实 Ledger 数据 | 数据侧随 U1 |
| U3 | Codex observation→Pain 的精确关联率（sourceRef 追溯成功率） | 同 U1 | 授权后按 logicalKey 抽样回溯 |
| U4 | `readPromptActivationCandidates` 候选集与实际注入集在真实轮次的差异分布 | 需真实宿主运行窗口（本轮 NOT_RUN） | Gate C E2E 内测量 |
| U5 | payload 级 payload 危险：pending observation（tails 未完成）在横向读取时的正确拒绝行为 | 未运行真实 hook | Gate C C-T 系列测试 |
| U6 | WorkBuddy Desktop 插件技能加载/安装器缓存行为 | 未实测（禁以 CodeBuddy CLI 文档推断） | Gate A 已冻结边界；如 Owner 选 WorkBuddy 需真实 Desktop 试跑 |
| U7 | Blob 过期（7 天孤儿宽限）后 rowid 正文恢复真实失败率 | 未读真实库 | 随 U1 |
| U8 | Gate B 材料集的具体构成/费用 | Owner 未批 | A-06 骨架 + Owner 卡 |

---

## 附：证据索引

- 固定基线快照：`.tmp/gate-a-prr-20261017/*.702d922.txt`（`git show 702d922...` 文本）；
- 只读源码镜像（`git archive` 702d922）：`.tmp/gate-a-prr-20261017/core-mirror/`（仅合成夹具使用）；
- 夹具脚本与结果：`.tmp/gate-a-prr-20261017/fixture/fixture-ledger.ts`（13/13 PASS）、`fixture/fixture-sqlite.ts`（17/17 PASS）、`*`-result.json；临时运行目录均自建并在运行后删除；
- 独立评审快照：`.tmp/prr-spec-review-20261016/REVIEW.md` + `evidence/`（f7d47ae0 基线，历史不可变参考）；
- 工作树保护：审计全程未改动用户已有未提交文件（`git status --porcelain=v1` 前后仅新增本报告与 `.tmp/` 产物，见 §"工作树保护证明"）。

**阶段状态**：GATE_A_AUDIT_COMPLETE（A-01～A-04 交付 + A-05～A-07 建议/提案）；`GATE_B_READY = BLOCKED`（依赖 Owner 批准 A-04 决策项 + A-06 注册）；真实宿主 E2E / 真实数据库扫描 / Agent 实验 / Recall 实现 / PRI-1000 = NOT_RUN。

**SPEC-PD-PRR-001 v1.2 / Gate A 审计报告 END**
