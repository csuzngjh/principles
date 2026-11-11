# SPEC：统一宿主轨迹摄取（Unified Host Trajectory Ingestion）

| 项 | 值 |
|---|---|
| 编号 | SPEC-UNIFIED-HOST-TRAJECTORY-INGESTION-001 |
| 版本 | v0.2（三路独立评审修订版：代码事实/生产数据/对抗架构） |
| 状态 | **APPROVED**（2026-11-11 Owner 批准开工） |
| Linear | PRI-1171 |
| 日期 | 2026-11-11 |
| 作者 | zcode（技术方案）；目标与意图由 Owner 对齐确认（见 §1.2） |

## 修订与批准记录

| 日期 | 事件 |
|---|---|
| 2026-11-11 | Owner 指示：统一三宿主轨迹采集，采集主线走离线转录目录，不削弱 OpenClaw，WorkBuddy 必须实现并开通 |
| 2026-11-11 | Owner 意图对齐三决策：reasoning 录入；保留策略推广 Codex 模式（7 天窗口+引用长期）；不加轨迹浏览页（消费面走现有诊断/证据流+采集健康状态） |
| 2026-11-11 | 三路独立子代理评审后修订 v0.2：① Codex 全文升级**不复用旧 bounded 同意**——须新版本披露+同意台账新版记录；② OpenClaw 离线兜底源**降级为待证据跟进（默认裁剪）**——live ID 与宿主转录事件 ID 间无已验证桥、热库快照有已知坑；③ OpenClaw live 统一观察写入补独立开关与消费面权威规则；④ WorkBuddy 磁盘口径修正（jsonl 约 477MB，非 566MB）；⑤ 采集开关与宿主总开关（host.workbuddy）的层叠门控显式化 |
| 2026-11-11 | **Owner 批准开工（"批准开工"）**：状态置 APPROVED，进入实施（按技术设计 §11 九项工单：P1 提取 → P2 WorkBuddy 开通 → P3 深度对齐）。本批准同时构成 Codex full 层新版同意决定（decidedVia=owner_directive，随 P3 工单 ⑧ 落台账，须配新版披露文本） |
| 2026-11-11 | PR #2523 评审修订（一致性勘误，不改意图）：§7 `mvp-q-3` 与 §10 复杂度增量的开关计数与 §4.4 对齐——`openclaw_unified_observation`（live 统一观察写入，默认 on）显式计入，新运行时 flag 数 1→2 |

---

## 0. 摘要

把三宿主（OpenClaw / Codex / WorkBuddy）的对话轨迹采集从"每宿主一套方案"收敛为**一条统一摄取管线**：以**离线读取宿主转录目录**为权威采集主线，hooks 降级为实时控制与即时信号通道（不再承担采集主责）。Codex 现有摄取架构（转录定位→有界增量解码→验证脱敏→同意门→logical key 收敛→统一存储）泛化提取为 host-neutral seam；WorkBuddy 以一个转录解码器接入并**默认开通**；Codex 升级为全文+reasoning；OpenClaw 现有钩子采集零削弱，另增离线兜底源。

## 1. 目标与意图（Owner 对齐结果，不可在实施中偏离）

### 1.1 要解决的问题

1. **架构混乱**：三宿主三套采集方案，每新增宿主需重新设计一套；
2. **深度不齐**：WorkBuddy 对话采集为零，Codex 仅有界摘要（≤215 字符），诊断证据质量三宿主不等；
3. **完整性缺口**：实时钩子漏装/停机期间数据永久丢失。

### 1.2 Owner 已确认的意图（2026-11-11）

| # | 意图 | 决策 |
|---|---|---|
| G1 | 采集主线 | 离线读宿主转录目录（三宿主磁盘存储已实证，见 §3.2） |
| G2 | 采集深度 | 全文对齐 OpenClaw；**reasoning（推理过程）一并录入** |
| G3 | 保留策略 | 推广 Codex 模式：7 天滚动窗口 + 被诊断/提案引用部分长期保留；OpenClaw 存量数据不删 |
| G4 | WorkBuddy | 必须实现并**默认开通**；Owner 指示即批准依据，落同意记录存档 |
| G5 | OpenClaw | 现有钩子采集**零削弱**；轮次权威/纠错锚点承重结构不动；离线补读仅作兜底增强 |
| G6 | 消费面 | 不新增轨迹浏览页；现有诊断/证据流 + 三宿主采集健康状态 |

### 1.3 红线（不变量，固化为验收项）

