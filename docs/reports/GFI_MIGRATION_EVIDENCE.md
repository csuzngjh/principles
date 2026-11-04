# GFI 迁移证据（D1 / P1）

任务：`GFI-COMPLETE-REMOVAL-001` — 验证「老库（v1，仍带 `gfi_before`/`gfi_after`）在 PG 生产打开路径上真正迁移」这一修复（P1）。

- 生成时间：2026-11-04
- SQLite 运行时：`better-sqlite3@13.0.3` → `sqlite_version = 3.53.4`（`ALTER TABLE … DROP COLUMN` 可用，门槛 3.35）
- 真实库路径：`D:\Code\principles\.state\trajectory.db`（**只读**，仅用 SQLite backup API 取一致快照）
- 一切写入：`.tmp/gfi-removal/d1/`（隔离副本），真实 `.state` 未被修改（脚本只以 `readonly: true` 打开源库）
- 脚本：`.tmp/gfi-removal/d1-migration-evidence.mjs`、`.tmp/gfi-removal/d1-class2.mjs`
- 原始数据：`.tmp/gfi-removal/d1/before.json`、`after.json`、`diff-report.json`、`class2/class2.json`

## 结论

**PASS**。真实库副本迁移后差异严格只落在允许的五类，且幂等、缺表不抛。

## 1. 五类差异判定（真实库副本）

| 类 | 判定标准 | 实测 |
| --- | --- | --- |
| ① 旧列消失 | 仅 `tool_calls.gfi_before` / `gfi_after` 消失 | `class1_gfiColumnsRemoved = ["gfi_before","gfi_after"]`，`unexpectedColumnChanges = []` |
| ② pending empathy 收敛 | 仅 `status=pending AND suggested_type=empathy` 行变为 `abandoned` + `resolution='gfi_removal'` | 真实库 `signal_confirmations` 为 0 行，故在副本内植入 3 行（pending empathy / pending correction / confirmed correction）→ **仅** empathy 行三个字段变化；`allNonSeedRowsUntouched = true` |
| ③ 其余表不变 | 行数、列、全部行摘要一致 | `class3_rowCountChanges = []`，21 张表 `unchangedTableDigests` 全部一致（含 `pain_events` 161 行 `tool_calls` 不变） |
| ④ 幂等 | 二次迁移无新增差异 | `class4_idempotent = true`（after 与 afterSecond 字节级 JSON 相同） |
| ⑤ 缺表不抛 | 空库（无任何表）不抛 | `class5_missingTableError = null`（随后 `applyTrajectorySchemaBase` 建表成功） |

## 2. 真实库前后规模

| 指标 | before | after |
| --- | --- | --- |
| 表数量 | 23 | 23 |
| `tool_calls` 列数 | 16（含 `gfi_before`、`gfi_after`） | 14 |
| `tool_calls` 行数 | 161 | 161 |
| `signal_confirmations` 行数 | 0 | 0 |

迁移后 `tool_calls` 列：`id, session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message, params_json, result_preview, created_at, tool_use_id, project_dir, host_kind`。

## 3. 失败路径的显式点名（负控，单元测试）

P1 的核心验收点是「迁移失败绝不被伪装成成功」。证据在 `packages/host-runtime/tests/production-pain-evidence.test.ts`：

- `fails loud instead of pretending canonical when the legacy columns cannot be dropped (handler path)`
  → `decision='observe'`、`metadata.outcome='unavailable'`、`warnings` 含 `trajectory_migration_failed:simulated_legacy_column_drop_failure`、`nextAction='repair the selected PD trajectory database (legacy GFI columns could not be dropped), then retry'`；且 `tool_calls` 行数仍为 0、两列仍在（没有伪装成功）。
- `fails loud instead of reporting a successful write when the verified-writer migration fails`
  → `status='unavailable'` + 同前缀 reason，写入未发生。

## 4. 新库（v2）不误判（单元测试）

- `a canonical v2 database is not misjudged as legacy and stays idempotent`
  → 首次 `dispatch` 无迁移告警、`outcome='failure'`、第二次 `duplicate=true`，`tool_calls` 仍 1 行，`signal_confirmations` 的 pending correction 行保持 `pending`（无误伤）。
- 真实库副本二次迁移 `class4_idempotent = true`。

## 5. 附带的真实缺陷（同文件、移除自身回归）

`62e2cab15` 从 `INSERT INTO tool_calls` 的列清单删掉 `gfi_before`/`gfi_after`，但 `.run(...)` 仍多传两个 `null` → 生产 `recordVerifiedToolOutcomes` 每次写入抛 `Too many parameter values were provided`。已在本块按 12 列对齐修正，并由 `recordVerifiedToolOutcomes migrates the same legacy database before writing verified rows` 覆盖。
