# SPEC-PD-PRR-001 v1.1 — Principle Pain Recall
## 基于现有证据链的三宿主按需渐进式回忆

| 字段 | 值 |
|---|---|
| 状态 | **PROPOSED / SPEC REVIEW READY；未实施、未通过三宿主 E2E** |
| 日期 | 2026-10-16 |
| 基线 | origin/main = f7d47ae0f68b3cf5576300c2c3c9e32e9f6daedd（实施前重新核实） |
| 目标宿主 | OpenClaw、Codex、WorkBuddy Desktop |
| 优先级 | P1 |
| 前版 | SPEC-PD-PRR-001 v1.0（对话草案） |
| 核心约束 | 最大化现有代码复用；一个共享查询；禁止新增存储、索引、常驻服务及非必要框架 |

> **状态说明：** 本 SPEC 依托 2026-10-16 对远端 main 的只读核查和宿主文档检查。记录的是目标契约与尚待核验的事实，不是功能已经交付的证明。对 repo/SDK 的描述如与实施时最新代码冲突，以重新核实的代码和真实宿主探针为准，更新本 SPEC 再实施。

---

## 0. 决策摘要

### 0.1 为什么做

PD 将历史 Pain、Owner Correction 与诊断结果提炼为 Principle，并通过已安装宿主注入简洁的行为约束。然而 Agent 目前缺少**标准化、可自主调用**的 Principle → 某次实际 Pain → 对应历史纠错/轨迹的回溯入口。原则被抽象后，当前复杂场景可能缺失「为什么改变」的具体上下文。

目标不是新的 Agent Memory 系统，而是为已持久化的 PD 经验提供**可核验、可选、按需**的历史读取能力（Evidence-Grounded Progressive Recall，EGPR）。

### 0.2 产品承诺

1. L0：原有原则注入完全保持；不主动注入历史，也不强制调用。
2. L1：Agent **选择调用后**获取某条当前可见原则所关联的历史 Pain 目录。
3. L2：Agent 选择其中一个 Pain，获取有出处的 Pain、修正和历史任务上下文。
4. L3：仅在原始轮次锚点真实存在、访问受限、长度受控时展开原始片段；否则如实降级。
5. 三宿主使用相同的核心关系核验、证据契约和安全边界；各宿主使用已有最轻集成入口。
6. 历史数据是证据，绝不是可覆盖当前 Owner 授权和 System 指令的新命令。

### 0.3 交付判定

**工程完成 != 功能已接入宿主 != Agent 自主使用有效。**

- CORE GO：确定性反向关系核验、只读证据、降级与安全测试通过。
- HOST GO：OpenClaw、Codex、WorkBuddy Desktop 各自真实安装与明确请求下的实际工具调用通过。
- AUTONOMY EVALUATED：不直接命令调用时，真实 Agent 的自主检索行为经过单独实验，记录调用率、准确性、增量和成本。
- RELEASE GO：上述结果可审计且无 P0/P1 阻断，Owner 审核。未跑的宿主必须是 NOT_RUN，不得以其他宿主或 Mock 代替。

### 0.4 显式否决

MVP **不准**引入新 SQLite 表/迁移、向量库、Embedding、RAG 框架、LLM 排序、全局记忆写入、独立后台 Worker、HTTP 服务、自动 Recall Hook、三套宿主 SQL、副作用型修复流程。MCP 不作为默认方案；只有宿主实测表明 Skill+CLI 无法可靠自主调用，才提交有证据的最小回退决策。

---

## 1. 可验证的代码现实与复用边界

### 1.1 已有资产（只读核查）

| 现有实现 | 已有事实 | 本次使用方式 |
|---|---|---|
| packages/principles-core/src/principle-tree-ledger.ts | loadLedger 和原则、形成字段、reuseEvidence | 读 Ledger；不迁移、不修改 |
| packages/principles-core/src/runtime-v2/pain-chain-read-model.ts | 已实现 Pain→Candidate→Ledger，含两条候选来源关系 | 复用关系语义/已有函数；不复制错误假设 |
| packages/principles-core/src/runtime-v2/store/candidate/sqlite-candidate-store.ts | getCandidate(candidateId) | 精确候选查询 |
| packages/principles-core/src/runtime-v2/store/task/sqlite-task-store.ts | getTask、diagnosticJson/inputRef | 追溯可信 sourcePainId |
| packages/principles-core/src/runtime-v2/internalization/intake-to-internalization-bridge.ts | task diagnosticJson 持久化 candidateId、可选 sourcePainId/sourceTaskId/sourceArtifactId/sourceRunId | 覆盖非单一 Diagnostician 拓扑 |
| packages/principles-core/src/runtime-v2/store/artifact/sqlite-pi-artifact-store.ts | Artifact/来源读接口 | 身份与 lineage 校验，按需使用 |
| packages/principles-core/src/trajectory-store.ts | openTrajectoryDbReadonly()：文件缺失即报错、不写入 | 优先复用 trajectory.db 只读入口 |
| packages/principles-core/src/runtime-v2/store/context/trajectory-turn-reader.ts | 已有原始轨迹读取契约 | 优先复用，不保证所有 Raw 数据完整 |
| packages/openclaw-plugin/src/core/trajectory.ts | getPainEventByCanonicalId、getCorrectionTurnByRowid 等实现 | 只复用必要查询语义；Core 不依赖 OpenClaw 整包 |
| packages/host-runtime/src/active-principle-prompt.ts | 已用 readonly:true + bootstrapIfMissing:false 读取激活；返回 principleId/artifactId/activationId | 借鉴已有安全读取与激活身份投影 |
| packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts | 现有注入输出 directive id；artifact 允许 title 回退为 ID | **不假设注入 ID 恒等于 Ledger canonical ID** |
| packages/pd-cli/src/commands/trace.ts | pd trace show --pain-id 为正向观察命令 | 不修改旧契约；新增独立只读命令 |
| packages/openclaw-plugin/src/openclaw-sdk.ts | 声明 registerTool，但 AgentTool TS 结构简化 | 依据真实宿主 SDK 补最小 Tool 接口/Manifest |
| plugins/principles-disciple/ | **已存在 Codex Marketplace 插件、skills、包装脚本及打包测试** | 直接在既有插件资产扩展 |
| packages/workbuddy-adapter/plugin/ | **当前仅有 Manifest、Hooks、Wrapper，尚无 Skills** | 在既有插件根目录最小增加 Skill |

### 1.2 关键历史语义

- Ledger 的 derivedFromPainIds 虽以 Pain 命名，但当前形成路径写入的是 **candidateId**。不能把它直接当 canonical Pain ID。
- reuseEvidence[] 含 painId 与 candidateId；属于后续复用关系，必须与形成来源区分。
- pain-chain-read-model 的 buildCandidateToLedgerEntryMap 采用 Map.set()，在重复候选冲突时存在“后项覆盖前项”的可能；反向查询不得复制 silent last-write-wins。
- Console PrincipleTrajectoryModel 只消费部分形成信息且有字段语义偏差；不作为 Recall 核心实现。
- 历史的 raw_text 可能离线至 blob、只保留 excerpt 或已清理。准确降级优先于“尽力猜测”。