- 采集**只做行为证据**（诊断、原则提案、行为变化观察）；PD 不做监控产品，不新增面向 Owner 的原始轨迹浏览界面；
- OpenClaw `user_turns` 写入（PRI-1137 轮次权威、PRI-788 Stage1/Stage2 纠错锚点）原样保留；
- 入库内容复用 PD 既有脱敏/匿名化管道，不另开隐私口子；
- 轮次权威仍仅 OpenClaw（roundKeyProvider）；Codex/WorkBuddy 诚实报 `legacy_fifo_prefix_v1`（PRI-904 结论不变）。

## 2. 术语

- **转录（transcript）**：宿主自己持久化的完整会话记录（含用户消息、助手回复、工具 I/O、推理过程）；
- **观察（observation）**：PD 从转录/钩子事件提取并入库的规范化记录；
- **摄取（ingestion）**：转录→观察的转换管线；
- **收敛（convergence）**：live 钩子观察与转录重放观察按 logical key 去重合并；
- **seam**：host-runtime 内的统一摄取模块族（见 §4.1）。

## 3. 现状基线（Reality Audit，2026-11-11）

### 3.1 三宿主采集现状

| 宿主 | 采集方式 | 深度 | 生产数据（快照审计） |
|---|---|---|---|
| OpenClaw | 进程内钩子（llm_output/prompt）直录 | 全文 raw+sanitized | user_turns 26 / assistant_turns 114 / tool_calls 576 |
| Codex | consent 门控（`codex_conversation_ingestion`，本机 enabled）转录重放+live 收敛 | 有界（visible_text ≤215 字符） | governance_observations 8748（live_hook 源）；tool_calls 18954 |
| WorkBuddy | 无对话采集（SPEC v0.3.0 MVP 排除） | 零 | user_turns 0 / assistant_turns 0；tool_calls 10606（host_kind=workbuddy 4205） |

### 3.2 三宿主磁盘转录存储（统一主线的物理基础，全部实证）

| 宿主 | 转录位置 | 格式 | 实测状态 |
|---|---|---|---|
| OpenClaw | `~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite`（transcript_events / session_transcript_* / FTS） | 内部 SQLite | 在盘（68483 条事件身份记录） |
| Codex | `~/.codex/sessions/` rollout JSONL | 官方明示"非稳定接口" | 在盘，PD 已在读 |
| WorkBuddy | `~/.workbuddy/projects/<encoded-cwd>/<sessionId>.jsonl` | 未文档化明文 JSONL（Beta） | 在盘，219 个 jsonl/约 477MB（jsonl 口径；另含非转录文件全目录约 587MB SI）；取证报告：核心类型 2.5 个月稳定、callId 配对 100%、含 reasoning |

### 3.3 已存在的可复用资产（Connection Before Creation）

- Codex 摄取管线全套：`codex-adapter/src/ingestion/`（定位/校验/增量解码/检查点/admission）；
- host-neutral 存储缝：`host-runtime/governance-observation-store.ts`（logical key 收敛、retention 窗口、quarantine、promotion、checkpoint；WorkBuddy 工作区表已建，0 行）；
- 共享脱敏：`sanitizeString/sanitizeValue/redactTelemetryString`；
- consent 模式：`pd-cli` 冻结披露+显式同意命令（Codex 已用）；
- WorkBuddy 转录格式取证与变体基线：`docs/plans/2026-08-28-workbuddy-session-transcript-access.md` §8.1。

## 4. 统一模型（核心设计）

### 4.1 统一摄取 seam（host-runtime，唯一对话采集入口）

```
新宿主接入只实现两个薄件：
  ① TranscriptSourceAdapter —— 转录定位 + 格式解码（每宿主一个）
  ② LiveSourceAdapter（可选）—— 钩子事件 → 观察的映射（即时信号）
        ↓
  host-runtime: conversation-ingestion seam
  ① 定位与授权（路径校验、大小/时间界、同意门）
  ② 解码（宽容解析；schema 版本感知）
  ③ 验证与脱敏（rc-1..rc-9 门 + 既有脱敏管道）
  ④ 收敛（logical key 去重合并：live × transcript 重放）
  ⑤ 写入（统一观察存储 + 检查点 + retention 治理）
        ↓
  {workspace}/.state/trajectory.db
```

- seam 落 **host-runtime**（宿主适配器本就依赖它；不触碰 core 的 io-seam-registry 边界）；
- **每宿主代码收敛为"一个解码器 + 可选 live 映射"**——这是消除"每宿主一套方案"的接口形态；
- 管线对宿主的唯一知识是 `hostKind` 与解码器产物，其余（验证/脱敏/收敛/存储/治理）完全共享。

### 4.2 存储：governance_observations 升格为统一对话观察存储

- schema **v4**（additive 迁移，现有 8748 行不动）：
  - `host_kind` 枚举扩为 `openclaw | codex | workbuddy`；
  - `kind` 增 `reasoning`；
  - `visible_text` 上限由固定 200 改为**同意分层策略**（默认有界；本工作区同意全文后=全文，仍经脱敏管道）；
