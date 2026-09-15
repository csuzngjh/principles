# SPEC — trajectory 数据面单一事实收敛（建表定义合一，零通路废除）

- Linear：PRI-774（parent：PRI-751「PD 瘦身与架构收敛」伞单）
- 状态：**设计稿，待 Owner 评审**——评审通过后才立实施单；本 SPEC 不实现代码
- 依据：源码核对（origin/main @ `70d824c4` 附近工作树）+ PRI-753 既有决策（PR #1627，"保持双库分层"）+ PRI-751 伞单审计方法
- **范围声明（置顶）**：本 SPEC **不废除任何数据通路**。trajectory.db 的三条写入通路（插件运行时 / `pd runtime init` / core SDK pain-record）与全部读取通路原样保留。收敛对象只有一个：**建表定义（DDL）文本的份数**——同一份建表说明书目前手抄在两个包里，靠人肉注释保持一致，已证实失效。收敛后两条建表通路改用同一份正本，建出的表结构逐列不变。

---

## 1. Current topology（真实 writer/reader，file:line 为撰写时基线，可能随 main 漂移 ±数行）

### 1.1 两份建表定义（问题本体）

| | 副本 A：插件侧（权威） | 副本 B：core 侧（镜像） |
|---|---|---|
| 文件:函数 | `openclaw-plugin/src/core/trajectory.ts` `applyTrajectorySchema()`（:173 起） | `principles-core/src/runtime-v2/pain-signal-observability.ts` `ensureTrajectorySchema()`（:125 起） |
| 调用方 | `TrajectoryDatabase.initSchema()`（trajectory.ts:1708）+ `initTrajectorySchema()`（:473-504，供 `pd runtime init`，runtime-init.ts:264） | 仅 `recordTrajectoryPainEvent()`（pain-signal-observability.ts:413，`pd pain record`/gate-block SDK 路径） |
| 建表 | 16 表（schema_version、ingest_checkpoint、sessions、assistant_turns、user_turns、tool_calls、pain_events、gate_blocks、trust_changes、principle_events、task_outcomes、correction_samples、sample_reviews、signal_confirmations、exports_audit + evolution 退役注释） | 同 16 表，逐列一致（当前无漂移） |
| 列迁移块 | pain_events 4 列 + turns/tool_calls 增强（:340-384） | 相同（:287-332） |
| 索引 | 9 + UNIQUE canonical_pain_id（:387-456） | 相同（:334-390） |
| views | 3 个（v_error_clusters 等，:431-446） | 无（有意省略，:121-124 注释） |
| schema_version | 写入并 UPDATE 至 1（:494-499,1567-1572） | 建表但**从不读写**（版本门对其不可见） |
| tables 声明数组 | :175（16 项，含 signal_confirmations） | :127-132（**已过时：漏 signal_confirmations**） |

第三 schema 所有者：host-runtime `governance-observation-store.ts`（governance_* 5 表，自带 `governance_observation_schema_version` v3）——自洽自治，**不参与本收敛**。

### 1.2 写入方清单（全部保留）

| 写入方 | 包 | 连接模式 | 写哪些表 |
|---|---|---|---|
| `TrajectoryDatabase`（TrajectoryRegistry 长连接 + 文件锁） | openclaw-plugin | 每 workspace 一条长连接 | 全部业务表 |
| `recordTrajectoryPainEvent`（SDK） | principles-core | 每次调用开→建 schema→关 | sessions upsert + pain_events |
| `reviewCorrectionSample` | principles-core（trajectory-store.ts:246-300） | 每次调用读写 | correction_samples + sample_reviews |
| production-pain-evidence handler | host-runtime（production-pain-evidence.ts:295-332） | 每事件开关（hasCanonicalSchema 探测） | sessions/tool_calls/pain_events（canonical_pain_id 去重） |
| governance stores | host-runtime | 每操作开关（自建 schema） | governance_* 5 表 |

### 1.3 读取方约束（收敛前后必须逐列不变）

pd-cli quality-scorecard（pain_events 6 列 / evolution_tasks 历史行 / principle_events / gate_blocks）、pd-cli evolution tasks list/show（经 core evolution-store，带 sqlite_master 存在门）、core trajectory-store（correction_samples 12 列读写）、pd-console EvidenceChain/Governance 模型（pain_events 12 列，带三层降级）、pd-cli build-trajectory-evidence（user_turns/assistant_turns/tool_calls）、milestone-readers（只读 state.db，与 trajectory.db 无关）。

---

## 2. Failure windows（人工同步机制的失效证据）

| # | 窗口 | 后果 | 证据 |
|---|---|---|---|
| 1 | signal_confirmations 表加入时，两份 DDL 漏同步 | 新表一度只存在于一侧 | 修复提交 `e6a0d0ff`（table-list fix）；该表为 PRI-790 最新双份新增 |
| 2 | B 侧 `tables` 声明数组过时（漏 signal_confirmations） | 第三份硬编码清单说谎（声明与实际建表不符） | pain-signal-observability.ts:127-132 vs :257 |
| 3 | schema_version 对 B 路径不可见 | 未来版本升迁时 `pd pain record` 路径无感知 | B 建表不读写版本值（:125-168 无版本逻辑）；A 写 :494-499 |
| 4 | 复制类型漂移 | core 手抄类型（trajectory-store.ts:20-37、evolution-store.ts:29-50）与 plugin trajectory-types.ts 靠人肉同步，无机械对账 | 两文件头 "do NOT import from openclaw-plugin" 注释 |
| 5 | 陈旧指针 | trajectory-store.ts:9 指向不存在的 `trajectory-db.ts` | 文件不存在（PRI-753 自审已发现，指针未清） |

