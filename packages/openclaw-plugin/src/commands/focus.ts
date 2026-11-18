/**
 * /pd-focus command — Principle Context source file inspection (SPEC v1.1 §8).
 *
 * CURRENT_FOCUS.md is the Owner-maintained Principle Context source file. PD
 * never writes it automatically: the compress subcommand and every
 * auto-maintenance path were retired in Batch 1. What remains:
 *
 * - status:   file existence, size, line count, last update time.
 * - history:  list the `.history/` backups (created by explicit rollbacks).
 * - rollback: byte-exact restore of a chosen history backup, after backing up
 *             the current bytes. No version/date/status text is rewritten.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PluginCommandContext, PluginCommandResult, OpenClawPluginApi } from '../openclaw-sdk.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { atomicWriteFileSync } from '../utils/io.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';
import { getHistoryDir, backupToHistory } from '../core/focus-history.js';
import { extractVersion, extractDate } from '@principles/core/prompt-builder';

/**
 * 获取工作区目录
 */
function getWorkspaceDir(ctx: PluginCommandContext): string {
  return resolvePluginCommandWorkspaceDir(ctx, 'focus');
}

interface HistoryEntry {
  name: string;
  path: string;
  mtime: number;
}

function listHistoryEntries(historyDir: string): HistoryEntry[] {
  if (!fs.existsSync(historyDir)) return [];
  // A hostile/broken history location (e.g. a regular FILE at .history, or an
  // unreadable directory) must degrade to "no backups" — never throw into the
  // command surface, and never let a rollback proceed without a scannable
  // history dir.
  let names: string[];
  try {
    names = fs.readdirSync(historyDir);
  } catch {
    return [];
  }
  return names
    .filter(f => f.startsWith('CURRENT_FOCUS.v') && f.endsWith('.md'))
    .map(f => {
      try {
        return {
          name: f,
          path: path.join(historyDir, f),
          mtime: fs.statSync(path.join(historyDir, f)).mtime.getTime(),
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is HistoryEntry => entry !== null)
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 显示 CURRENT_FOCUS 状态（文件事实，不含旧任务/版本/压缩语义）
 */
function showStatus(workspaceDir: string, isZh: boolean): string {
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
  const focusPath = wctx.resolve('CURRENT_FOCUS');

  if (!fs.existsSync(focusPath)) {
    return isZh
      ? '⚠️ CURRENT_FOCUS.md 不存在\n\n💡 该文件由 Owner 手动创建与维护（Principle Context 来源文件）；缺失时 Adaptive 以无上下文方式正常运行'
      : '⚠️ CURRENT_FOCUS.md does not exist\n\n💡 The file is created and maintained manually by the Owner (Principle Context source); a missing file simply means Adaptive runs without context';
  }

  const content = fs.readFileSync(focusPath);
  const stat = fs.statSync(focusPath);
  const lines = content.toString('utf-8').split('\n').length;
  const historyCount = listHistoryEntries(getHistoryDir(focusPath)).length;
  const updatedAt = stat.mtime.toISOString().replace('T', ' ').slice(0, 19);

  if (isZh) {
    return `📄 **CURRENT_FOCUS.md 状态**

| 属性 | 值 |
|------|-----|
| 存在 | ✅ |
| 大小 | ${stat.size} bytes |
| 行数 | ${lines} 行 |
| 更新时间 | ${updatedAt} |
| 历史备份 | ${historyCount} 个 |

💡 输入 \`/pd-focus history\` 查看历史备份
💡 输入 \`/pd-focus rollback <序号>\` 按原始字节恢复`;
  }

  return `📄 **CURRENT_FOCUS.md Status**

| Property | Value |
|----------|-------|
| Exists | ✅ |
| Size | ${stat.size} bytes |
| Lines | ${lines} lines |
| Updated | ${updatedAt} |
| History backups | ${historyCount} |

💡 Type \`/pd-focus history\` to view history backups
💡 Type \`/pd-focus rollback <number>\` to restore raw bytes`;
}

/**
 * 显示历史备份列表（直接扫描 .history/）
 */
function showHistory(workspaceDir: string, isZh: boolean): string {
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
  const focusPath = wctx.resolve('CURRENT_FOCUS');
  const historyDir = getHistoryDir(focusPath);

  const files = listHistoryEntries(historyDir)
    .map(entry => {
      const content = fs.readFileSync(entry.path, 'utf-8');
      return {
        ...entry,
        version: extractVersion(content),
        date: extractDate(content),
        lines: content.split('\n').length,
      };
    });

  if (files.length === 0) {
    return isZh
      ? '📭 暂无历史备份\n\n💡 历史备份仅在显式 rollback 前自动创建（备份当前字节）'
      : '📭 No history backups yet\n\n💡 A backup is created automatically before each explicit rollback (current bytes are preserved)';
  }

  const lines = files.slice(0, 10).map((f, i) => {
    const num = i + 1;
    return isZh
      ? `${num}. \`${f.name}\` - v${f.version} (${f.date}, ${f.lines} 行)`
      : `${num}. \`${f.name}\` - v${f.version} (${f.date}, ${f.lines} lines)`;
  });

  const header = isZh
    ? `📚 **历史备份列表** (最近 ${Math.min(files.length, 10)} 个)\n`
    : `📚 **History Backups** (Last ${Math.min(files.length, 10)})\n`;

  const footer = isZh
    ? `\n\n💡 输入 \`/pd-focus rollback <序号>\` 按原始字节恢复（恢复前会先备份当前文件）`
    : `\n\n💡 Type \`/pd-focus rollback <number>\` to restore raw bytes (the current file is backed up first)`;

  return header + '\n' + lines.join('\n') + footer;
}

/**
 * 回滚到历史备份（fail-closed）：先成功备份当前原始字节，才允许恢复目标备份。
 * 不改写换行符/BOM，不追加版本号、日期或 ROLLBACK 状态文本（SPEC v1.1 §8.2）。
 *
 * 数据保护顺序（P1-1 修复）：任何备份失败都立即中止且不改写当前文件——宁可
 * 回滚失败，也不能让 Owner 当前内容在无备份的情况下被覆盖。当前文件不存在时
 * （无可丢失内容）允许直接恢复。
 */
function rollbackFocus(workspaceDir: string, index: number, isZh: boolean): string {
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
  const focusPath = wctx.resolve('CURRENT_FOCUS');
  const files = listHistoryEntries(getHistoryDir(focusPath));

  if (files.length === 0) {
    return isZh ? '❌ 暂无历史备份可回滚' : '❌ No history backups to rollback';
  }

  if (index < 1 || index > files.length) {
    return isZh
      ? `❌ 无效的序号: ${index}\n\n💡 请输入 1-${files.length} 之间的数字`
      : `❌ Invalid index: ${index}\n\n💡 Please enter a number between 1-${files.length}`;
  }

  const targetFile = files[index - 1];
  if (!targetFile) {
    return isZh
      ? `❌ 无效的序号: ${index}\n\n💡 请输入 1-${files.length} 之间的数字`
      : `❌ Invalid index: ${index}\n\n💡 Please enter a number between 1-${files.length}`;
  }

  // 1. 读取目标备份的原始字节（失败立即中止）。
  let historyBytes: Buffer;
  try {
    historyBytes = fs.readFileSync(targetFile.path);
  } catch {
    return isZh
      ? `❌ 回滚中止：无法读取目标备份 ${targetFile.name}，当前文件未做任何修改。`
      : `❌ Rollback aborted: cannot read the target backup ${targetFile.name}; the current file was left untouched.`;
  }

  // 2. 备份当前原始字节（fail-closed）。当前文件存在——无论是否为空——都必须
  //    先备份成功；备份失败立即中止，绝不继续恢复写入。
  let backedUp = false;
  let backupFailed = false;
  if (fs.existsSync(focusPath)) {
    let currentBytes: Buffer;
    try {
      currentBytes = fs.readFileSync(focusPath);
    } catch {
      currentBytes = Buffer.alloc(0);
      backupFailed = true;
    }
    if (!backupFailed) {
      const backupPath = backupToHistory(focusPath, currentBytes);
      if (backupPath !== null) {
        backedUp = true;
      } else {
        backupFailed = true;
      }
    }
    if (backupFailed) {
      return isZh
        ? `❌ 回滚中止：备份当前文件失败（历史目录不可写或写入被拒绝），当前文件未做任何修改。\n\n💡 修复 ${path.dirname(focusPath)}/.history 的写入权限后重试`
        : `❌ Rollback aborted: backing up the current file failed (history directory not writable or the write was rejected); the current file was left untouched.\n\n💡 Fix write access to ${path.dirname(focusPath)}/.history and retry`;
    }
  }

  // 3. 备份成功（或当前文件不存在）才恢复：按原始字节写入，不重新编码、
  //    不改换行/BOM、不追加任何状态文本。
  try {
    atomicWriteFileSync(focusPath, historyBytes);
  } catch {
    return isZh
      ? `❌ 回滚中止：恢复写入失败，请检查文件权限后重试（恢复前的备份已保留在历史目录）。`
      : `❌ Rollback aborted: the restore write failed; check file permissions and retry (the pre-restore backup is preserved in the history directory).`;
  }

  if (isZh) {
    return `✅ **回滚完成（原始字节恢复）**

| 操作 | 详情 |
|------|------|
| 恢复自 | ${targetFile.name} |
| 恢复字节数 | ${historyBytes.length} bytes |
| 当前文件已先备份 | ${backedUp ? '✅' : '—（当前文件此前不存在，无可备份内容）'} |

💡 内容未做任何改写（换行符/BOM/版本文本均保持原样）`;
  }

  return `✅ **Rollback Complete (raw-byte restore)**

| Action | Details |
|---------|---------|
| Restored From | ${targetFile.name} |
| Bytes Restored | ${historyBytes.length} bytes |
| Current file backed up first | ${backedUp ? '✅' : '— (no current file existed, nothing to back up)'}

💡 No content was rewritten (line endings/BOM/version text preserved verbatim)`;
}

/**
 * 显示帮助
 */
function showHelp(isZh: boolean): string {
  if (isZh) {
    return `📖 **/pd-focus 命令帮助**

\`/pd-focus status\` - 查看文件状态（存在性/大小/行数/更新时间）
\`/pd-focus history\` - 查看历史备份列表
\`/pd-focus rollback <序号>\` - 按原始字节恢复指定备份

**说明：**
- CURRENT_FOCUS.md 现在是 Owner 手动维护的 Principle Context 来源文件，PD 不再自动压缩或改写
- \`compress\` 子命令已退役（Principle Context 不再自动压缩）
- 历史备份仅在显式 rollback 前创建`;
  }

  return `📖 **/pd-focus Command Help**

\`/pd-focus status\` - Show file status (existence/size/lines/updated)
\`/pd-focus history\` - View history backups
\`/pd-focus rollback <number>\` - Restore a backup by raw bytes

**Notes:**
- CURRENT_FOCUS.md is now the Owner-maintained Principle Context source file; PD no longer auto-compresses or rewrites it
- The \`compress\` subcommand is retired (Principle Context is never auto-compressed)
- History backups are created only before an explicit rollback`;
}

/**
 * 处理 /pd-focus 命令
 */
export async function handleFocusCommand(
  ctx: PluginCommandContext,
  _api: OpenClawPluginApi
): Promise<PluginCommandResult> {
  const workspaceDir = getWorkspaceDir(ctx);
  const args = ctx.args || [];
  const subCommand = args[0]?.toLowerCase() || 'status';

  // 检测语言（与 context.ts 保持一致）
  const isZh = (ctx.config?.language as string) === 'zh';

  let result: string;

  switch (subCommand) {
    case 'status':
      result = showStatus(workspaceDir, isZh);
      break;
    case 'history':
    case 'hist':
      result = showHistory(workspaceDir, isZh);
      break;
    // Principle Context (SPEC v1.1 §8.1): compress/cp retired — falls through
    // to the unknown-command branch below by design.
    case 'rollback':
    case 'rb': {
      const index = parseInt(args[1] ?? '', 10);
      if (isNaN(index)) {
        result = isZh
          ? '❌ 请指定要回滚的备份序号\n\n💡 输入 `/pd-focus history` 查看可用备份'
          : '❌ Please specify backup number to rollback\n\n💡 Type `/pd-focus history` to see available backups';
      } else {
        result = rollbackFocus(workspaceDir, index, isZh);
      }
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      result = showHelp(isZh);
      break;
    default:
      result = isZh
        ? `❌ 未知命令: ${subCommand}\n\n${showHelp(isZh)}`
        : `❌ Unknown command: ${subCommand}\n\n${showHelp(isZh)}`;
  }

  return {
    text: result,
  };
}