### 1.3 主分支与现有工作区

实施前执行只读：git ls-remote origin refs/heads/main、git status --short、git rev-parse HEAD/origin/main、相关目录 git grep；审计已有 PR 或同类读取实现。用户当前 D:\Code\principles 的本地 main 相比 origin/main 落后且存在未提交文档；**只能在基于最新 origin/main 的隔离 worktree 中开发，严禁重置、覆盖、清理用户未提交文件**。本次文档写入例外仅新增此 SPEC 文件，不触及其他路径。

---

## 2. 目标与非目标

### 2.1 必须达成

G-01：准确由当前已授权可见的 Principle 反向找到零至多个经核实 Pain（形成和复用）。
G-02：支持低成本 LIST→DETAIL→可选 RAW；不需要系统性追加 Prompt 文本。
G-03：Owner Correction 及原始轮次只有精确锚点且关联可验证时才声明 exact。
G-04：调用方与查询核心分离；一个 Core 契约、一个 CLI 核心命令、三宿主薄适配。
G-05：不为查询增加新副作用，不改变已有审批、Activation、RuleHost、纠错收集、清理逻辑。
G-06：缺失/损坏/撤回/跨工作区/无权限都可解释降级或拒绝，不伪造证据。
G-07：由真实宿主安装和调用证明能力可用，而非仅静态文件/测试桩通过。

### 2.2 明确不做

- 历史相似度全局检索；全库聊天搜索；Embedding/BM25/MRR 优化；模型重写摘要。
- 自动将历史经验升级为新行为规则；历史案例的“直接执行”；历史数据重新回填。
- 新的跨宿主统一工作区、跨 workspace 联邦查询或跨 Owner 权限委托。
- 把现有 CLI 的 Operator 调试能力转换为无条件全局 Agent 工具权限。
- 规定所有 Agent 在每个可能需要回忆的场景都必须使用工具。
- 为缺失证据虚构 Outcome、Owner Correction 或过去采取的动作。

---

## 3. 交互与数据语义

### 3.1 四层渐进式读取（只有一个新 Agent Tool）

| 层级 | 数据 | 触发 |
|---|---|---|
| L0 Principle | 当前已注入的 statement/directive；无新历史文本 | 现有 Prompt 路径 |
| L1 List | 形成/复用 Pain 目录；有限可核实摘要 | Agent 主动 list |
| L2 Detail | 某次 Pain 背景、可信纠错、诊断引用及其证据质量 | Agent 主动 detail(summary) |
| L3 Raw | 确切轮次、关联工具调用及有限前后文；可不可用 | Agent 主动 detail(raw) |

禁止默认自动 LIST、系统强制工具调用或扩展现有 RUNTIME_V2_PRINCIPLE_BUDGET。用户无需知道案例 ID 即可通过原则 ID 得到目录。

### 3.2 原则身份优先级

**强制区分三个身份：**
- ledgerPrincipleId：Ledger 中的稳定主键；
- activatedPrincipleId：激活 Artifact 解析后注入的字符串（可能存在 title fallback）；
- artifactId/activationId：宿主激活来源。

调用者默认传 L0 实际可见的 ID，受信适配层应基于当前权限内的 Activation/Artifact 精确解析到唯一 Ledger Principle；必须校验来源。仅在有受信映射时允许展示。ID 一致**不自动证明**访问授权；两个候选匹配或无确定映射时 ambiguous/not_linked，不以 statement/text/title 语义相似方式猜测。

不为了本功能改动已有 L0 序列化文本；如果实际发现极少数已有 ID 无法可靠关联，报告缺口并与 Owner 协商独立兼容策略，不在 MVP 静默生成新 ID。

### 3.3 初始形成与复用

**形成**：对 derivedFromPainIds[i] **按 candidateId** 查 Candidate→真实来源 Task、seed diagnosticJson、Artifact lineage；优先可信持久化 sourcePainId，辅以已有 Diagnostician/PainChain 校验。允许合法的多级 dreamer/philosopher/scribe Task 拓扑；不能默认只存在一个 Diagnostician Task。由 sourcePainId 回查 trajectory.db canonical_pain_id，并验证当前 workspace 与关联身份。解析失败时不可返回 verified。

**复用**：读取当前原则 reuseEvidence[] 中 decision=reuse 的记录；核验 candidateId 对应候选/任务链及 painId，确保一致。不得因为 reuseEvidence 源自 Ledger 就省略其跨库一致性核验。

**去重与冲突**：同一原则同一 Pain 仅一条案例，保留形成/复用的可核实来源类型；对一个 candidate 关联多个原则、多个不同 pain 或关系不一致，不采用 last-write-wins，而返回可观察冲突，不猜测。对无法核实项计数/降级，不得作为正常 case 展示。

### 3.4 Evidence quality（逐字段）

- exact：明确证据 ID，来源 Pain、Session、Turn/Artifact/Task 外键或等价稳定事实全部校验通过；真实原文/可恢复存档。
- excerpt_only：稳定来源真实，但保留的只是截断摘录，必须显式 truncated。
- context_only：能证明同一历史 session 或 task 相关，但不能确认为该 Pain 的原始纠错/工具轮次；**不能标记为 Owner Correction exact**。
- unavailable：缺失、删除、权限拒绝、无法解码或来源冲突；返回 null 和 reason。
- inferred 不允许出现在可信证据字段；模型推断的 Diagnosis 必须标为 diagnostic_assessment，不能伪装 Owner 原话。

禁止使用 getLatestCorrectionTurn 按“最近”来事后归因历史 Pain。getCorrectionTurnByRowid 只保证恢复该 Row，不能代替关联核验。Outcome 仅依据实际 outcome/receipt/验证记录；否则 not_recorded。



---

## 4. 统一输入/输出契约

### 4.1 精简为一个能力、两个操作

生产代码只提供一个公开查询入口；LIST 与 DETAIL 使用判别联合类型，禁止无效参数组合。伪类型：

~~~ts
type RecallQuery =
  | { mode: 'list'; principleId: string; limit?: number; offset?: number }
  | { mode: 'detail'; principleId: string; painId: string; level?: 'summary' | 'raw' };

// 可信调用上下文不属于 Agent 可填的工具 Schema。
// 具体类型/命名遵照现有代码；避免引入新通用框架。
type RecallTrustedContext = {
  workspaceDir: string;
  hostKind: 'openclaw' | 'codex' | 'workbuddy';
  resolvedVisibility: 'agent_active' | 'operator_explicit';
};
~~~