- **权威分层声明（P4）**：`governance_observations` = 对话**观察**唯一权威；OpenClaw `user_turns`/`assistant_turns` 基表 = OpenClaw **治理**权威（轮次计数/纠错锚点），两契约并存且在本文档显式声明，不构成双真相源。

### 4.3 hooks 职能重定义

| 职能 | 归属 | 变化 |
|---|---|---|
| 原则注入、工具拦截、轮次计数、纠错锚点 | hooks（不变） | OpenClaw 全部保留；WorkBuddy/Codex 维持现有控制钩子 |
| 对话采集主责 | **离线转录摄取** | hooks 采集降级为"live 增强"（提前可用，转录重放后收敛） |

### 4.4 各宿主接入

**Codex（Phase 1 泛化 + Phase 3 升级）**：现管线平移入 seam，行为零变化（契约测试锁定）；Phase 3 解除文本上限（同意分层=全文）、增录 reasoning（rollout 内 reasoning 项）。

**WorkBuddy（Phase 2 新增）**：
- 解码器：六记录类型（message/function_call/function_call_result/reasoning/file-history-snapshot/ai-title）宽容解析，变体基线固化契约测试；子代理目录与主会话同构处理；
- 同意记录：依据=Owner 2026-11-11 指示（本 SPEC §修订记录），落 `codex-ingestion-consent` 同构台账；
- **默认开通**：`workbuddy_conversation_ingestion` quiet flag 默认 enabled=true（依据 Owner 指示与"重要功能默认开启"既有产品决策）；rollback=flag off，检查点保留、重开幂等补读；
- 采集范围：`~/.workbuddy/projects` 下绑定 PD 工作区的 cwd 对应目录；**禁止**目录扫描猜 latest（SPEC §4.6 既有约束延续：只走 hook payload 显式提供的 `transcript_path` 与按 session_id 的确定性路径推导）。

**OpenClaw（live 统一写入 + 兜底源待证据）**：
- 钩子采集原样保留（G5）；
- live 统一观察写入（Phase 3）：钩子路径旁路向统一观察存储写全文观察，挂独立开关 `openclaw_unified_observation`（quiet，默认 on，依据=本统一指示；lifecycle 按 §16 规范）。消费规则：诊断/证据消费面以统一观察存储为准——基表与观察表不一致时，以观察表为准并留有界诊断；
- 离线兜底源**降级为待证据跟进（默认裁剪）**：对抗评审发现 ① live `runId` 与 `openclaw-agent.sqlite` 事件 ID 之间无已验证桥（按 logical key 收敛的承诺不成立）；② 热库快照复制有已知坑（三文件非原子、readonly 无法做 WAL 恢复）；③ 37% 事件正文在 zstd 压缩列。重启条件：先量化钩子停机窗口频率并实证 ID 桥，再单独立项；技术要点见技术设计 §7.2 附录。

## 5. 保留与隐私

- 保留策略（G3）：统一为 ≤7 天滚动操作窗口（以宿主轮次为界：≤32 可见轮）+ 被 pain/诊断/提案引用（promoted）长期保留；OpenClaw 基表存量数据不删、不迁移；
- reasoning 为一级证据（G2，Owner 决策）；入库前与 message 同管道脱敏；
- 导出/遥测沿用既有匿名化管道，reasoning 与 `function_call_result.output` 列为高敏感字段（取证报告 §6.4 结论延续）。

## 6. 可观察性与健康

- `pd-cli`：扩展现有 `health-codex` 模式为三宿主采集健康（每宿主：flag 状态/上次成功时间/检查点水位/滞后字节/最近降级原因）；
- Console：采集健康状态视图（只读状态，非轨迹浏览，G6）；
- 所有降级路径保持 rc-9 结构化可见（reason/nextAction）。

## 7. 迁移与验收矩阵

| 阶段 | 内容 | 验收（Owner 可观察） | 回退 |
|---|---|---|---|
| P1 提取 | Codex 管线泛化入 seam，行为零变化 | 契约测试绿；Codex 现有 8748 行语义不变；CI | revert 单 PR；无数据迁移 |
| P2 WorkBuddy | 解码器+同意+默认开通+健康 | WorkBuddy 工作区出现全文+reasoning 观察；健康页三宿主齐；停钩子→恢复后补读不缺 | flag off |
| P3 Codex 升级+OpenClaw live 统一写入 | 全文+reasoning（须新版本披露+同意台账新版记录，见 §8）；OpenClaw 旁路观察写入 | Codex 新观察为全文含 reasoning；OpenClaw 统一观察存储出现全文行 | 文本策略回有界；openclaw_unified_observation off |

