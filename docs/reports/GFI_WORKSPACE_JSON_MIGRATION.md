# GFI 历史 workspace JSON 迁移工具（PRI-1149）

> 状态：**工具就绪 / 真实数据迁移待 Owner 授权**（2026-11-10）
> 关联：Linear PRI-1149 · PR #2332 · `docs/specs/GFI_COMPLETE_REMOVAL_SPEC.md` §6.2 / §6.3 / §15.3

## 1. 解决什么问题

PR #2332 已删除 GFI 生产逻辑、SQLite 列与 CLI / Console 表面，但**没有清理历史 JSON 文件**：

- `packages/openclaw-plugin/src/core/session-tracker.ts` 读 `sessions/*.json` 后原样
  `JSON.stringify(state)` 写回，未知历史键会被一并保留并重新写入；
- `packages/openclaw-plugin/src/core/event-log.ts` 读 `daily-stats.json` 后把每日记录对象
  原样放入缓存并整体写回，`gfi` 子对象因此长期残留。

这些字段**不参与任何计算**，不会让 GFI 复活；本工具只做「完整退役」的数据收尾，
不改变 Pain / GFI 运行时语义，也不恢复任何 GFI 计算。

## 2. 清理范围（严格限定）

| 文件 | 删除内容 |
| --- | --- |
| `<state>/sessions/*.json` | 顶层 7 个键：`currentGfi`、`gfiBySource`、`lastErrorHash`、`lastErrorSource`、`consecutiveErrors`、`lastGfiDecayAt`、`dailyGfiPeak` |
| `<state>/logs/daily-stats.json` | 每个日期记录里的 `gfi` 子对象 |

明确**不**处理：

- 不递归删除嵌套对象中的同名键；
- 不改动任何其它 JSON 文件、SQLite 库或历史事件 `events_*.jsonl`；
- 不改动 `packages/**/tests/**` 里保留旧形状的测试夹具（`GFI_RESIDUAL_SCAN.md` §1 L2）；
- 不删除 `gfi` 的 `gone` 墓碑（DC-01 方案 A，Owner 已批准保留）；
- 不触碰 `pd-task-reconciler.ts` 中同名但语义无关的 `consecutiveErrors`。

## 3. 为什么是独立离线脚本

`loadAllSessions()` 会跳过 `lastActivityAt < 2h` 的 session，而 SPEC §6.2 要求
「对所有文件执行，包括已经过期的 Session」。因此不能挂到运行时写回路径，
必须由脚本直接遍历目录。

> **执行前请停止 PD 宿主进程**：仍在内存中的旧 session 可能在迁移后被写回，
> 把已删除的键重新带回来。

## 4. 用法

```bash
# 第 1 步：只读盘点（默认 dry-run，不写任何文件）
npm run gfi:migrate -- --workspace <工作区路径> [--state-dir <状态目录>] [--json]

# 第 2 步：确认输出中的「将修改」文件与键无误，并已停止 PD 宿主进程
# 第 3 步：Owner 单独授权后执行
npm run gfi:migrate -- --workspace <工作区路径> \
  --apply --confirm-owner-authorization [--backup-dir <备份目录>] [--json]
```

默认状态目录为 `<workspace>/.state`；布局不同时用 `--state-dir` 显式指定。
`--apply` **必须**配合 `--confirm-owner-authorization`，否则直接退出（exit 2），
这是把工单「实际执行需 Owner 单独授权」变成机器可检查的显式动作。

`--json` 时 stdout 只有一个 JSON 对象，便于归档证据。退出码：`0` 成功 /
`1` 失败或拒绝 / `2` 参数或授权错误。

## 5. 安全机制