- 原则 ID、Pain ID 使用当前系统真实 ID 规则验证，不人为重新发明狭窄 ID 正则；拒绝空白、控制字符与超长字符串。
- limit 默认 5、最大 20；offset 非负、有合理上限；排序按已有可信 occurredAt DESC，再按 painId ASC 保证稳定。跨调用并发新增历史可能改变 offset 分页，因此不保证快照隔离；MVP 如无确切大规模案例需求可只返回前 20 和 hasMore，不提前建设 cursor/index。
- workspaceDir 只能来自可信宿主接入和 Operator 已有工作区解析；**Agent Tool Schema 不包含任意 workspaceDir、SQL、文件路径、sessionId**。
- Agent 不得通过传入 artifactId 强制枚举其他历史 Artifact；artifactId 仅在受信上下文内部作身份佐证。必要时明确核查谁有权限查询哪些 ID。
- 出于实现精简，Core 函数命名与封装可从现有 store/reader 中寻找最小切入点，不强制新增单独 PrincipleExperienceReadModel 类；“一个逻辑权威”优先于“一个新类”。

### 4.2 LIST 响应

示意，数据为测试伪例而非真实 Pain：

~~~json
{
  "status": "ok",
  "mode": "list",
  "principleId": "P-example",
  "cases": [
    {
      "painId": "pain-example",
      "sourceKinds": ["created"],
      "occurredAt": "2026-09-01T08:00:00Z",
      "summary": "已持久化的 Pain 摘录",
      "summarySource": "pain_event",
      "evidence": "excerpt_only",
      "hasDetail": true
    }
  ],
  "hasMore": false,
  "degradedReasons": [],
  "unresolvedSourceCount": 0
}
~~~

LIST 的 summary 必须选自明确字段（如 pain_events.reason/text、已校验的候选描述），标记 summarySource；不能由 LLM 融合后冒充原始事实。内容在输出前脱敏、确定性裁剪。每个 case 至少能提供经过核验的 Pain ID；缺失者计入 unresolvedSourceCount 并给可读降级原因，不进入正常 cases。

### 4.3 DETAIL summary 响应

~~~json
{
  "status": "partial",
  "mode": "detail",
  "principleId": "P-example",
  "painId": "pain-example",
  "sourceKinds": ["created"],
  "pain": {
    "text": "真实 Pain 的有界内容",
    "source": "pain_events",
    "quality": "exact"
  },
  "ownerCorrection": {
    "text": null,
    "quality": "unavailable",
    "reference": null
  },
  "diagnosis": {
    "text": "已有诊断摘要",
    "source": "diagnostic_artifact",
    "quality": "exact"
  },
  "outcome": {
    "status": "not_recorded",
    "text": null
  },
  "evidenceRefs": [],
  "degradedReasons": ["owner_correction_not_anchored"],
  "truncated": false
}
~~~

- 因为 Owner Correction 不存在而 status=partial，不得把不存在写成「纠正成功」。
- Diagnosis 只代表当时模型/管线的诊断产物，不能标记为 Owner 观点或客观根因。若并非精确证据，其 quality 必须降级。
- Outcome 仅允许 not_recorded、recorded_with_reference 等有明确依据的状态；不根据原则激活成功推定最终行为改变成功。
- 任何可读文本仅来源已持久化的内容；禁止请求 LLM 新做总结、补全历史。

### 4.4 DETAIL raw

~~~json
{
  "mode": "detail",
  "principleId": "P-example",
  "painId": "pain-example",
  "level": "raw"
}
~~~

Raw 是 DETAIL 的可选 level，不需要第三个 Tool。若无精确引用则可返回与 summary 相同的可靠字段，并报告 raw_evidence_unavailable，**不按时间邻近、session 最新 turn 或全库相似度猜测**。原始文本保留具体证据 ref、时间、截断/摘录标志；不得不加区别把邻近会话内容放进“当时的纠正”。

### 4.5 状态采用清晰的互斥类别

MVP 顶层 status 只需要：ok、partial、not_found、denied、unavailable、invalid_input、error。
用稳定的 reasonCode 精细区分：principle_not_active、identity_ambiguous、pain_not_linked、database_missing、historical_evidence_deleted、workspace_uninitialized、host_disabled、permission_denied、schema_incompatible、source_conflict 等。

- ok：所请求层级的全部可承诺内容存在；
- partial：部分字段或某个来源缺失，真实有效部分仍返回；
- not_found：身份或 Pain 本来不存在；不能用于掩盖数据库打不开；
- denied：访问范围或治理开关拒绝；
- unavailable：可观察的缺库/损坏/证据丢失；
- invalid_input：参数形态不合法；
- error：其他异常，去敏后给稳定 reasonCode。

LIST 有零案例不等于数据库不可用。内部日志可含可追踪的结构化 code，但不能输出敏感内容、凭证或原始堆栈。响应 JSON 不包含未验证的路径。

### 4.6 输出预算与性能（待基准核验的目标）

- LIST 默认 5、最大 20；DETAIL summary 默认约 3500 字符、硬限 5000；Raw 默认约 5000、硬限 8000。**先脱敏后截断**，保留截断标记，且预算含全部可见正文与引用字段。
- 同一查询最多读取必要的明确关联记录，连接统一 finally close；不扫描全部 trajectory 文本、不无界反序列化大量 Artifact。
- 初始 p95 候选目标：LIST ≤500ms，DETAIL summary ≤1000ms，DETAIL raw ≤2000ms；用至少三种真实/合成规模测得，达不到时先 profiling，不预先建设缓存或索引。
- 额外 LLM 调用为 0。**不调用时不得有额外历史 DB 读取**；Agent Tool schema/Skill 元数据可能产生少量固定上下文成本，不能承诺严格 0 Token，应实测记录。
- 不调用 Recall 时，现有 Prompt 的 payload、选择顺序、budget、RuleHost 判定、权限和状态写入路径保持基线一致。

---

## 5. 权限与安全契约（P0 修订）

### 5.1 威胁模型的诚实边界

分清三类角色：

1. **Owner Operator CLI**：通过现有终端按已有 OS 文件权限和 PD Operator 语义运行，可显式选择工作区；其范围不能自动转授 Agent。
2. **受控 Agent Tool**：如 OpenClaw 已认证的宿主内工具，工作区/宿主身份来自可信上下文，Tool 参数不应允许改写；可按现有激活/治理配置收窄可见原则。
3. **有任意 Shell 权限的 Agent**：通过 Skill 调用 CLI 时，可以修改命令参数、cwd 或环境变量；Skill 的文字说明本身**不是可信安全边界**。如果 OS 已允许读取别的工作区，PD CLI 的“从参数推断宿主”不能伪装成强访问控制。不要设计可自行伪造的 --host 值当作认证。

