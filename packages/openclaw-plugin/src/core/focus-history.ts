/**
 * CURRENT_FOCUS 历史版本管理
 *
 * 功能：
 * - 压缩时备份当前版本到历史目录
 * - 清理过期历史版本
 * - 读取历史版本（用于 full 模式）
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * 简单的日志记录器
 */
function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errorStr = error instanceof Error ? error.message : String(error);
  console.error(`[focus-history] ${timestamp} ERROR: ${message}${errorStr ? ' - ' + errorStr : ''}`);
}

/** 历史版本保留数量 */
const MAX_HISTORY_FILES = 10;

/** full 模式读取的历史版本数 */
const FULL_MODE_HISTORY_COUNT = 3;

/**
 * 获取历史目录路径
 */
export function getHistoryDir(focusPath: string): string {
  return path.join(path.dirname(focusPath), '.history');
}

/**
 * 从 CURRENT_FOCUS.md 提取版本号
 */
export function extractVersion(content: string): number {
  const match = content.match(/\*\*版本\*\*:\s*v(\d+)/i);
  return match ? parseInt(match[1], 10) : 1;
}

/**
 * 从 CURRENT_FOCUS.md 提取更新日期
 */
export function extractDate(content: string): string {
  const match = content.match(/\*\*更新\*\*:\s*(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date().toISOString().split('T')[0];
}

/**
 * 备份当前版本到历史目录
 *
 * @param focusPath CURRENT_FOCUS.md 的完整路径
 * @param content 当前内容
 * @returns 备份文件路径，失败返回 null
 */
export function backupToHistory(focusPath: string, content: string): string | null {
  try {
    const historyDir = getHistoryDir(focusPath);

    // 确保历史目录存在
    if (!fs.existsSync(historyDir)) {
      try {
        fs.mkdirSync(historyDir, { recursive: true });
      } catch (error) {
        logError(`Failed to create history directory: ${historyDir}`, error);
        return null;
      }
    }

    const version = extractVersion(content);
    const date = extractDate(content);
    const backupName = `CURRENT_FOCUS.v${version}.${date}.md`;
    const backupPath = path.join(historyDir, backupName);

    // 如果备份已存在，跳过
    if (fs.existsSync(backupPath)) {
      return null;
    }

    try {
      fs.writeFileSync(backupPath, content, 'utf-8');
      return backupPath;
    } catch (error) {
      logError(`Failed to write backup file: ${backupPath}`, error);
      return null;
    }
  } catch (error) {
    logError('Unexpected error in backupToHistory', error);
    return null;
  }
}

/**
 * 清理过期历史版本
 *
 * @param focusPath CURRENT_FOCUS.md 的完整路径
 * @param maxFiles 最大保留数量
 */
export function cleanupHistory(focusPath: string, maxFiles: number = MAX_HISTORY_FILES): void {
  try {
    const historyDir = getHistoryDir(focusPath);

    if (!fs.existsSync(historyDir)) {
      return;
    }

    // 获取所有历史文件并按修改时间排序（最新的在前）
    const files = fs.readdirSync(historyDir)
      .filter(f => f.startsWith('CURRENT_FOCUS.v') && f.endsWith('.md'))
      .map(f => ({
        name: f,
        path: path.join(historyDir, f),
        mtime: fs.statSync(path.join(historyDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime);

    // 删除超出数量的文件
    const toDelete = files.slice(maxFiles);
    for (const file of toDelete) {
      try {
        fs.unlinkSync(file.path);
      } catch (error) {
        // 单个文件删除失败不应中断整个清理过程
        logError(`Failed to delete history file: ${file.path}`, error);
      }
    }
  } catch (error) {
    logError('Unexpected error in cleanupHistory', error);
  }
}

/**
 * 获取历史版本列表
 *
 * @param focusPath CURRENT_FOCUS.md 的完整路径
 * @param count 获取数量
 * @returns 历史版本内容数组（按时间倒序）
 */
export function getHistoryVersions(focusPath: string, count: number = FULL_MODE_HISTORY_COUNT): string[] {
  const historyDir = getHistoryDir(focusPath);

  if (!fs.existsSync(historyDir)) {
    return [];
  }

  // 获取所有历史文件并按修改时间排序（最新的在前）
  const files = fs.readdirSync(historyDir)
    .filter(f => f.startsWith('CURRENT_FOCUS.v') && f.endsWith('.md'))
    .map(f => ({
      path: path.join(historyDir, f),
      mtime: fs.statSync(path.join(historyDir, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, count);

  return files.map(f => fs.readFileSync(f.path, 'utf-8'));
}

/**
 * 压缩 CURRENT_FOCUS.md
 *
 * @param focusPath CURRENT_FOCUS.md 的完整路径
 * @param newContent 新内容
 * @returns 压缩后的信息
 */
export function compressFocus(focusPath: string, newContent: string): {
  backupPath: string | null;
  cleanedCount: number;
} {
  // 读取当前内容
  let oldContent = '';
  if (fs.existsSync(focusPath)) {
    oldContent = fs.readFileSync(focusPath, 'utf-8');
  }

  // 备份当前版本
  const backupPath = oldContent ? backupToHistory(focusPath, oldContent) : null;

  // 递增版本号
  const oldVersion = extractVersion(oldContent);
  const newVersion = oldVersion + 1;
  const today = new Date().toISOString().split('T')[0];

  // 更新版本号和日期
  const updatedContent = newContent
    .replace(/\*\*版本\*\*:\s*v\d+/i, `**版本**: v${newVersion}`)
    .replace(/\*\*更新\*\*:\s*\d{4}-\d{2}-\d{2}/, `**更新**: ${today}`);

  // 写入新内容
  fs.writeFileSync(focusPath, updatedContent, 'utf-8');

  // 清理过期历史
  const historyDir = getHistoryDir(focusPath);
  const beforeCount = fs.existsSync(historyDir)
    ? fs.readdirSync(historyDir).filter(f => f.startsWith('CURRENT_FOCUS.v')).length
    : 0;

  cleanupHistory(focusPath);

  const afterCount = fs.existsSync(historyDir)
    ? fs.readdirSync(historyDir).filter(f => f.startsWith('CURRENT_FOCUS.v')).length
    : 0;

  return {
    backupPath,
    cleanedCount: beforeCount - afterCount
  };
}

/**
 * 智能摘要提取
 *
 * 优先提取关键章节，确保不丢失重要信息
 * 对于非结构化内容，回退到简单的行截取
 *
 * @param content CURRENT_FOCUS.md 内容
 * @param maxLines 最大行数
 */
export function extractSummary(content: string, maxLines: number = 30): string {
  const lines = content.split('\n');
  const sections: { [key: string]: string[] } = {
    header: [],      // 标题和元数据
    snapshot: [],    // 状态快照
    current: [],     // 当前任务
    nextSteps: [],   // 下一步
    reference: []    // 参考
  };

  let currentSection = 'header';
  let hasStructuredSections = false;

  for (const line of lines) {
    // 识别章节
    if (line.startsWith('## 📍 状态快照') || line.startsWith('## 📍')) {
      currentSection = 'snapshot';
      hasStructuredSections = true;
    } else if (line.startsWith('## 🔄 当前任务') || line.startsWith('## 🔄')) {
      currentSection = 'current';
      hasStructuredSections = true;
    } else if (line.startsWith('## ➡️ 下一步') || line.startsWith('## ➡️')) {
      currentSection = 'nextSteps';
      hasStructuredSections = true;
    } else if (line.startsWith('## 📎 参考') || line.startsWith('## 📎')) {
      currentSection = 'reference';
      hasStructuredSections = true;
    } else if (line.startsWith('---')) {
      continue; // 跳过分隔线
    } else if (line.startsWith('<!--')) {
      continue; // 跳过注释
    }

    sections[currentSection].push(line);
  }

  // 如果没有结构化章节，回退到简单的行截取
  if (!hasStructuredSections) {
    const result = lines.slice(0, maxLines);
    if (lines.length > maxLines) {
      result.push('');
      result.push('...[truncated, see CURRENT_FOCUS.md for full context]');
    }
    return result.join('\n');
  }

  // 按优先级拼接
  const result: string[] = [
    ...sections.header.slice(0, 5),      // 标题 + 元数据
    '',
    '---',
    '',
    ...sections.snapshot.slice(0, 10),   // 状态快照
    '',
    ...sections.nextSteps.slice(0, 10),  // 下一步（优先级高）
    '',
    ...sections.current.slice(0, 15),    // 当前任务
  ];

  // 限制总行数
  const trimmed = result.slice(0, maxLines);
  if (result.length > maxLines) {
    trimmed.push('');
    trimmed.push('...[truncated, see CURRENT_FOCUS.md for full context]');
  }

  return trimmed.join('\n');
}
