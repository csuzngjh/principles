# 事故调查项：2026-11-08 21:03 外部 robocopy /MIR 清空 worktree 池

- 状态：**待调查**，发起方尚未查明。本调查不阻塞 PRI-1152 的 B2/B3 修复。
- 为什么写在这里：按 Owner 要求，本应另建 Linear 事故调查单。但 2026-11-09 创建时，Linear 返回 `USAGE_LIMIT_EXCEEDED`（"You've exceeded the free issue limit for this workspace"），建单失败。调查内容因此先放在本文件，并同步到 PRI-1152 的评论中。Linear 有可用额度后，由 Owner 另建事故单。
- 关联：PRI-1152（受影响工单）；PRI-1143 是另一起事件（cleanup 工具的 `git worktree remove` 穿透 junction），与本事件不同，此处只列出供参考。

## 1. 现场事实

| 项 | 事实 |
|---|---|
| 时间 | 2026-11-08 21:03:29（+08:00） |
| 命令（从进程表读取的完整命令行） | `C:\Windows\System32\robocopy.exe D:/pd-empty D:/Code/_worktrees/principles/PRI-1152-isolated-host-exec-pack /MIR /R:0 /W:0 /NFL /NDL /NJH /NJS` |
| 进程 | pid 39692，父 pid 64420，查询时父进程已退出 |
| 源目录 | `D:\pd-empty`：空目录，创建于 18:02。以空目录为源执行 `/MIR`，会删除目标中的全部内容 |
| 同期现象 | 18:02 至 21:15 之间，worktree 池中另有多个 worktree 消失（从目录列表观察到，操作者不明） |
| 当时生效的保护 | `git worktree lock` 已持有；PD 写入租约有效至 15:32Z；PR #2424 未合并。三项保护都没能阻止删除 |

## 2. 已排除

- PRI-1152 会话从未运行过 robocopy。
- 仓库 `scripts/` 和 `packages/*/src` 中没有引用 robocopy 或 `pd-empty` 的代码（已用 grep 核实）。

## 3. 损失与恢复

- **丢失**：
  - gitignored 的 `artifacts/pri-1152-isolated-host/pp-20261108T095217Z`，即 v3 执行包，清单 sha256 `b16e81284bd1975036c3560f022d28610f1c43550d245e0e4610f926e383b895`。该包从未获批，也从未执行。
  - `.tmp/` 下的会话脚本，以及旧实现反例的结果文件。
- **未丢失**：所有代码提交在删除前都已推送。
- **恢复方式**：在原路径对本任务分支执行 `git worktree add -f -f`，随后 `dev:worktree:claim`、`bootstrap`，`dev:worktree:ready` 判定 READY。这一步**绕过了 dev:worktree 的互斥流程**（当时互斥区为空）。Owner 已要求今后不再用强制操作绕过互斥，后续新 worktree（如 `PRI-1152-presence-surface-registry`）都改走 `npm run dev:worktree`。

## 4. 待调查问题

1. 哪个会话或工具执行了 robocopy /MIR？线索：18:02 创建 `D:\pd-empty` 的进程；当晚各 AI 会话的操作记录。
2. 同期消失的其他 worktree 中，是否有未推送的工作或证据一并丢失？
3. 防护候选（只记录，不在本调查内实现）：
   - 不可再生证据在 worktree 池外保留副本。本任务已执行：`D:\Code\principles\artifacts\pri-1152-isolated-host-evidence\`。
   - 评估批量清理工具是否需要读取 `git worktree lock` 和 PD 租约。

## 5. 边界

本调查不删除任何 worktree，不触碰 `D:\pd-empty`，也不改动其他人的工作。