验收必须说明每个宿主的实际权限模型和剩余风险；对无法保证的隔离不宣称强隔离。优先依赖**已有**工作区限制、Owner 显式安装/启停和 OS 沙箱；不为一个只读功能建设新的全局权限服务。若所需保密性不能在现有宿主权限内实现，应阻断该接入场景，而不是声称已修复。

### 5.2 Agent 允许查询的原则范围

默认 Agent 模式为 **当前宿主、当前治理工作区中已授权且仍处于可用状态的原则**。至少校验：

- PD 对应宿主没有被显式禁用；
- 工作区解析符合该宿主已有权限边界；
- 提供的原则身份与 Activation/Artifact/Ledger 的有效关联唯一；
- 该原则并非只存在于待审批、已撤回或不允许向 Agent 展示的记录中；
- 不通过猜测的 title/statement 做来源匹配。

**重要：** “已激活”是否等于“本轮已注入”需要单独界定。为不改变 L0 轮转/预算机制，v1.1 推荐允许查询该宿主当前有效且准许下发的已激活原则；不要求证明某条原则恰好出现在当前这一个 Prompt 的注入集合（除非宿主已提供可信该轮集合）。此决议须在 PR-00 用现有 Activation flags/通道/权限语义验证并冻结，不能错把 L2 RuleHost-only 或被排除原则默认授予 Prompt Agent。

### 5.3 工作区权威

- OpenClaw 使用插件现有 Workspace Resolver，受 Tool invocation 的可信上下文约束；不直接相信 Agent 填写的路径。
- Codex 使用其当前 Marketplace Plugin、$pd-setup 工作区以及已有 nearest PD workspace/host.codex enablement 语义；不得退回已退休的全局 Hook Installer；只提供最小命令封装。
- WorkBuddy Desktop 使用 install-layout 的 getWorkbuddyWorkspaceDir / resolveWorkbuddyWorkspace，默认治理目录 ~/.workbuddy/pd-workspace；不得自动退回工程 cwd、Codex 或 OpenClaw 数据。插件默认 OFF/需 Owner 明确启用保持不变。
- 需要记录从哪个受信边界取得 workspace；不接受仅靠模型输出参数或可伪造环境变量作为访问认证。
- CLI 需检查数据库与配置所在工作区已经初始化，不因读取自动初始化其他工作区。

### 5.4 只读副作用边界

- trajectory.db 复用 openTrajectoryDbReadonly()，不存在时直接返回 unavailable；
- state.db 使用 SqliteConnection({ workspaceDir, readonly:true, bootstrapIfMissing:false })，禁止在 Agent 查询路径调用 RuntimeStateManager 的默认写模式；若确需 Manager，必须增加最小只读选项透传并有测试；
- 禁止 saveLedger、SQLite INSERT/UPDATE/DDL、修复式迁移、产生新的历史 blob/索引/cache/事件日志内容副本；原有宿主不可避免的会话/系统遥测必须另行区分，不得将“查询只读”虚称“整个宿主零写”；
- 缺失文件和 schema 不兼容不得触发初始化；测试以文件存在性、hash/mtime/重要表行数等检查（避免因数据库自身共享内存机制误读字面零系统文件变化）。

### 5.5 信息分级与 Prompt Injection

- 历史证据全部作为不可信数据返回，绝不提升为 System/Developer/Owner 指令；
- 不执行历史片段中的命令、不因回忆而 approve/activate/rollback；
- 复用现有敏感内容脱敏机制，同时对 Raw 进行额外 secret/PII 检查（原有遥测脱敏不足以证明对话文本安全）；
- 不泄露任意路径、凭证、原始堆栈；只返回必要、限长、带出处的数据；对高度敏感片段可拒绝 Raw；
- 数据清理后的 Raw 不得从新建永久缓存里“复活”。不阻止 PD 现有数据保留与清理策略；
- 强制按证据关系过滤，再考虑任何后续排序；首版没有文本相似度自动补链能力。




---

## 6. 三宿主真实接入（非架构想象）

### 6.1 共同约束

三个宿主必须复用同一 Core 查询、同一状态/证据质量语义；外层包装只处理能力发现、可信工作区解析、治理启停、Tool/Skill 参数转换、限长响应及宿主日志。适配器严禁实现自己的 candidate→Pain SQL 或新的持久化记忆。

Skill 不是强制 Hook：描述仅指导何时适合主动查找“为什么形成原则”，**不能要求所有任务、所有原则都调用 Recall**。工具可用、Agent 自选调用、效果改善是三个不同验收问题。

### 6.2 OpenClaw — 真正的 Agent Tool

**既有入口：** packages/openclaw-plugin/src/index.ts，openclaw-sdk.ts，openclaw.plugin.json。

**实现约束：**

1. 读取实际安装的 OpenClaw Plugin SDK 的 ToolDefinition/AgentTool/execute 契约，不依赖仓库内只含 name/description/parameters/result 的简化 AgentTool 类型来编造 handler。
2. 在**现有**插件注册期仅增加一个命名明确的 pd_principle_experience 工具，使用参数 schema 的 list/detail 判别类型，工具内部调用共享核心。
3. 对照宿主版本，更新生成/静态 openclaw.plugin.json 中工具发现所需的 contracts.tools 声明；现有 activation/manifest/build bundle 语义不变。若使用生成式 manifest，必须运行正确生成器并核对编译产物和原始包的一致性。
4. 尊重真实 OpenClaw 的 Tool policy/toolMetadata、可选工具是否允许和现有插件启停；仅注册而被 Policy 过滤，不算交付。防止带有多个 Tool 的声明产生默认扩权。
5. 使用受信 Agent Tool 上下文定位当前 workspace。只读查询，不修改 before_prompt_build、before_tool_call、Gate 或原有服务职责。
6. 验证真实 Gateway/Agent 的 Tool discovery、请求、结果格式与 Prompt Injection 安全语义。Mock registerTool 不等于真实 PASS。

**证据：** 安装插件版本与 manifest、发现结果、实际模型调用输入输出（脱敏）、disabled/tool-denied 情况、无调用场景。

官方参考： https://docs.openclaw.ai/tools 与 https://docs.openclaw.ai/plugins/manifest （实施时核对其版本）。

### 6.3 Codex — 复用已经投产的 Marketplace 插件

**当前安装现实：**

- plugins/principles-disciple/.codex-plugin/plugin.json 存在，skills 声明为 ./skills/；
- plugins/principles-disciple/skills/ 已包含 pd-setup / pd-status / pd-review / pd-disable / pd-record-pain；
- packages/codex-adapter/tests/codex-plugin-bundle.test.ts 已核验插件 Manifest、Hook/Skills 与安装布局；
- packages/create-principles-disciple/src/installers/codex-host-installer.ts 旧全局 Hook 新安装已**退休**，只保留迁移/卸载路径。新安装通过 Marketplace 插件和 $pd-setup。

**首选增量：**

