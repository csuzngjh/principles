/**
 * /pd-focus 命令 - 管理 CURRENT_FOCUS.md
 *
 * 功能：
 * - status: 查看当前状态和历史版本
 * - compress: 手动压缩并备份
 * - history: 查看历史版本列表
 * - rollback: 回滚到指定历史版本
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import type { PluginCommandContext, PluginCommandResult, OpenClawPluginApi } from '../openclaw-sdk.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import {
  getHistoryDir,
  backupToHistory,
  cleanupHistory,
  extractVersion,
  extractDate,
  extractMilestones,
  archiveMilestonesToDaily,
  cleanupStaleInfo,
} from '../core/focus-history.js';

/**
 * 清理 Markdown 代码块围栏
 * 移除开头的 ```lang 和结尾的 ```
 */
function stripMarkdownFence(content: string): string {
  let result = content.trim();
  // 移除开头的代码块标记（如 ```markdown, ```text 等）
  result = result.replace(/^```[\w]*\n?/, '');
  // 移除结尾的代码块标记
  result = result.replace(/\n?```$/, '');
  return result.trim();
}

/**
 * 获取工作区目录
 */
function getWorkspaceDir(ctx: PluginCommandContext): string {
  const workspaceDir = ctx.config?.workspaceDir as string | undefined;
  if (!workspaceDir) {
    throw new Error('[PD:Focus] workspaceDir is required but not provided');
  }
  return workspaceDir;
}

/**
 * 压缩 CURRENT_FOCUS内容
 *
 * 规则：
 * - 保留：标题、元数据、状态快照
 * - 保留：下一步章节（完整）
 * - 保留：当前任务中未完成的项（- [ ]）
 * - 移除：当前任务中已完成的项（- [x]）超过 3 个时
 * - 移除：P0 章节如果全部完成
 * - 保留：参考章节
 * - 清理：Working Memory 超过 10 条记录时保留最近 10 条
 * - 验证：文件引用指向不存在的文件时移除
 */