| 机制 | 实现 |
| --- | --- |
| 默认 dry-run | 无 `--apply` 时只读，输出待改文件与键 |
| 停写保护 | `--apply` 需 Owner 显式授权标志 |
| 备份 | 写入前把**所有**待改文件按原相对路径复制到备份目录；任一备份失败即整体中止，不写任何文件 |
| 原子写入 | 同目录临时文件 + `rename`，带 Windows `EPERM/EBUSY/EACCES` 重试，语义对齐 `packages/openclaw-plugin/src/utils/io.ts` |
| 回读校验 | 每个文件写后重新 `JSON.parse`，与计划对象逐字段比对；确认可解析、无字段丢失/新增/重复、目标键确实消失 |
| 自动回滚 | 任一写入或校验失败，把已写文件从备份复制回原位，整体恢复 |
| 幂等 | 二次运行 0 变更、不创建备份、不写盘 |
| fail-closed | 存在损坏 JSON / 不可读 / 只读文件时，整体拒绝写入并点名文件，交 Owner 处理 |

## 6. 备份位置与回滚

- 默认：`<state>/gfi-migration-backups/<UTC 时间戳>-<随机后缀>/`，
  内部按 `sessions/xxx.json`、`logs/daily-stats.json` 保留相对路径；
- 可用 `--backup-dir` 指定其它位置，建议 Owner 另行归档留存。

回滚（把备份目录内容按相对路径覆盖回状态目录）：

```bash
# POSIX
cp -r "<备份目录>/." "<状态目录>/"

# Windows
robocopy "<备份目录>" "<状态目录>" /E
```

回滚前同样先停 PD 宿主进程。

## 7. 验收结果

`node node_modules/vitest/vitest.mjs run --root scripts --config scripts/vitest.config.ts
__tests__/gfi-workspace-json-migration.test.ts` → **18 / 18 passed**。

覆盖工单要求的 6 个场景，以及额外边界：

| 场景 | 断言要点 |
| --- | --- |
| 有 GFI 残留 | dry-run 不写盘；apply 删 7 键；Receipt 字段（`injectedPrincipleIds` / `injectedActivationIds` / `receiptAutoCorrects`）前后完全一致；备份内容等于原文 |
| 无 GFI 残留 | 0 变更、不创建备份目录 |
| 损坏 JSON | 整体拒绝、损坏文件字节不变、其它文件也不写 |
| 只读文件 | 报告并整体拒绝 |
| 备份失败 | 注入失败 + CLI 真实路径失败（备份目录被占用）两种验证，均不写盘 |
| 重复运行 | 第二次 `no_changes`、0 变更 |
| 写入失败 | 自动回滚已写文件，`rollbackErrors` 为空 |
| 作用域 | 嵌套 `gfi` 不动、daily-stats 同名 `consecutiveErrors` 不动、JSONL 不动 |
| CLI 边界 | 默认 dry-run、缺授权 exit 2、`--json` 单对象、apply 摘要 |

门禁：`check:runtime-writers` PASS（9 处 allowlist，无新增 trip）、
`check:repo-hygiene` PASS。

## 8. 仍未完成 / 需 Owner 决策

1. **真实 Owner 工作区数据迁移尚未执行**，本工具及其测试全程只使用隔离临时工作区，
   未读取也未修改任何真实 `.state` 数据。
2. 实际执行需要 Owner 单独授权（对应 `--confirm-owner-authorization`）。
3. 执行后建议再跑一次 dry-run 确认 0 变更，并把前后摘要归档；
   之后 GFI-1 才可从 `NOT_IMPLEMENTED` 改为已完成。

## 9. 关联

- SPEC：`docs/specs/GFI_COMPLETE_REMOVAL_SPEC.md` §6.2 / §6.3 / §15.3
- 移除本体：PR #2332（2026-11-04 合并）
- 收尾文档：PR #2401（2026-11-07 合并，纯文档）
- 既有证据：`docs/reports/GFI_FINAL_ACCEPTANCE.md` §8、
  `docs/reports/GFI_RESIDUAL_SCAN.md`（注意：`GFI_MIGRATION_EVIDENCE.md` 记录的是
  **SQLite 列迁移**，不是本工具处理的 JSON 迁移）