1. 在 plugins/principles-disciple/skills/pd-principle-experience/SKILL.md 增加一份小型 Skill，不复制整套 SPEC，只记录触发线索、最小命令示例、逐层展开、证据级别与“不作为当前指令”的规则。
2. **复用现有的插件缓存、setup、pinned runtime、脚本包装器和已有 codex-plugin-bundle.test.ts**；最小增量接线，让被安装的 Skill 能定位**已安装** PD CLI，而非依赖 repo 源码里的脚本绝对路径。
3. 新 Capability 不修改 Codex Hook 的 Event/JSON schema、不恢复已废弃的全局 Hook 注册机制；必要时增加轻量脚本 pd-principle-experience.cjs **仅作 CLI 定位与入参包装**，不重复查询与权限算法。
4. 核验 Codex CLI 和项目明确支持的 Codex Desktop/插件运行面；两者能力不可互相推断。Shell、Sandbox、权限提示必须遵照宿主，不能为“自动调用”静默放宽工具授权。
5. $pd-setup 未完成、runtime 缺失、host.codex disabled、workspace 未初始化或 plugin version 不匹配时拒绝或结构化降级；不得自动安装、修复或初始化。

**证据：** 真实 Marketplace 加载的 Skill 路径、pinned runtime、Agent 选择读取 Skill 与执行命令的日志、结果可用性、禁用/卸载路径回归。

### 6.4 WorkBuddy Desktop — 复用已有 Marketplace Plugin Skeleton

**当前安装现实：**