**MVP 四问**：
- `mvp-q-1-what-if-skip`：WorkBuddy 零对话采集持续，诊断证据三宿主不等；每新宿主继续各起一套方案，架构负债累积。
- `mvp-q-2-how-observed`：见上表"验收"列（健康页/工作区数据/补读测试）。
- `mvp-q-3-how-disabled`：`workbuddy_conversation_ingestion`（默认 on，可 off）；Codex 沿用现有 flag；OpenClaw live 统一观察写入使用独立 flag `openclaw_unified_observation`（默认 on，可 off，见 §4.4）；均不新增开关类别。
- `mvp-q-4-emotional-value`：降低"宿主越多系统越不可理解"的不确定感；Owner 在一个健康页看到全部采集状态，消除"到底采没采"的反复排查成本。

## 8. 对既有文档的修订声明（批准本 SPEC 即生效）

| 文档 | 修订 |
|---|---|
| Codex Governance Closure SPEC（Slice A，有界姿态） | 文本上限由固定有界修订为同意分层。**旧 consent 针对旧版"有界"披露授予，不自动覆盖全文+reasoning**：full 层生效条件=新版本披露文本+同意台账新版记录（decidedVia=owner_directive；Owner 对本 SPEC 的批准即构成该决定，随 P3 落台账）；retention/quarantine 机制不变 |
| workbuddy-host-adapter-spec v0.3.0「MVP 不读取 transcript」 | 解除；读取范围限定与同意依据以本 SPEC §4.4 为准（禁止目录扫描猜 latest 条款延续） |
| `host.workbuddy` flag description（"no transcript reads"） | 随 P2 采集开通同步修订：该 flag 语义更新为宿主总开关（读取范围由 workbuddy_conversation_ingestion 单独门控），lifecycle evidence 同步更新 |
| ADR-0020 | 引用性更新：Codex 摄取职责平移至 host-runtime seam（扩展模型结论不变） |

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 宿主转录格式漂移（三家均非契约接口） | 宽容解析+变体基线契约测试+schema 版本感知；漂移→显式降级（rc-9），不静默丢数据 |
| 双存储（观察×治理）P4 张力 | §4.2 显式权威分层声明；治理写入仅 OpenClaw 钩子路径，观察写入仅 seam |
| WorkBuddy jsonl 含高敏感 reasoning/工具输出 | 同意台账+既有脱敏/匿名化管道；导出面按高敏感字段处理 |
| 磁盘增长（WorkBuddy 转录 jsonl 约 477MB 且宿主自身无清理） | PD 侧遵守 7 天窗口；不清理宿主自己的文件（PD 不拥有宿主目录）；入库体积随 P2 验收实测后补量化基线 |
| 主线读目录与 hooks 写入竞态 | 只读快照模式（WAL 安全复制）；append-only 文件按 byte-offset 增量；收敛按 logical key 幂等 |

## 10. 复杂度增量

```
New durable source of truth: NO（trajectory.db 既有库）
New persisted schema/state: 小（governance_observations v4 additive + consent 台账复用）
New subsystem/service: NO（泛化提取既有 Codex 管线）
New public abstraction: 1（conversation-ingestion seam —— 即消灭 N 套方案的那个接口，包内公开非跨包）
New runtime feature flag: 2（workbuddy_conversation_ingestion、openclaw_unified_observation，均 Owner 指示默认 on）
New cross-package dependency: NO（seam 在 host-runtime；适配器既有依赖方向不变）
New host/platform-specific behavior: 预期内（每宿主一个解码器，这是统一模型的既定形态）
New external/network capability: NO（全部本地文件读取）
```

## 11. 未决事项

- OpenClaw 离线兜底源默认裁剪（评审结论，§4.4）；重启条件=量化钩子停机窗口频率+实证 runId↔宿主事件 ID 桥；
- Codex full 层生效依赖新版披露文本（P3 首个交付物；Owner 批准本 SPEC 即为同意决定，P3 落台账）；
- WorkBuddy `isCompacted` 语义未定论（"本条是摘要"还是"此前历史已被宿主替换"）——P2 期间补取证；定论前**不**触发任何墓碑/回滚语义。

---

## 附：证据索引

- 三宿主生产 trajectory.db 快照审计（2026-11-11，`.tmp/pd-trajectory-audit-20261111/`，主检出）
- `docs/plans/2026-08-28-workbuddy-session-transcript-access.md`（WorkBuddy 转录取证，含变体基线 §8.1）
- `docs/audit/PD_WORKBUDDY_CAPABILITY_MATRIX_v0.2.md`（hook 能力矩阵）
- `~/.openclaw/agents/main/agent/openclaw-agent.sqlite` 表结构（transcript_events 等，只读实测）
- Codex 源码 `codex-rs/hooks/src/events/stop.rs`（Stop payload 含 transcript_path/last_assistant_message）