**频率判断**：双份新增 + 两处清单 + 零版本门 ≈ 人工同步每个特性一次事故（signal_confirmations 为最新实证）。

---

## 3. Canonical 方案（建表定义正本合一；Owner 拍板点内联）

### 3.1 DDL 正本移入 principles-core

新建 `principles-core/src/runtime-v2/trajectory-schema.ts`：**纯 DDL/迁移定义模块**（建表语句、列迁移块、索引、按调用方参数化的 views 开关；零 I/O——只导出语句常量与应用函数，接受 `Database` 句柄参数）。依赖方向合法：plugin 已依赖 `@principles/core`，`applyTrajectorySchema()` 改为导入并应用正本；core `ensureTrajectorySchema()` 同样导入正本。

- 两条建表通路**行为不变**：插件路径 = 正本全部（含 views）；core pain-record 路径 = 正本不含 views（参数化保留现有省略意图）。
- `tables` 声明数组从正本**派生**（消灭第三份清单，B 侧过时问题根除）。
- schema_version：正本统一写入；B 路径开始校验（见 §4）。
- **⚠ Owner 拍板点**：建表定义权威从 plugin 正式反转为 core（`DATA_ARCHITECTURE.md` 权威表述同步改）。不选"保留 plugin 权威 + core 继续手抄"的理由：手抄机制已实证每特性一次事故；不选"core 只留校验不留正本"的理由：core pain-record 路径独立开库建表，没有正本就无法校验。

### 3.2 复制类型单一宿主

新建 `principles-core/src/trajectory-types.ts`（现 plugin `trajectory-types.ts` 的类型全部迁入；零运行时、零 I/O）。plugin 侧原文件变为 re-export shim（现有 4 个插件内部 importer + trajectory.ts re-export 面零改动迁移）。core 的 trajectory-store.ts / evolution-store.ts 手抄块删除，改从同包 types 导入；:9 陈旧指针一并修正。**影响**：纯声明搬家，无运行时行为。

### 3.3 pain 三 sink 角色声明（不擅自删任何落点）

| Sink | 角色（本 SPEC 声明） | 备注 |
|---|---|---|
| trajectory.db `pain_events` | **唯一 durable canonical**（canonical_pain_id UNIQUE 去重） | 全部治理/证据读取方的数据源 |
| `.state/logs/events_<date>.jsonl` | debug 级事件日志（滚动、有界） | 与 product-telemetry/网站 D1 无关 |
| `memory/evolution.jsonl` | **Owner 拍板项**：保留为历史流 / 收编 / 退役——需先盘点其读者（PRI-735 已退役部分双写；本轮未盘点全） | 盘点完成前不动 |

---

## 4. Guard（功能完整性的机制证明）

1. **等价性测试（主保障）**：内存开两个空库，分别走"插件路径应用"与"core 路径应用"，diff `sqlite_master` + 逐表 `PRAGMA table_info` + 索引集——任何差异 CI 红。替代一切 regex 脆弱性，测试的是真实行为。
2. **schema_version 失配 fail-loud**：B 路径建表后读取版本值，与正本常量不符即报错（rc-3）。
3. **orphan 扩展（可选增强）**：schema-orphan-detection 增加 trajectory 正本为 DDL 源（allowlist 历史表 evolution_tasks）。
4. 既有护栏继续生效：PRI-753 往返测试（plugin 写→core 读）、PRI-775 桶面冻结（新模块导出须入快照）。

---

## 5. Migration（实施步骤，单独开 PR，不与任何语义变更混装）

1. 提取正本模块 `trajectory-schema.ts`（内容 = 现 A 副本逐字节；views 参数化）；
2. 插件 `applyTrajectorySchema()` / core `ensureTrajectorySchema()` 切换为调用正本；`tables` 数组派生化；
3. 删 B 侧手抄 DDL/迁移块；补 schema_version 校验；
4. 类型单宿主迁移 + plugin shim；修 :9 陈旧指针；
5. 等价性测试 + strict 守卫落地；
6. 全量回归（core + plugin + pd-cli + round-trip）。

存量数据：**零迁移**——正本与两副本当前逐行一致，等价性测试落地即证明；不触碰任何用户数据。

---

## 6. Rollback

代码 revert 即回滚（无数据迁移、无 flag）；等价性测试随 revert 移除。

---

## 7. Observability（收敛后如何证明不再漂移）

- 等价性测试常驻 verify:merge 体系（结构漂移 = 红）；
- `check:telemetry-events` 模式的先例已证明"机械守卫替代人肉注释"可行（PRI-773）；
- DATA_ARCHITECTURE.md 权威表述随 Owner 拍板更新后，文档-代码双向一致。

---

## 8. 实施前置

- Owner 评审本 SPEC（重点是 §3.1 拍板点：DDL 权威反转）；
- Owner 拍板 `memory/evolution.jsonl` sink 盘点范围；
- 实施单独开 PR，不与任何语义变更混装；基线以实施时最新 main 重核（本 SPEC 行号为撰写基线）。