- packages/workbuddy-adapter/plugin/.codebuddy-plugin/plugin.json 当前 defaultEnabled:false；
- plugin/hooks/hooks.json 与 scripts/wrapper.cjs 已存在；
- **当前仓库插件根目录尚无 skills/**；
- packages/create-principles-disciple/src/installers/workbuddy-host-installer.ts 已具备插件 Skeleton 拷贝、Marketplace 注册及版本化缓存；
- packages/workbuddy-adapter/src/workspace-resolution.ts 定义 WorkBuddy 专用治理工作区（默认 ~/.workbuddy/pd-workspace），不能静默跨宿主回退；
- WorkBuddy Desktop 与独立 CodeBuddy CLI 不应视为同一验收对象。

**首选增量：**

1. 在 packages/workbuddy-adapter/plugin/skills/pd-principle-experience/SKILL.md 增加小型、可选 Skill；默认目录须位于**插件根**而非 .codebuddy-plugin 内。
2. 既有 Installer 应自动携带此目录到 PD-owned Marketplace 与真正的插件缓存；核实版本、更新、卸载时的行为，不能手动改用户插件缓存以让测试通过。
3. 用已安装的 WorkBuddy Desktop、实际版本、实际插件加载状态验证 Skill 被自动发现；文档支持插件 Skills 只能作为设计依据，**不能替代当前 Desktop 实测**。
4. 查询工作区来自 WorkBuddy 自己的治理工作区解析；Host OFF 不得允许新的 Agent 读取入口绕过治理。不得因新增 Skill 误触已有 Hook fail-closed / fail-open 行为。
5. 尽量复用 CLI；如果 WorkBuddy Agent 只有 Bash 等原生工具，则其具体启动命令和实际 PATH/插件脚本路径必须在真实 Windows 环境证明。不要假定 CLI 全局可调用或复制宿主注册目录。

**证据：** 真实桌面引擎身份/版本、Plugin cache 的 Skill 文件、Agent 发现与命令执行、CLI 指向的治理工作区、OFF/ON/更新/卸载的 E2E。

官方参考： https://www.codebuddy.ai/docs/cli/plugins-reference 和 https://www.codebuddy.ai/docs/cli/plugins （CodeBuddy 文档到 WorkBuddy Desktop 的适配结论必须靠桌面实测支持）。

### 6.5 Skill + CLI 不成立时的有条件回退

不得预先创建 MCP Server。任一宿主必须先提供：安装后无法自主使用 Skill+CLI 的复现、CLI/宿主权限与路径事实、已尝试的现有最小接口及为何无法修复的结论。PR-00 的 Owner Review Card 决定是否允许一份**共享、本地、只读、stdio MCP 入口**；如果授权：

- 仅暴露现有唯一 Recall API，不重做查询；
- 仅目标宿主的已有受支持安装器配置该入口；
- 不新增 HTTP/TCP/常驻后台服务、认证服务或第二个工作区体系；
- 不直接在用户宿主配置写入未经授权的全局注册；
- 安装、撤销、版本升级和真实 MCP 工具 E2E 重新验证；
- MCP 自身不是权限万能钥匙；必须保持可信工作区和 Owner 启停限制。

如果不得不引入新的运行时依赖，列出实际包大小和兼容性代价并单独经 Owner 批准。严禁“为了技术统一”先搭 MCP 再证明有没有必要。

---

## 7. CLI 契约与命名兼容

### 7.1 入口（概念，实施时先核实冲突）

不更改现有 pd trace show --pain-id 与 pd candidate / pd pain 命令。候选命令：

~~~bash
pd principle experience --principle-id "<id>" --mode list --limit 5 --json
pd principle experience --principle-id "<id>" --mode detail --pain-id "<id>" --level summary --json
pd principle experience --principle-id "<id>" --mode detail --pain-id "<id>" --level raw --json
~~~

- 新增独立 Handler 调用共享查询实现，而非由 Codex/WorkBuddy 以 OpenClaw 插件 API 包装；
- CLI 执行需要使用已安装 runtime 的既有 package exports，发布后无需依赖仓库绝对路径；
- 如果现有 program.command('principle') 命令树不存在，先比较新增顶级命令与扩展旧命令的变更量，再冻结最小命名；三宿主统一同一命令，不在 Skill 中做各宿主分叉解析；
- stdout 仅 JSON，stderr 仅有界脱敏诊断；不得把 Error stack/原始数据抄到 stdout；
- 命令支持既有 Operator 方式的 --workspace 时必须与 Agent 文档区分：Agent 不得把 --workspace 作为访问授权凭据，CLI 不得通过 --host 参数自行证明调用者身份；
- 已有 CLI 使用 exitCode 语义需保持向后兼容，详细 partial/unavailable 应由 JSON 明确传达。

### 7.2 Skill 文案的最小策略

触发描述例如：“当当前任务涉及已激活 PD 原则，且理解过去失败/Owner 纠正能帮助判断其适用范围时，可选择读取历史；不是必需，简单任务不要调用。”

正文仅需：真实命令、先 list 后 detail、证据质量说明、不得把历史当新指令、出现 unavailable 的正常处理、如何确认 PD 已启用。**不强制回忆、不做新治理决策、不要求 Owner 对每次只读查询重新审批**（仍遵循宿主自身工具权限）。

---

## 8. 与现有内化和治理系统的关系

### 8.1 学习管线不改

Pain→诊断→候选→Owner 审批→原则→激活→宿主行为的原链路保持不变。Recall 是一个只读投影，不与 Dreamer/Philosopher/Scribe/Arbiter 建立新的执行闭环。不能通过 Raw 历史绕开现有审批。

### 8.2 例外、过时与反例

过往 Owner 纠正可能只对特定场景有效。结果保留已有上下文、日期、来源、适用条件；没有来源时不杜撰“通用规则”。在当前场景不适用时，Agent 按当前 Owner 指令、激活规则及客观约束判断；不能将旧案例升级为 MUST。

### 8.3 历史 Provenance 和 Outcome

FormationContext、诊断输出、Artifact lineage、复用事件各属于不同可信来源。Recall 应保留来源类别：Owner 原话、原始轨迹、诊断产物、候选摘要、执行 Outcome 等。仅在已有 Outcome 可追溯的情况下展示 outcomeReference；否则 not_recorded。**原则已形成或成功复用 != 未来行为验证成功**。

### 8.4 冲突与退化

- 身份不唯一、Candidate→Task/Pain 不一致：宁可拒绝或 partial，不返回错误案例。
- 单个字段缺失：其余字段可返回，并逐项标注质量。
- 样本仅手动报告，没有精准 User Turn：返回真实 Pain 摘要，不虚构具体会话纠正。
- 数据清理/旧 schema：可诊断，不升级读取连接为写模式修复。
- 安全与治理拒绝：不可用优先于从其他宿主或原始路径补齐。




---

## 9. 实施工作包与范围纪律

### PR-00 — Reality Audit / Spec Freeze（必经，允许只读）

**行动：** 从最新 origin/main 隔离 worktree 开始；查找已有 Recall/SourceTrace/Correction 等价能力和开放 PR；核实三宿主真实 SDK 版本、安装状态、工具发现、权限上下文、Workspace 解析及证据来源；用真实且已脱敏的 1 个形成案例、1 个复用案例、1 个仅摘要案例梳理关系。未经 Owner 允许不得读取其他 Owner/宿主的私有库或支付 LLM 费用。

**必须交付事实矩阵：**

| 检查点 | 需要回答 |
|---|---|
| CANONICAL-ID | 已注入 principleId 能否唯一映射 Ledger；不能时证据和频率是多少 |
| SOURCE-LINK | Candidate→Pain 是否可从 sourcePainId 或现有任务拓扑精准恢复 |
| CORRECTION-LINK | 真实 Pain 可否恢复 exact Row/Blob；不能的比例是多少 |
| ACCESS | 三宿主各自的授权来源和能否阻止 Agent 访问其他工作区 |
| OPENCLAW-SDK | registerTool、contracts.tools、toolMetadata/tool policy 的实际运行契约 |
| CODEX-PLUGIN | Marketplace Skill 真实包位置与已安装 PD CLI 可执行性 |
| WORKBUDDY-PLUGIN | Desktop Skill 自发现是否可用，插件 cache/治理 workspace 身份 |
| REUSE | 已有函数可直接复用多少，是否需新增 export/query，重复实现风险 |
| RELEASE | 安装后 enabled/disabled 行为与撤销方式 |
| PRIVACY | Raw/Blob 数据是否覆盖现有脱敏与删除边界 |

**Gate：** 没有真实身份/访问证明时禁止先写一套自称“安全”的 Agent 检索代码。允许把工作拆成最小安全功能，但不能掩盖无法满足的 AC。

### PR-01 — Shared Core Read Query + Provenance Test

仅在既有原则、Candidate、Task、Artifact 和 trajectory-store 周围增加最少必需只读方法/导出；一个共享查询入口。优先复用已实现 SQL 和 SourceTrace 代码，允许小型 helpers 处理单调、唯一、有出处的 lineage。强制覆盖形成/复用/冲突/缺证据/权限/只读；不要引入平行的 ResolverReaderRetriever 层次。

**交付：** 可由三个宿主依赖的稳定查询契约、类型测试、真实 SQLite fixture、数据无写入证据。

### PR-02 — CLI + 宿主薄接入

允许两个提交或多个小 PR：

- CLI：新增一个命令树入口与 JSON output；现有 pd trace 等契约不变。
- OpenClaw：一个 Agent Tool、真实 Manifest/Tool policy 声明和宿主适配测试。
- Codex：Marketplace 已有 skills 下一个新 Skill；必要的最小脚本包装和现有 Codex Bundle Tests。
- WorkBuddy：已存在 plugin skeleton 下一个新 Skill；Installer 缓存及真实 Desktop 支持验证。

三宿主必须共享一个 Core，无独立 SQL。变更必须保持兼容 SDK、旧 Hooks 和原有 RuleHost。

**Gate：** 所有需要新增 MCP 的情形均形成独立、可复现的兼容性事实与成本决策，不能隐藏在 PR-02 中提前搭服务。

### PR-03 — 三宿主安装与 E2E Parity

针对已打包/安装的真实产物、真实 Workspace/治理状态，不仅跑 Mock。

输出三宿主版本、安装路径、工具/Skill 发现、实际调用、结果原始引用核验、OFF/撤销和安全检查。若缺少某个真实宿主，明确 NOT_RUN，禁止宣称 RELEASE GO。

### PR-04 — 可选实验与最终收口

完成最小自然检索策略 A/B（见 §11），记录收益与开销，区分统计功效不足与负结果；实验结果不等同工程门禁，若工程可用但效果无证据，产品效益标记 UNPROVEN，不夸大。独立复审、复杂度审计与 Owner Review Card。

### 9.1 复杂度预算及反证义务

实现者必须提供：
- 新增/修改生产文件数、净新增生产代码行数、依赖/表/迁移/服务数量；
- 每个新增 helper/class 的不可替代性说明；
- 三宿主重复 SQL/映射/配置逻辑的静态搜索结果；
- 与“只扩展既有 Store/CLI/Plugin”方案的复杂度对照；
- 原有重型测试和纯净安装所需构建时间变化。

**硬指标：** 新持久化对象 0、额外常驻进程 0、新 LLM 检索调用 0、三份领域实现 0。若出现新的生产依赖或新入口层，必须先证明现有框架没有等价能力并在 Review Card 中请求决策。不得用无依据的总代码行数阈值代替可维护性分析。

---

## 10. 自动化验收矩阵（红灯先行）

### 10.1 Core / SQLite

| ID | 前置数据 | 预期 |
|---|---|---|
| AC-C01 | 已形成 Principle，derivedFromPainIds 存 Candidate ID | 精确解析原始 Pain，不把 candidateId 充当 painId |
| AC-C02 | 已有 3 个 reuseEvidence 关联 | 返回有效多案例，来源 reused |
| AC-C03 | 形成 + 复用重复指向同一 Pain | 单个 case，来源事实不丢失 |
| AC-C04 | 相同 candidate 映射两个不同 Ledger | 冲突，不 silent overwrite |
| AC-C05 | 形成候选经多级 Dreamer/Philosopher 等任务到 sourcePainId | 支持实际合法拓扑 |
| AC-C06 | sourcePainId 与 candidate/Task/Pain 不符 | 拒绝 verified |
| AC-C07 | only manual Pain，无回溯 Turn | 返回可信摘要，raw unavailable |
| AC-C08 | 精确 Row ID 但所属 session/Pain 不符 | Owner Correction 不返回 exact |
| AC-C09 | Blob 原文缺失、仅 excerpt | excerpt_only + truncated |
| AC-C10 | 没有 Outcome | not_recorded，绝不推断成功 |
| AC-C11 | Artifact 的 principleDraft.title 回退导致 ID 不唯一 | ambiguous / not_linked，无模糊链接 |
| AC-C12 | 只有未激活、已撤回、待审批或 scope 禁止的原则 | Agent denied，不以 Operator 路径兜底 |
| AC-C13 | state.db / trajectory.db 缺失或旧 schema | 区分 unavailable 与 0 cases，不创建库 |
| AC-C14 | 数据清理后再次请求历史 Raw | 不从缓存恢复已删除数据 |
| AC-C15 | limit 负值/超限，ID 畸形，detail 无 painId，list 带不适用参数 | invalid_input，不访问 DB |
| AC-C16 | 100+ Case、相同时刻、分页/去重 | 有界结果、稳定次级排序、正确 hasMore |
| AC-C17 | 注入 ID/activation/ledger 来源不一致 | 返回明确身份错误 |
| AC-C18 | 并发读取与正在写入 Pain | 无隐式写，连接关闭，退化可解释 |

**测试细则：** 使用真实 SQLite schema 与读取 Store，而不仅模拟内存映射；对临时隔离工作区比较查询前后 db 文件、重要记录及有无 bootstrap。对于已有 SQLite/WAL 的系统级临时文件，需区分系统行为与业务写入，不简单以所有 mtime 不动作为唯一可靠标准。

### 10.2 安全与治理

| ID | 场景 | 预期 |
|---|---|---|
| AC-S01 | Agent 提供别的 workspace 路径 | Tool Schema 无此参数；CLI Agent 使用限制清晰 |
| AC-S02 | Agent 请求其他宿主私有治理工作区 | 不发生自动回退/跨宿主混库；记录真实 OS Shell 边界 |
| AC-S03 | WorkBuddy OFF，CLI 仍能运行 Operator 模式 | 宿主 Recall 不绕过治理；区别 Operator 与 Agent 的访问承诺 |
| AC-S04 | Codex 未 setup / Plugin version 不匹配 | 降级，不自动 init/install |
| AC-S05 | 运行时可见原则未通过身份映射 | 不返回潜在敏感历史 |
| AC-S06 | 历史含 Prompt Injection / 伪造系统命令 | 始终当作证据，无执行 |
| AC-S07 | 历史包含 API Key / 私密个人信息 | 脱敏或拒绝 Raw，不进入错误日志 |
| AC-S08 | 用户删除/清理历史后再查询 | 不恢复删除内容 |
| AC-S09 | 未调用 Recall 时普通工作流 | 无额外历史 DB 查询、无内化/RuleHost 变化 |
| AC-S10 | 任意 Shell 的越权尝试 | 明确展示宿主/OS 能否阻止；不能证明则“不具强隔离保证”且按威胁模型处理 |

### 10.3 三宿主功能验收（每项独立）

| 测试 | OpenClaw | Codex | WorkBuddy |
|---|---|---|---|
| T-01 真正安装的插件包版本/路径确认 | 必须 | 必须 | 必须 |
| T-02 工具或 Skill 发现成功 | 必须 | 必须 | 必须 |
| T-03 明确要求检索时调用 list 且 source 正确 | 必须 | 必须 | 必须 |
| T-04 detail(summary) 查回同一个 Pain | 必须 | 必须 | 必须 |
| T-05 有精确锚点时 raw 成功、无锚点时降级 | 必须 | 必须 | 必须 |
| T-06 未 setup、禁用、卸载/回滚后的行为 | 必须 | 必须 | 必须 |
| T-07 没有工具调用时旧 Hook/Prompt/RuleHost 无回归 | 必须 | 必须 | 必须 |
| T-08 特定宿主治理工作区正确且不混库 | 必须 | 必须 | 必须 |
| T-09 更新安装包后产物一致，无开发仓库路径依赖 | 必须 | 必须 | 必须 |

每个真实宿主至少保存一次成功和一次预期降级的脱敏调用证据；**实测工具自动可见**与**可被人手动执行 CLI**必须分别记录，不得合并为 PASS。Codex CLI/Desktop 如无法同时测试，逐产品标出明确状态；WorkBuddy Desktop 不能用 CodeBuddy CLI 探针代替。

### 10.4 CI / Regression

- Core、CLI、OpenClaw 插件、Codex 适配和 Marketplace Bundle、WorkBuddy Installer/Adapter、host-runtime/parity 的既有门禁均不得退化。
- 真实宿主外的 CI fixture 测试可以长期维持回归，但不能替代首个真实 Pilot。
- 对 L0 输出做原有固定 fixture 的行为/预算基线对比；Recall 插件暴露后记录其工具 Schema/Skill 元数据的固定 Token 成本，并如实报告。

---

## 11. 自主检索与行为增量实验（不与功能门禁混淆）

### 11.1 实验拆分

**功能可用性：** 显式要求 Agent 查询一条已知原则，验证工具发现、调用、正确性。未主动选择调用不属于这个实验。

**自主选择能力：** 不要求检索，构造两组任务：历史证据确有用、仅原则已足够。观察合理调用率、过度调用、重复调用、错选 Pain、调用后行动变化。一次未调用不等于宿主接入失败。

**收益对照：** A 组仅原原则注入；B 组相同原则 + 可选 Recall。其余 Agent 模型、任务、上下文、治理和预算尽量一致。评估相似 Pain 再发生率、Owner Correction 次数、适用边界判断准确率、无关历史误用和 Token/时延。实验样本少时标注 UNPROVEN，不声称因果显著。

### 11.2 禁止的虚假成功判定

- 仅能返回历史 JSON != 已提升行为质量。
- Agent 复述历史 != 避免未来 Pain。
- 任意单宿主 E2E != 三宿主完成。
- 有录屏证明点击 Skill != Agent 能自主发现使用。
- B 组多提示词或多模型调用 != 纯 Recall 增量。
- 部署成功 != Owner 授权该宿主的全部历史可见。

---

## 12. 发布、回滚与裁决

### 12.1 安装与升级

- OpenClaw：Plugin Manifest/Tool registration 经真实 Gateway/版本核验；仅 PD 自有条目修改。
- Codex：保持 Marketplace + $pd-setup 当前架构；**禁止再次引入全局 Hook 安装**；升级已有插件资产，复用 bundle test，验证安装缓存和 pinned runtime。
- WorkBuddy：保持默认关闭、显式 Owner enable；Skills 纳入 PD-owned marketplace skeleton/缓存，按已有 Installer 更新；严禁手动改 ~/.workbuddy 配置或跨宿主迁移。

升级时保证旧用户：缺失旧数据只表现为 partial/unavailable，不要求旧 Ledger migration，不阻止原有功能。

### 12.2 回滚

优先撤销新增工具注册/Skill 和相关封装。Shared Core 只读逻辑无数据迁移可回滚；历史 Pain 与 Ledger 均保留；不更改既有 Activated Principle Prompt、RuleHost、Owner Decision。安装器/uninstaller 只能删除明确属于 PD 的新资产。

### 12.3 裁决字段

- SPEC：PROPOSED / FROZEN；
- ENGINEERING：GO / CONDITIONAL GO / NO-GO；
- HOST.OPENCLAW、HOST.CODEX_CLI、HOST.CODEX_DESKTOP、HOST.WORKBUDDY_DESKTOP：PASS / FAIL / BLOCKED / NOT_RUN / UNSUPPORTED；
- AUTONOMY：EVALUATED / NOT_RUN；
- BEHAVIOR_DELTA：SUPPORTED / UNPROVEN / NEGATIVE；
- RELEASE：GO / CONDITIONAL GO / NO-GO。

**要求三宿主都支持**的发布口径是 OpenClaw + 已承诺的 Codex 产品面 + WorkBuddy Desktop 均通过真实调用；某环境不在当前承诺范围须在审计时有明确范围裁决，不能“跳过并称全绿”。

### 12.4 Owner Review Card（交付模板）

~~~text
SPEC-PD-PRR-001 v1.1
Base commit / release artifact / PR:
Changed production files / net LOC / new dependencies / new schemas:
Core provenance tests / missing evidence:
Cross-workspace/Owner authority verdict:
OpenClaw tool + manifest + real E2E:
Codex Marketplace skill + CLI/Desktop E2E:
WorkBuddy Desktop skill + installer + real E2E:
No-call L0 / RuleHost regression:
Privacy/raw text redaction / prompt injection:
Autonomy experiment / behavior delta / cost:
Outstanding P0/P1/P2:
ENGINEERING / HOST / RELEASE verdict:
Owner decision required:
~~~

---

## 13. v1.0 评审闭环清单

| v1.0 问题 | v1.1 处理位置 | 判定 |
|---|---|---|
| P0：Agent 自选 workspace 与未授权原则 | §5.1–5.3、§10.2 | 需求已明确；实现/宿主安全待实测 |
| P1：OpenClaw 只写 registerTool 缺 Manifest | §6.2、§10.3 | 新增 Tool Manifest/policy Gate |
| P1：Codex 新安装路径误判 | §6.3、§12.1 | 冻结 Marketplace + 既有 Skills |
| P1：来源路径过度假定 Diagnostician | §1.2、§3.3、§10.1 | 纳入 sourcePainId、多级任务拓扑 |
| P1：Core 忽略已有 trajectory-store | §1.1、§5.4、§9 PR-01 | 明确复用 read-only DB 入口 |
| P1：Zero Token 承诺不严谨 | §4.6、§10.4 | 改为无额外历史查询/测固定发现开销 |
| P1：Correction Row ID 不等于 Pain 绑定 | §3.4、§10.1 | exact/context_only/excerpt_only |
| P2：WorkBuddy 的 Skill 未打包 | §6.4、§10.3 | 冻结插件根 Skills 与 Installer Gate |
| P2：状态契约过宽 | §4.5 | 顶层简化与 reasonCode 分离 |
| P2：E2E 与自主实验混淆 | §10、§11 | 明确实验独立判定 |

以上“已闭环”只指**设计修订完成**，不代表对应生产代码或实际宿主安全性已经验收通过。

---

## 14. 外部契约参考与待核实项

- OpenClaw Tool Plugins/Manifest： https://github.com/openclaw/openclaw/blob/main/docs/plugins/tool-plugins.md 、https://docs.openclaw.ai/plugins/manifest 、https://docs.openclaw.ai/tools
- Codex Plugin/Skills： https://developers.openai.com/plugins/build/plugins （以 PD 实际 Marketplace 兼容 Manifest 与目标 Codex 客户端版本为准）
- CodeBuddy/WorkBuddy 插件 Skills： https://www.codebuddy.ai/docs/cli/plugins-reference 、https://www.codebuddy.ai/docs/cli/plugins
- 本仓库内源：§1.1 列出的源文件；Codex Marketplace 插件和 Bundle Test；WorkBuddy 插件 Skeleton、Installer、workspace-resolution。

外部文档能证明**该生态支持某种接口**，不能证明 PD 某个当前安装包、具体 WorkBuddy Desktop 引擎版本或者具体 Codex Desktop 会自动调用。必须以 PR-00 探针、实际打包产物和真实 Agent E2E 闭合。

---

## 15. 最终验收清单（Definition of Done）

- [ ] 对齐最新远端 main、保护用户已有修改、无重复实现。
- [ ] Formation / Reuse / 多级来源关系经真实数据核验。
- [ ] 注入 Principle ID 映射与 Activation/Artifact/Ledger 归属唯一且可审计。
- [ ] Owner 可见性、宿主启停、OS/Shell 限制与剩余风险清楚记录。
- [ ] Core 查询只读、可限长、可降级，不创建/迁移数据库。
- [ ] Owner Correction/Raw 的 exact/摘录/缺失状态真实、无错误归因。
- [ ] 一个共享查询权威；不新增数据库、向量检索、常驻服务、LLM 请求。
- [ ] CLI 只新增最小查询命令；旧命令保持兼容。
- [ ] OpenClaw 已安装工具、Manifest、访问策略和真实 Agent E2E 通过。
- [ ] Codex Marketplace 安装插件 Skill、目标 CLI/Desktop 真机 E2E 通过或诚实标注范围。
- [ ] WorkBuddy Desktop 安装插件 Skill、独立治理工作区、启停及真机 E2E 通过。
- [ ] 无调用时没有额外历史查询，L0/Hook/RuleHost 与原版本行为一致。
- [ ] 敏感信息、Prompt Injection、清理后访问、越权测试通过。
- [ ] 独立复审 P0/P1 为零；实现复杂度报告与发布/回滚证据齐全。
- [ ] 自主检索和行为收益分开记录；未验证的效益明确标注 UNPROVEN。
- [ ] Owner 审核最终 RELEASE 裁决。

**结束语：** 该能力的价值在于 PD 不必让 Agent 在每轮背负全部痛苦，而是在需要时能从某条原则准确恢复具体的、来源可查的历史经验。把最小读取能力接到现有三个宿主，比新建第四套记忆体系更符合 PD 当前工程规模和产品定位。

**SPEC-PD-PRR-001 v1.1 END**

