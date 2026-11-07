# PD Adaptive Activation — 1258 运行事后只读生产库审计

- 审计 ID：`aa-run-20261106T1258Z-post-hoc-20261107`
- 日期：2026-11-07
- 模式：**只读**（`node:sqlite` `DatabaseSync(..., { readOnly: true })`）
- 原始输出：`D:\Code\_worktrees\principles\PRI-1117-aa-independent-review\.tmp\pri-1117\production-audit-1258-20261107.json`
  - SHA-256：`e5f55f685e362948c8a40fe40d499ca23d1567cb26b1aff82b352355642d15a7`
  - 该文件含生产原则文本，按既有方式仅保留在 `.tmp`，不进入提交。

---

## 1. 为什么需要这次审计

既有污染排除审计 v4 `generatedAt = 2026-11-06T12:37:14Z`，早于 1258 运行（约 `12:58Z` prepare / `13:00Z` 执行）。因此 v4 只能证明事故窗口，**不能**证明 1258 运行零写入。本轮只读审计补这一缺口。

本次审计**不修改** v4 清单、不写入/修改/删除库中任何行、不新增标注字段。

---

## 2. 检索条件

| 项 | 值 |
|---|---|
| 数据库 | `D:\.openclaw\workspace\.pd\state.db` |
| 表 | `principle_applications`、`intervention_evidence_records`、`intervention_capability_declarations` |
| 时间窗 | `2026-11-06T12:55:00.000Z` – `2026-11-06T13:10:00.000Z` |
| 时间列 | `principle_applications.created_at`、`intervention_evidence_records.recorded_at`、`intervention_capability_declarations.declared_at` |
| 标记词 | `runId=aa-run-20261106T1258Z`、`fixtureId=AA-FIXTURE-aa-run-20261106T1258Z`、`sessionId=88b37c98-3052-47ff-9840-37e2d21463da`、`hookInvocationId=4b181412-1734-432d-a281-28e3cb68d8e8`、`principleId=principle-aa-20261106`、`activationId=act-aa-20261106`、`artifactId=art-aa-20261106`、`sourceRef=PRI-1118` |
| 扫描方式 | 三表**全列、全量行**；所有文本列（含 JSON 列）拼为 haystack；逐标记做词面匹配 |
| 辅助表 | `runs`（精确 sessionId、LIKE `aa-run`、窗口内 `started_at`） |

---

## 3. 覆盖范围

| 表 | 全表行数 | 时间窗内行数 | 标记命中 |
|---|---:|---:|---:|
| `principle_applications` | 2,448 | 0 | 0 |
| `intervention_evidence_records` | 12,744 | 16 | 0 |
| `intervention_capability_declarations` | 6 | 0 | 0 |
| `runs`（辅助） | — | 0 | 0 |

- 三表 + `runs` 的 8 类标记**总命中 0**。
- 时间窗内 16 行 `intervention_evidence_records` 的共同特征：`recorded_at = 2026-11-06T13:04:34.339Z`、`source_kind = openclaw_plugin_event_log`、`source_locator = openclaw-plugin-event-log:8e64912c-...`、普通 production principle / `act_prompt_*`，**不含任何 AA 标记**（`principle-aa-20261106` / `act-aa-20261106` / `art-aa-20261106` / runId / fixtureId / sessionId / hookInvocationId）。
- 这 16 行是窗口内的其他生产活动，**不能归因于 1258 运行**；但也不能据此证明它们与 1258 无关（见盲区 B4/B5）。

---

## 4. 只读性证明

| 指标 | 审计前 | 审计后 |
|---|---|---|
| size | 57,442,304 | 57,442,304 |
| mtime | `2026-11-07T02:10:15.734Z` | `2026-11-07T02:10:15.734Z` |
| sha256 | `27adc7899f0e7de8a9a97eaf6b476151937ca9ca25621026f2f7930394ffe0e0` | 同左 |

- 审计前后 size/mtime/sha256 一致（`unchangedByAudit`）。
- WAL `size = 0`（mtime `02:10:15.754Z`）；SHM `32768`。
- 结论：本次审计连接**未修改**生产库。

---

## 5. 结论（区分两种措辞）

**「本次检索范围内未发现 1258 运行的任何记录」。**

**这不等于「已证明 1258 未写入生产库」。**

| 主张 | 状态 |
|---|---|
| 三表当前快照中无 1258 标记 | `confirmed`（本次检索） |
| 时间窗内无 1258 相关行 | `confirmed`（按上述时间列语义） |
| 1258 运行零生产写入 | **`unknown`** |
| 排除清单 v4 仍然有效 | `confirmed`（未修改；本次不替代 v4） |

---

## 6. 盲区（必须同时报告）

| # | 盲区 |
|---|---|
| B1 | 仅扫描三张相关表 + `runs` 辅助表；其他 20+ 表未逐列扫描。 |
| B2 | 仅扫描当前可见行；SQLite 已删除行、自由页、被覆盖的 rowid 不在检索范围。 |
| B3 | WAL 当前 `size=0`；若存在未 checkpoint 的早期 WAL 内容，已不可读。 |
| B4 | 时间窗依赖 `created_at` / `recorded_at` / `declared_at` 语义；`occurred_at` 在 evidence 表多为 null，只填真实发生时间而未填 `recorded_at` 的写入可能漏检。 |
| B5 | 若写入方把 runId 做哈希/截断/编码（非明文），词面检索无法命中。 |
| B6 | 生产库处于活跃写入状态（审计时 mtime 已晚于 1258 运行 13 小时以上）；本次是时点快照，不是运行时序证明。 |
| B7 | “未搜到 runId”不能单独证明未越界写入；只能证明三表当前快照中无该标记。 |

---

## 7. 对结论的影响

- 1258 的“零生产写入”仍为 **`unknown`**；不得改为 `confirmed` 或 `零`。
- 既有隔离机制复核结论不变（PASS）；本次审计补的是**事后证据**，不是修复。
- 本轮 M2 / control / PRI-1119 的裁定不受本次审计影响。
- 若未来需要把“零写入”升级为 `confirmed`，需要：运行前基线 + 运行后同条件快照 + 覆盖更多表/已删除行可读性，或由外部独立审计提供；这不是本轮范围。

---

## 8. 复现方式（只读）

审计脚本为临时脚本，未提交。复现时必须：
1. 以 `readOnly: true` 打开 `D:\.openclaw\workspace\.pd\state.db`；
2. 使用 §2 的条件；
3. 在审计前后记录 size/mtime/sha256；
4. 结果写入 `.tmp`，不写库、不加标注字段。

**禁止**为复现而修改生产库、删除污染记录或改动 v4 清单。