function compressFocusContent(content: string, workspaceDir?: string): string {
  // 首先使用 cleanupStaleInfo 进行基础清理
  let result = cleanupStaleInfo(content, workspaceDir);

  const lines = result.split('\n');
  const output: string[] = [];
  let currentSection = '';
  let inP0Section = false;
  let p0AllCompleted = true;
  let p0Lines: string[] = [];
  let completedCount = 0;

  // 辅助函数：刷新 P0 章节缓存
  const flushP0Lines = (skipIfCompleted: boolean) => {
    if (inP0Section && p0Lines.length > 0) {
      if (!skipIfCompleted || !p0AllCompleted) {
        // P0 有未完成任务，保留 P0 内容
        output.push(...p0Lines);
      }
      // 重置状态
      p0Lines = [];
      inP0Section = false;
      p0AllCompleted = true;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // 识别章节
    if (/^#{1,3}\s*.*状态快照|📍/.test(trimmedLine)) {
      flushP0Lines(true); // P0 完成时跳过
      currentSection = 'snapshot';
    } else if (/^###\s*P0/i.test(trimmedLine)) {
      currentSection = 'current_p0';
      inP0Section = true;
      p0AllCompleted = true;
      p0Lines = [line];
      continue;
    } else if (/^###\s*P[1-9]/i.test(trimmedLine)) {
      // 离开 P0 章节
      flushP0Lines(true); // P0 完成时跳过，未完成时保留
      currentSection = 'current';
      output.push(line);
      continue;
    } else if (/^#{1,3}\s*.*当前任务|🔄/.test(trimmedLine)) {
      flushP0Lines(true); // P0 完成时跳过
      currentSection = 'current';
    } else if (/^#{1,3}\s*.*下一步|➡️/.test(trimmedLine)) {
      flushP0Lines(false); // 保留未完成的 P0
      currentSection = 'nextSteps';
    } else if (/^#{1,3}\s*.*参考|📎/.test(trimmedLine)) {
      flushP0Lines(false); // 保留未完成的 P0
      currentSection = 'reference';
    }

    // 处理P0章节
    if (inP0Section) {
      p0Lines.push(line);
      // 检查是否有未完成任务
      if (/^-\s*\[\s*\]/.test(trimmedLine)) {
        p0AllCompleted = false;
      }
      continue;
    }

    // 处理当前任务章节中已完成的项
    if (currentSection === 'current') {
      if (/^-\s*\[x\]/i.test(trimmedLine)) {
        completedCount++;
        // 如果已完成项超过 3 个，跳过
        if (completedCount > 3) {
          continue;
        }
      }
    }

    output.push(line);
  }

  // 循环结束后，刷新剩余的 P0 章节
  flushP0Lines(false); // 保留未完成的 P0

  return output.join('\n');
}

/**
 * 显示 CURRENT_FOCUS 状态
 */
function showStatus(workspaceDir: string, isZh: boolean): string {
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
  const focusPath = wctx.resolve('CURRENT_FOCUS');
  const historyDir = getHistoryDir(focusPath);

  if (!fs.existsSync(focusPath)) {
    return isZh
      ? '⚠️ CURRENT_FOCUS.md 不存在\n\n💡 请先运行 `/pd-init` 初始化工作区'
      : '⚠️ CURRENT_FOCUS.md does not exist\n\n💡 Run `/pd-init` to initialize workspace first';
  }

  const content = fs.readFileSync(focusPath, 'utf-8');
  const version = extractVersion(content);
  const date = extractDate(content);
  const lines = content.split('\n').length;

  // 统计历史版本
  let historyCount = 0;
  if (fs.existsSync(historyDir)) {
    historyCount = fs.readdirSync(historyDir).filter(f => f.startsWith('CURRENT_FOCUS.v')).length;
  }

  if (isZh) {
    return `📄 **CURRENT_FOCUS.md 状态**

| 属性 | 值 |
|------|-----|
| 版本 | v${version} |
| 更新日期 | ${date} |
| 行数 | ${lines} 行 |
| 历史版本 | ${historyCount} 个 |

💡 输入 \`/pd-focus history\` 查看历史版本
💡 输入 \`/pd-focus compress\` 手动压缩`;
  }

  return `📄 **CURRENT_FOCUS.md Status**

| Property | Value |
|----------|-------|
| Version | v${version} |
| Updated | ${date} |
| Lines | ${lines} lines |
| History | ${historyCount} versions |

💡 Type \`/pd-focus history\` to view history
💡 Type \`/pd-focus compress\` to compress manually`;
}

/**
 * 显示历史版本列表
 */
function showHistory(workspaceDir: string, isZh: boolean): string {
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
  const focusPath = wctx.resolve('CURRENT_FOCUS');
  const historyDir = getHistoryDir(focusPath);

  if (!fs.existsSync(historyDir)) {
    return isZh
      ? '📭 暂无历史版本\n\n💡 历史版本在压缩 CURRENT_FOCUS.md 时自动创建'
      : '📭 No history versions yet\n\n💡 History is created when CURRENT_FOCUS.md is compressed';
  }

  const files = fs.readdirSync(historyDir)
    .filter(f => f.startsWith('CURRENT_FOCUS.v') && f.endsWith('.md'))
    .map(f => {
      const filePath = path.join(historyDir, f);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        name: f,
        version: extractVersion(content),
        date: extractDate(content),
        mtime: stat.mtime,
        lines: content.split('\n').length,
      };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (files.length === 0) {
    return isZh ? '📭 暂无历史版本' : '📭 No history versions';
  }

  const lines = files.slice(0, 10).map((f, i) => {
    const num = i + 1;
    return isZh
      ? `${num}. \`${f.name}\` - v${f.version} (${f.date}, ${f.lines} 行)`
      : `${num}. \`${f.name}\` - v${f.version} (${f.date}, ${f.lines} lines)`;
  });

  const header = isZh
    ? `📚 **历史版本列表** (最近 ${Math.min(files.length, 10)} 个)\n`
    : `📚 **History Versions** (Last ${Math.min(files.length, 10)})\n`;

  const footer = isZh
    ? `\n\n💡 输入 \`/pd-focus rollback <序号>\` 回滚到指定版本`
    : `\n\n💡 Type \`/pd-focus rollback <number>\` to rollback`;

  return header + '\n' + lines.join('\n') + footer;
}

/**
 * 手动压缩 CURRENT_FOCUS.md（使用子智能体）
 */
async function compressFocus(
  workspaceDir: string,
  isZh: boolean,
  api: OpenClawPluginApi
): Promise<string> {
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
  const focusPath = wctx.resolve('CURRENT_FOCUS');

  if (!fs.existsSync(focusPath)) {
    return isZh
      ? '❌ CURRENT_FOCUS.md 不存在'
      : '❌ CURRENT_FOCUS.md does not exist';
  }

  const oldContent = fs.readFileSync(focusPath, 'utf-8');
  const oldVersion = extractVersion(oldContent);
  const oldDate = extractDate(oldContent);
  const oldLines = oldContent.split('\n').length;

  // 检查是否需要压缩
  if (oldLines <= 40) {
    return isZh
      ? `✅ 当前文件仅 ${oldLines} 行，无需压缩\n\n💡 文件少于 40 行时不建议压缩`
      : `✅ Current file has only ${oldLines} lines, no need to compress\n\n💡 Compression not recommended for files under 40 lines`;
  }

  // 1. 提取里程碑
  const milestones = extractMilestones(oldContent);

  // 2. 归档里程碑到 daily memory（而非 MEMORY.md）
  const archivePath = archiveMilestonesToDaily(workspaceDir, milestones, oldVersion);
  const milestonesArchived = archivePath !== null;

  // 3. 备份当前版本
  const backupPath = backupToHistory(focusPath, oldContent);

  // 4. 清理过期历史
  cleanupHistory(focusPath);

  // 5. 压缩内容
  let compressedContent: string;
  try {
    compressedContent = compressFocusContent(oldContent, workspaceDir);
    api.logger?.info?.(`[PD:Focus] Compressed CURRENT_FOCUS from ${oldLines} lines`);
  } catch (error) {
    api.logger?.error?.(`[PD:Focus] Compression failed: ${String(error)}`);
    compressedContent = oldContent;
  }

  // 6. 更新版本号和日期
  const versionParts = oldVersion.split('.');
  const majorVersion = parseInt(versionParts[0], 10) || 1;
  const newVersion = `${majorVersion + 1}`;
  const today = new Date().toISOString().split('T')[0];
  const newContent = compressedContent
    .replace(/\*\*版本\*\*:\s*v[\d.]+/i, `**版本**: v${newVersion}`)
    .replace(/\*\*更新\*\*:\s*\d{4}-\d{2}-\d{2}/, `**更新**: ${today}`);

  const newLines = newContent.split('\n').length;
  const savedLines = oldLines - newLines;

  fs.writeFileSync(focusPath, newContent, 'utf-8');

  const milestoneNote = milestonesArchived
    ? isZh
      ? `📝 里程碑已归档到 memory/${today}.md`
      : `📝 Milestones archived to memory/${today}.md`
    : '';

  if (isZh) {
    return `✅ **压缩完成**

| 操作 | 详情 |
|------|------|
| 旧版本 | v${oldVersion} (${oldDate}) |
| 新版本 | v${newVersion} (${today}) |
| 压缩前 | ${oldLines} 行 |
| 压缩后 | ${newLines} 行 |
| 节省 | ${savedLines} 行 |
| 备份文件 | ${backupPath ? path.basename(backupPath) : '已存在'} |

${milestoneNote ? `${milestoneNote}\n` : ''}
💡 已压缩版本已备份到历史目录
💡 输入 \`/pd-focus history\` 查看所有历史版本`;
  }

  return `✅ **Compression Complete**

| Action | Details |
|--------|---------|
| Old Version | v${oldVersion} (${oldDate}) |
| New Version | v${newVersion} (${today}) |
| Before | ${oldLines} lines |
| After | ${newLines} lines |
| Saved | ${savedLines} lines |
| Backup File | ${backupPath ? path.basename(backupPath) : 'exists'} |

${milestoneNote ? `${milestoneNote}\n` : ''}
💡 Compressed version backed up to history
💡 Type \`/pd-focus history\` to view all versions`;
}

/**
 * 回滚到历史版本
 */
function rollbackFocus(workspaceDir: string, index: number, isZh: boolean): string {
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
  const focusPath = wctx.resolve('CURRENT_FOCUS');
  const historyDir = getHistoryDir(focusPath);

  if (!fs.existsSync(historyDir)) {
    return isZh ? '❌ 暂无历史版本可回滚' : '❌ No history versions to rollback';
  }

  const files = fs.readdirSync(historyDir)
    .filter(f => f.startsWith('CURRENT_FOCUS.v') && f.endsWith('.md'))
    .map(f => ({
      name: f,
      path: path.join(historyDir, f),
      mtime: fs.statSync(path.join(historyDir, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (index < 1 || index > files.length) {
    return isZh
      ? `❌ 无效的序号: ${index}\n\n💡 请输入 1-${files.length} 之间的数字`
      : `❌ Invalid index: ${index}\n\n💡 Please enter a number between 1-${files.length}`;
  }

  const targetFile = files[index - 1];
  const historyContent = fs.readFileSync(targetFile.path, 'utf-8');

  // 备份当前版本
  const currentContent = fs.existsSync(focusPath)
    ? fs.readFileSync(focusPath, 'utf-8')
    : '';
  if (currentContent) {
    backupToHistory(focusPath, currentContent);
  }

  // 恢复历史版本
  const restoredVersion = extractVersion(historyContent);
  const restoredDate = extractDate(historyContent);
  const today = new Date().toISOString().split('T')[0];

  // 获取最大版本号（从当前文件或历史文件中）
  let maxVersion = parseFloat(restoredVersion) || 1;
  if (currentContent) {
    const currentVersion = parseFloat(extractVersion(currentContent)) || 1;
    if (currentVersion > maxVersion) {
      maxVersion = currentVersion;
    }
  }

  // 正常递增版本号
  const newVersion = `${maxVersion + 1}`;

  // 添加回滚标记到状态字段
  const restoredContent = historyContent
    .replace(/\*\*版本\*\*:\s*v[\d.]+/i, `**版本**: v${newVersion}`)
    .replace(/\*\*更新\*\*:\s*\d{4}-\d{2}-\d{2}/, `**更新**: ${today}`)
    .replace(
      /\*\*状态\*\*:\s*[A-Z]+/i,
      `**状态**: ROLLBACK (from v${restoredVersion})`
    );

  fs.writeFileSync(focusPath, restoredContent, 'utf-8');

  if (isZh) {
    return `✅ **回滚成功**

| 操作 | 详情 |
|------|------|
| 恢复自 | ${targetFile.name} |
| 原版本 | v${restoredVersion} (${restoredDate}) |
| 新版本 | v${newVersion} (${today}) |

💡 当前版本已备份，可再次回滚`;
  }

  return `✅ **Rollback Complete**

| Action | Details |
|--------|---------|
| Restored From | ${targetFile.name} |
| Original Version | v${restoredVersion} (${restoredDate}) |
| New Version | v${newVersion} (${today}) |

💡 Current version backed up, you can rollback again`;
}

/**
 * 显示帮助
 */
function showHelp(isZh: boolean): string {
  if (isZh) {
    return `📖 **/pd-focus 命令帮助**

\`/pd-focus status\` - 查看 CURRENT_FOCUS.md 状态
\`/pd-focus history\` - 查看历史版本列表
\`/pd-focus compress\` - 手动压缩并备份
\`/pd-focus rollback <序号>\` - 回滚到指定历史版本

**功能说明：**
- 历史版本在压缩时自动创建
- 最多保留 10 个历史版本
- Full 模式会读取当前版本 + 最近 3 个历史版本`;
  }

  return `📖 **/pd-focus Command Help**

\`/pd-focus status\` - Show CURRENT_FOCUS.md status
\`/pd-focus history\` - View history versions list
\`/pd-focus compress\` - Manually compress and backup
\`/pd-focus rollback <number>\` - Rollback to specified version

**Features:**
- History versions created during compression
- Maximum 10 history versions retained
- Full mode reads current + last 3 history versions`;
}

/**
 * 处理 /pd-focus 命令
 */
export async function handleFocusCommand(
  ctx: PluginCommandContext,
  api: OpenClawPluginApi
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
    case 'compress':
    case 'cp':
      result = await compressFocus(workspaceDir, isZh, api);
      break;
    case 'rollback':
    case 'rb':
      const index = parseInt(args[1], 10);
      if (isNaN(index)) {
        result = isZh
          ? '❌ 请指定要回滚的版本序号\n\n💡 输入 `/pd-focus history` 查看可用版本'
          : '❌ Please specify version number to rollback\n\n💡 Type `/pd-focus history` to see available versions';
      } else {
        result = rollbackFocus(workspaceDir, index, isZh);
      }
      break;
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
