# 核心库导出清理（B1）· 一页结论

> 基线：`origin/main` @ `76d565d2d` → 三批合入后主干
> 口径：TypeScript AST + 全仓符号解析（相对导入、桶转发、命名空间访问、动态 import/require、文档提及全部计入引用）；旧 grep 数已作废
> 明细清单：`docs/reports/PD_CORE_EXPORT_CLEANUP_B1_INVENTORY_20261112.md`

## 一句话

三批共收回 **261 个零引用的内部导出符号**，**公开接口 0 增 0 减**（仍是 27 个入口、2,351 个符号），门禁、类型检查、全仓构建、core 全量测试四项每批全绿。

## 三批结果

| 批次 | 类别 | 删除符号 | 动作 | 合入 |
|---|---|---:|---|---|
| 1 | S：声明仍被本文件使用 | 167 | 只删 `export` 修饰符，声明保留 | PR #2571 / `02ca2cd72` |
| 2 | L：声明无任何使用点 | 43 | 连声明一起删（41 类型别名 + 2 常量） | PR #2573 / `6409c04d6` |
| 3 | A：别名条目（9）/ R：内部桶转发（42） | 51 | 只删别名与转发 specifier，声明保留 | 本 PR |
| **合计** | | **261** | | |

候选集共 266 个符号，删 261、跳过 5，账目闭合。

## 公开接口

- `package.json#exports`：27 个子路径，未改动。
- 公开面符号：**2,351 个，未增加、未减少**。
- 门禁实测（每批）：`27 entry points, 2791 symbol slots, 2351 unique symbols — no change (0 added, 0 removed)`，exit 0。

## 跳过的 5 个（不是删不掉，是"不该删"）

| 符号 | 原因 |
|---|---|
| `CONVERSATION_ACCESS_CONFIG_KEY` | 配置键字面量，其它包以自有字面量使用；配置契约保留单一出处 |
| `WORKSPACE_STATE_DB_RELATIVE_PATH` | 与进行中的 `ai/storage-path-single-source` 存储路径收敛线重复，删除会制造无谓冲突 |
| `WORKSPACE_TRAJECTORY_DB_RELATIVE_PATH` | 同上 |
| `SqliteArtifactStore` | 架构回归测试显式断言该桶必须导出它（`architecture-regression.test.ts:929`） |
| `SqliteCommitStore` | 同上（`architecture-regression.test.ts:940`） |

## 验证（每批四项，缺一不可）

| 项 | 结果 |
|---|---|
| 门禁 `CI=true node scripts/check-core-export-surface.mjs` | exit 0，`+0 / -0`（三批一致） |
| `npm run typecheck --workspace=@principles/core` | 通过 |
| 全仓 `npm run build`（11 个 workspace） | 通过 |
| `npm test --workspace=@principles/core` | 482 个文件 / 9,143 用例通过，0 失败 |

## 还剩什么、为什么

1. **公开面上的零引用导出：1,129 个条目 / 968 个符号**（全仓零引用、文档零提及，但被 27 个公开入口之一可达）。未处理，因为删除它们会改变对外 API，需要走"移出公开面"的准入/发版决策（是否 minor/major、是否保留兼容期），不属于内部清理范畴。
2. **仅在 core 内部测试使用的导出**：属于测试辅助面，删除需同步迁移测试导入，单独立项更稳。
3. **跳过 5 个**：见上表。

## 限制

- 外部 npm 消费者不可观测；本仓"零引用"不等于发布后零使用。三批均未改公开面，因此不影响外部消费者。
- 文档中出现的符号一律未删（作为保守条件剔除）。
