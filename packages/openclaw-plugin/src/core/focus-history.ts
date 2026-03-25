/**
 * CURRENT_FOCUS 历史版本管理
 *
 * 功能：
 * - 压缩时备份当前版本到历史目录
 * - 清理过期历史版本
 * - 读取历史版本（用于 full 模式）
 * - 工作记忆提取与合并（压缩后恢复上下文）
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// 工作记忆数据结构
// ============================================================================

/**
 * 文件输出记录
 */
export interface FileArtifact {
  path: string;           // 完整文件路径
  action: 'created' | 'modified' | 'deleted';
  description: string;    // 简短描述
}

/**
 * 工作记忆快照
 */
export interface WorkingMemorySnapshot {
  lastUpdated: string;
  
  // 文件输出记录（核心）
  artifacts: FileArtifact[];
  
  // 当前任务
  currentTask?: {
    description: string;
    status: 'in_progress' | 'blocked' | 'reviewing' | 'completed';
    progress: number;
  };
  
  // 活动问题
  activeProblems: Array<{
    problem: string;
    approach?: string;
  }>;
  
  // 下一步行动
  nextActions: string[];
}

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
 * 支持整数和小数版本（如 v1, v1.1, v1.2）
 */
export function extractVersion(content: string): string {
  const match = content.match(/\*\*版本\*\*:\s*v([\d.]+)/i);
  return match ? match[1] : '1';
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
    // 使用时间戳作为唯一标识，避免同名冲突
    const timestamp = Date.now();
    const backupName = `CURRENT_FOCUS.v${version}.${date}.${timestamp}.md`;
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

  // 递增版本号（支持小数版本）
  const oldVersion = extractVersion(oldContent);
  // 解析版本号并递增
  const versionParts = oldVersion.split('.');
  const majorVersion = parseInt(versionParts[0], 10) || 1;
  const newVersion = `${majorVersion + 1}`;
  const today = new Date().toISOString().split('T')[0];

  // 更新版本号和日期
  const updatedContent = newContent
    .replace(/\*\*版本\*\*:\s*v[\d.]+/i, `**版本**: v${newVersion}`)
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
    // 识别章节（使用更宽松的匹配，支持不同格式）
    const trimmedLine = line.trim();
    
    // 使用正则匹配，支持 h1-h3 和多种格式
    if (/^#{1,3}\s*.*状态快照|📍/.test(trimmedLine)) {
      currentSection = 'snapshot';
      hasStructuredSections = true;
    } else if (/^#{1,3}\s*.*当前任务|🔄/.test(trimmedLine)) {
      currentSection = 'current';
      hasStructuredSections = true;
    } else if (/^#{1,3}\s*.*下一步|➡️/.test(trimmedLine)) {
      currentSection = 'nextSteps';
      hasStructuredSections = true;
    } else if (/^#{1,3}\s*.*参考|📎/.test(trimmedLine)) {
      currentSection = 'reference';
      hasStructuredSections = true;
    } else if (trimmedLine === '---') {
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

// ============================================================================
// 工作记忆管理
// ============================================================================

/** Working Memory 章节标记 */
const WORKING_MEMORY_SECTION = '## 🧠 Working Memory';

/** 最大保留的文件记录数 */
const MAX_ARTIFACTS = 20;

/** 最大保留的问题数 */
const MAX_PROBLEMS = 5;

/** 最大保留下一步行动数 */
const MAX_NEXT_ACTIONS = 5;

/**
 * 从会话消息中提取工作记忆
 * 
 * @param messages 会话消息数组（OpenClaw 格式）
 * @param workspaceDir 工作区目录（用于生成相对路径）
 * @returns 提取的工作记忆快照
 */
export function extractWorkingMemory(
  messages: Array<{ role?: string; content?: string | unknown[] }>,
  workspaceDir?: string
): WorkingMemorySnapshot {
  const snapshot: WorkingMemorySnapshot = {
    lastUpdated: new Date().toISOString(),
    artifacts: [],
    activeProblems: [],
    nextActions: []
  };

  // 只处理最近的 assistant 消息
  const recentMessages = messages
    .filter(m => m.role === 'assistant')
    .slice(-10);

  for (const msg of recentMessages) {
    let text = '';
    const toolUses: Array<{ name: string; input: Record<string, unknown> }> = [];
    
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts: string[] = [];
      
      for (const c of msg.content) {
        if (!c || typeof c !== 'object') continue;
        const obj = c as Record<string, unknown>;
        
        // 提取文本内容
        if (obj.type === 'text' && typeof obj.text === 'string') {
          textParts.push(obj.text);
        }
        
        // 提取工具调用（关键：文件操作在这里！）
        if (obj.type === 'tool_use' && typeof obj.name === 'string' && typeof obj.input === 'object') {
          toolUses.push({
            name: obj.name,
            input: obj.input as Record<string, unknown>
          });
        }
      }
      
      text = textParts.join('\n');
    }

    // 从工具调用中提取文件路径（这是最可靠的方式）
    for (const toolUse of toolUses) {
      if (['write_file', 'replace', 'create_file'].includes(toolUse.name)) {
        const filePath = toolUse.input.file_path || toolUse.input.absolute_path || toolUse.input.path;
        if (typeof filePath === 'string' && filePath.trim()) {
          // 跳过不需要的文件
          if (filePath.includes('node_modules') || 
              filePath.endsWith('.d.ts') ||
              filePath.includes('.config.')) {
            continue;
          }
          
          // 生成相对路径
          const displayPath = workspaceDir && filePath.startsWith(workspaceDir)
            ? path.relative(workspaceDir, filePath)
            : filePath;
          
          // 判断操作类型
          const action: 'created' | 'modified' | 'deleted' = 
            toolUse.name === 'write_file' || toolUse.name === 'create_file' ? 'created' : 'modified';
          
          // 尝试从文本中提取描述
          const description = extractDescription(text, filePath);
          
          snapshot.artifacts.push({
            path: displayPath,
            action,
            description
          });
        }
      }
    }

    if (!text) continue;

    // 从文本中提取文件操作（备用方式）
    extractFileArtifacts(text, snapshot.artifacts, workspaceDir);

    // 提取问题
    extractProblems(text, snapshot.activeProblems);

    // 提取下一步
    extractNextActions(text, snapshot.nextActions);
  }

  // 去重和限制数量
  snapshot.artifacts = deduplicateArtifacts(snapshot.artifacts).slice(-MAX_ARTIFACTS);
  snapshot.activeProblems = snapshot.activeProblems.slice(-MAX_PROBLEMS);
  snapshot.nextActions = snapshot.nextActions.slice(-MAX_NEXT_ACTIONS);

  return snapshot;
}

/**
 * 从文本中提取文件操作记录
 */
function extractFileArtifacts(
  text: string, 
  artifacts: FileArtifact[],
  workspaceDir?: string
): void {
  // 匹配 write_file, replace 工具调用
  // 格式: file_path: "/path/to/file" 或 absolute_path: "/path/to/file"
  const filePathRegex = /(?:file_path|absolute_path)["']?\s*[:=]\s*["']([^"']+\.(ts|js|json|md|yaml|yml|py|sh|mjs|cjs))["']/gi;
  
  let match;
  while ((match = filePathRegex.exec(text)) !== null) {
    const filePath = match[1];
    
    // 跳过 node_modules 和配置文件
    if (filePath.includes('node_modules') || 
        filePath.endsWith('.d.ts') ||
        filePath.includes('.config.')) {
      continue;
    }
    
    // 生成相对路径（如果有 workspaceDir）
    const displayPath = workspaceDir && filePath.startsWith(workspaceDir)
      ? path.relative(workspaceDir, filePath)
      : filePath;

    // 判断操作类型 - 根据上下文关键词
    let action: 'created' | 'modified' | 'deleted' = 'modified';
    const contextBefore = text.substring(Math.max(0, match.index - 200), match.index);
    if (contextBefore.toLowerCase().includes('created') || 
        contextBefore.includes('新建') ||
        contextBefore.includes('创建')) {
      action = 'created';
    } else if (contextBefore.toLowerCase().includes('deleted') ||
               contextBefore.includes('删除')) {
      action = 'deleted';
    }

    // 尝试提取描述（从附近的文本）
    const description = extractDescription(text, filePath);

    artifacts.push({
      path: displayPath,
      action,
      description
    });
  }

  // 匹配更通用的文件路径格式（如代码块中的路径）
  // 格式: `path/to/file.ts` 或 "path/to/file.ts"
  // 只匹配明确的代码相关路径
  const genericPathRegex = /[`"']([a-zA-Z0-9_\-\/]+\.(ts|js|mjs|cjs|py))[`"']/g;
  
  while ((match = genericPathRegex.exec(text)) !== null) {
    const filePath = match[1];
    
    // 跳过太短、node_modules、配置文件
    if (filePath.length < 10 || 
        filePath.includes('node_modules') ||
        filePath.includes('.config.') ||
        filePath.endsWith('.d.ts') ||
        filePath.endsWith('.test.ts') ||
        filePath.endsWith('.spec.ts')) {
      continue;
    }
    
    // 检查是否已经存在（避免重复）
    if (artifacts.some(a => a.path === filePath || a.path.endsWith(filePath) || filePath.endsWith(a.path))) {
      continue;
    }

    const description = extractDescription(text, filePath);
    
    artifacts.push({
      path: filePath,
      action: 'modified',
      description
    });
  }
}

/**
 * 尝试从文本中提取文件描述
 */
function extractDescription(text: string, filePath: string): string {
  // 在文件路径附近查找描述性文字
  const pathIndex = text.indexOf(filePath);
  if (pathIndex === -1) return '';

  // 向前查找 100 个字符
  const before = text.substring(Math.max(0, pathIndex - 100), pathIndex);
  
  // 匹配描述模式
  const descPatterns = [
    /(?:description|说明|描述|功能|purpose)[:：]\s*([^\n]{5,50})/i,
    /\/\/\s*(.{5,50})/,
    /\*\s*(.{5,50})\s*$/
  ];

  for (const pattern of descPatterns) {
    const match = before.match(pattern);
    if (match) {
      return match[1].trim().substring(0, 50);
    }
  }

  return '';
}

/**
 * 从文本中提取问题
 */
function extractProblems(
  text: string,
  problems: Array<{ problem: string; approach?: string }>
): void {
  // 问题模式（匹配问题描述）
  const problemPattern = /(?:问题|problem|error|错误|失败|failed)[:：]\s*([^\n]{5,100})/gi;
  let match;
  while ((match = problemPattern.exec(text)) !== null) {
    const content = match[1].trim();
    if (content.length > 5) {
      problems.push({
        problem: content,
        approach: undefined
      });
    }
  }

  // 解决方案模式（匹配问题和解决方案）
  const solutionPattern = /(?:解决|solution|方案|修复|fix)[:：]\s*([^\n]{5,100})/gi;
  while ((match = solutionPattern.exec(text)) !== null) {
    const content = match[1].trim();
    if (content.length > 5) {
      // 尝试关联到最近的问题
      const lastProblem = problems[problems.length - 1];
      if (lastProblem && !lastProblem.approach) {
        lastProblem.approach = content;
      } else {
        // 作为独立问题记录
        problems.push({
          problem: content,
          approach: content
        });
      }
    }
  }
}

/**
 * 从文本中提取下一步行动
 */
function extractNextActions(text: string, actions: string[]): void {
  // 匹配下一步模式
  const patterns = [
    /(?:下一步|next|接下来|todo|待办)[:：]?\s*\n?\s*[-\d]+\s*[.)]?\s*([^\n]{5,80})/gi,
    /[-\d]+\s*[.)]\s*([^\n]{5,80})/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const action = match[1].trim();
      if (action.length > 5 && !actions.includes(action)) {
        actions.push(action);
      }
    }
  }
}

/**
 * 去重文件记录
 */
function deduplicateArtifacts(artifacts: FileArtifact[]): FileArtifact[] {
  const seen = new Map<string, FileArtifact>();
  
  for (const artifact of artifacts) {
    const key = artifact.path;
    const existing = seen.get(key);
    
    if (!existing) {
      seen.set(key, artifact);
    } else {
      // 合并描述（保留更长的）
      if (artifact.description.length > existing.description.length) {
        existing.description = artifact.description;
      }
    }
  }
  
  return Array.from(seen.values());
}

/**
 * 解析 CURRENT_FOCUS.md 中的 Working Memory 章节
 */
export function parseWorkingMemorySection(content: string): WorkingMemorySnapshot | null {
  const wmIndex = content.indexOf(WORKING_MEMORY_SECTION);
  if (wmIndex === -1) return null;

  const wmContent = content.substring(wmIndex);
  
  const snapshot: WorkingMemorySnapshot = {
    lastUpdated: new Date().toISOString(),
    artifacts: [],
    activeProblems: [],
    nextActions: []
  };

  // 解析 last updated
  const updatedMatch = wmContent.match(/Last updated:\s*([^\n]+)/i);
  if (updatedMatch) {
    snapshot.lastUpdated = updatedMatch[1].trim();
  }

  // 解析文件记录表格
  // | 文件路径 | 操作 | 描述 |
  const tableRegex = /\|\s*`?([^`|\n]+)`?\s*\|\s*(created|modified|deleted)\s*\|\s*([^|\n]*)\s*\|/gi;
  let match;
  while ((match = tableRegex.exec(wmContent)) !== null) {
    snapshot.artifacts.push({
      path: match[1].trim(),
      action: match[2].toLowerCase() as 'created' | 'modified' | 'deleted',
      description: match[3].trim()
    });
  }

  // 解析问题列表
  const problemRegex = /[-*]\s*(.+?)\s*(?:→|->)\s*(.+)/g;
  while ((match = problemRegex.exec(wmContent)) !== null) {
    snapshot.activeProblems.push({
      problem: match[1].trim(),
      approach: match[2].trim()
    });
  }

  // 解析下一步行动
  const actionRegex = /^\s*[\d]+\.\s*(.+)$/gm;
  while ((match = actionRegex.exec(wmContent)) !== null) {
    snapshot.nextActions.push(match[1].trim());
  }

  return snapshot;
}

/**
 * 将工作记忆合并到 CURRENT_FOCUS.md 内容中
 * 
 * @param content 原始内容
 * @param snapshot 工作记忆快照
 * @returns 合并后的内容
 */
export function mergeWorkingMemory(content: string, snapshot: WorkingMemorySnapshot): string {
  const wmIndex = content.indexOf(WORKING_MEMORY_SECTION);
  
  // 生成 Working Memory 章节
  const wmSection = generateWorkingMemorySection(snapshot);
  
  if (wmIndex === -1) {
    // 没有 Working Memory 章节，追加到末尾
    return content.trimEnd() + '\n\n' + WORKING_MEMORY_SECTION + '\n' + wmSection;
  } else {
    // 替换现有的 Working Memory 章节
    const beforeWm = content.substring(0, wmIndex);
    // 查找下一个 ## 标题（如果有的话）
    const afterWm = content.substring(wmIndex);
    const nextSectionMatch = afterWm.substring(WORKING_MEMORY_SECTION.length).match(/\n##\s/);
    
    if (nextSectionMatch && nextSectionMatch.index !== undefined) {
      const nextSectionStart = WORKING_MEMORY_SECTION.length + nextSectionMatch.index;
      return beforeWm + WORKING_MEMORY_SECTION + '\n' + wmSection + '\n' + afterWm.substring(nextSectionStart);
    } else {
      return beforeWm + WORKING_MEMORY_SECTION + '\n' + wmSection;
    }
  }
}

/**
 * 生成 Working Memory 章节内容
 */
function generateWorkingMemorySection(snapshot: WorkingMemorySnapshot): string {
  const lines: string[] = [`> Last updated: ${snapshot.lastUpdated}`, ''];

  // 文件输出记录
  if (snapshot.artifacts.length > 0) {
    lines.push('### 📁 文件输出记录');
    lines.push('');
    lines.push('| 文件路径 | 操作 | 描述 |');
    lines.push('|----------|------|------|');
    for (const artifact of snapshot.artifacts) {
      lines.push(`| \`${artifact.path}\` | ${artifact.action} | ${artifact.description || '-'} |`);
    }
    lines.push('');
  }

  // 当前任务
  if (snapshot.currentTask) {
    lines.push('### 🎯 当前任务');
    lines.push(`- **描述**: ${snapshot.currentTask.description}`);
    lines.push(`- **状态**: ${snapshot.currentTask.status}`);
    lines.push(`- **进度**: ${snapshot.currentTask.progress}%`);
    lines.push('');
  }

  // 活动问题
  if (snapshot.activeProblems.length > 0) {
    lines.push('### ⚠️ 活动问题');
    for (const p of snapshot.activeProblems) {
      if (p.approach) {
        lines.push(`- ${p.problem} → ${p.approach}`);
      } else {
        lines.push(`- ${p.problem}`);
      }
    }
    lines.push('');
  }

  // 下一步行动
  if (snapshot.nextActions.length > 0) {
    lines.push('### ➡️ 下一步行动');
    for (let i = 0; i < snapshot.nextActions.length; i++) {
      lines.push(`${i + 1}. ${snapshot.nextActions[i]}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 生成工作记忆注入字符串（用于 prompt 注入）
 */
export function workingMemoryToInjection(snapshot: WorkingMemorySnapshot | null): string {
  if (!snapshot) return '';
  
  if (snapshot.artifacts.length === 0 && 
      snapshot.activeProblems.length === 0 && 
      snapshot.nextActions.length === 0) {
    return '';
  }

  const lines: string[] = ['<working_memory preserved="true">'];
  lines.push('以下是你压缩前的工作记忆，请继续完成未完成的任务：');
  lines.push('');

  if (snapshot.artifacts.length > 0) {
    lines.push('### 已输出的文件');
    for (const a of snapshot.artifacts.slice(-10)) {
      lines.push(`- [${a.action.toUpperCase()}] \`${a.path}\`${a.description ? ` - ${a.description}` : ''}`);
    }
    lines.push('');
  }

  if (snapshot.activeProblems.length > 0) {
    lines.push('### 活动问题');
    for (const p of snapshot.activeProblems) {
      if (p.approach) {
        lines.push(`- ${p.problem} → ${p.approach}`);
      } else {
        lines.push(`- ${p.problem}`);
      }
    }
    lines.push('');
  }

  if (snapshot.nextActions.length > 0) {
    lines.push('### 下一步行动');
    for (let i = 0; i < snapshot.nextActions.length; i++) {
      lines.push(`${i + 1}. ${snapshot.nextActions[i]}`);
    }
    lines.push('');
  }

  lines.push('</working_memory>');
  
  return lines.join('\n');
}

// ============================================================================
// 自动压缩与维护
// ============================================================================

/** 默认压缩配置 */
const DEFAULT_COMPRESSION_CONFIG = {
  lineThreshold: 100,
  sizeThreshold: 15 * 1024, // 15KB
  intervalMs: 24 * 60 * 60 * 1000, // 24 hours
  keepCompletedTasks: 3,
  maxWorkingMemoryArtifacts: 10,
};

/** 压缩时间记录文件名 */
const LAST_COMPRESS_FILE = '.last_compress';

/**
 * 压缩配置接口
 */
interface CompressionConfig {
  lineThreshold: number;
  sizeThreshold: number;
  intervalMs: number;
  keepCompletedTasks: number;
  maxWorkingMemoryArtifacts: number;
}

/**
 * 从 pain_settings.json 加载压缩配置
 *
 * @param stateDir state 目录路径
 * @returns 压缩配置
 */
function loadCompressionConfig(stateDir?: string): CompressionConfig {
  if (!stateDir) {
    return DEFAULT_COMPRESSION_CONFIG;
  }

  try {
    const configPath = path.join(stateDir, 'pain_settings.json');
    if (!fs.existsSync(configPath)) {
      return DEFAULT_COMPRESSION_CONFIG;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const compression = config?.compression || {};

    return {
      lineThreshold: compression.line_threshold || DEFAULT_COMPRESSION_CONFIG.lineThreshold,
      sizeThreshold: (compression.size_threshold_kb || 15) * 1024,
      intervalMs: (compression.interval_hours || 24) * 60 * 60 * 1000,
      keepCompletedTasks: compression.keep_completed_tasks || DEFAULT_COMPRESSION_CONFIG.keepCompletedTasks,
      maxWorkingMemoryArtifacts: compression.max_working_memory_artifacts || DEFAULT_COMPRESSION_CONFIG.maxWorkingMemoryArtifacts,
    };
  } catch {
    return DEFAULT_COMPRESSION_CONFIG;
  }
}

/**
 * 检查是否可以进行自动压缩（频率限制）
 *
 * @param stateDir state 目录路径
 * @returns 是否可以进行压缩
 */
function canAutoCompress(stateDir: string): boolean {
  const lastCompressPath = path.join(stateDir, LAST_COMPRESS_FILE);

  if (!fs.existsSync(lastCompressPath)) {
    return true;
  }

  try {
    const config = loadCompressionConfig(stateDir);
    const lastCompressTime = parseInt(fs.readFileSync(lastCompressPath, 'utf-8'), 10);
    const now = Date.now();
    return (now - lastCompressTime) >= config.intervalMs;
  } catch {
    return true;
  }
}

/**
 * 记录压缩时间
 *
 * @param stateDir state 目录路径
 */
function recordCompressTime(stateDir: string): void {
  try {
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    fs.writeFileSync(path.join(stateDir, LAST_COMPRESS_FILE), Date.now().toString(), 'utf-8');
  } catch (error) {
    logError('Failed to record compress time', error);
  }
}

/**
 * 提取已完成任务作为里程碑
 */
export function extractMilestones(content: string): {
  completedTasks: string[];
  fileArtifacts: string[];
} {
  const completedTasks: string[] = [];
  const fileArtifacts: string[] = [];
  const lines = content.split('\n');

  let inTaskSection = false;
  let inWorkingMemory = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 识别章节
    if (/^#{1,3}\s*.*当前任务|🔄/.test(trimmed)) {
      inTaskSection = true;
      inWorkingMemory = false;
    } else if (/^#{1,3}\s*.*下一步|➡️/.test(trimmed)) {
      inTaskSection = false;
      inWorkingMemory = false;
    } else if (/^##\s*🧠\s*Working Memory/.test(trimmed)) {
      inWorkingMemory = true;
      inTaskSection = false;
    }

    // 提取已完成任务
    if (inTaskSection && /^-\s*\[x\]/i.test(trimmed)) {
      completedTasks.push(trimmed.replace(/^-\s*\[x\]\s*/i, ''));
    }

    // 提取文件引用（从工作记忆）
    if (inWorkingMemory) {
      const fileMatch = trimmed.match(/^\|\s*`?([^`|\n]+)`?\s*\|/);
      if (fileMatch && !fileMatch[1].includes('文件路径')) {
        fileArtifacts.push(fileMatch[1].trim());
      }
    }
  }

  return {
    completedTasks: completedTasks.slice(-10), // 最多 10 个
    fileArtifacts: fileArtifacts.slice(-10)
  };
}

/**
 * 归档里程碑到 daily memory 文件
 */
export function archiveMilestonesToDaily(
  workspaceDir: string,
  milestones: { completedTasks: string[]; fileArtifacts: string[] },
  version: string
): string | null {
  if (milestones.completedTasks.length === 0 && milestones.fileArtifacts.length === 0) {
    return null;
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const memoryDir = path.join(workspaceDir, 'memory');
  const dailyLogPath = path.join(memoryDir, `${dateStr}.md`);
  const timestamp = new Date().toISOString();

  // 确保目录存在
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }

  // 构建里程碑内容
  const lines: string[] = [];
  lines.push(`\n## 🏆 里程碑 [CURRENT_FOCUS v${version} 压缩]`);
  lines.push(`> 时间: ${timestamp}`);
  lines.push('');

  if (milestones.completedTasks.length > 0) {
    lines.push('### 已完成任务');
    for (const task of milestones.completedTasks) {
      lines.push(`- [x] ${task}`);
    }
    lines.push('');
  }

  if (milestones.fileArtifacts.length > 0) {
    lines.push('### 相关文件');
    for (const file of milestones.fileArtifacts) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // 追加到 daily log
  try {
    fs.appendFileSync(dailyLogPath, lines.join('\n'), 'utf-8');
    return dailyLogPath;
  } catch (error) {
    logError(`Failed to archive milestones to ${dailyLogPath}`, error);
    return null;
  }
}

/**
 * 清理过期信息和验证文件引用
 */
export function cleanupStaleInfo(
  content: string,
  workspaceDir?: string,
  config?: CompressionConfig
): string {
  const effectiveConfig = config || DEFAULT_COMPRESSION_CONFIG;
  const lines = content.split('\n');
  const result: string[] = [];

  let inWorkingMemory = false;
  let inFileTable = false;
  let completedCount = 0;
  let artifactCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 检测 Working Memory 章节
    if (/^##\s*🧠\s*Working Memory/.test(trimmed)) {
      inWorkingMemory = true;
      inFileTable = false;
    } else if (/^##\s/.test(trimmed) && !trimmed.includes('Working Memory')) {
      inWorkingMemory = false;
      inFileTable = false;
    }

    // 检测文件表格
    if (inWorkingMemory && /^\|\s*文件路径/.test(trimmed)) {
      inFileTable = true;
      result.push(line);
      continue;
    }

    if (inFileTable && /^\|[^|]+\|[^|]+\|[^|]+\|/.test(trimmed)) {
      // 检查是否是表格分隔行
      if (/^\|[-\s|:]+\|$/.test(trimmed)) {
        result.push(line);
        continue;
      }

      // 提取文件路径
      const match = trimmed.match(/^\|\s*`?([^`|\n]+)`?\s*\|/);
      if (match) {
        const filePath = match[1].trim();
        artifactCount++;

        // 限制条数
        if (artifactCount > effectiveConfig.maxWorkingMemoryArtifacts) {
          continue; // 跳过超出限制的条目
        }

        // 可选：验证文件是否存在
        if (workspaceDir) {
          const fullPath = path.join(workspaceDir, filePath);
          if (!fs.existsSync(fullPath)) {
            continue; // 文件不存在，跳过
          }
        }

        result.push(line);
        continue;
      }
    }

    // 处理已完成任务
    if (/^-\s*\[x\]/i.test(trimmed)) {
      completedCount++;
      if (completedCount > effectiveConfig.keepCompletedTasks) {
        continue; // 跳过超出限制的已完成任务
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

/**
 * 自动压缩 CURRENT_FOCUS.md
 *
 * @param focusPath CURRENT_FOCUS.md 的完整路径
 * @param workspaceDir 工作区目录（可选，用于验证文件引用）
 * @param stateDir state 目录路径（可选，用于频率限制）
 * @returns 压缩结果信息，如果不需要压缩则返回 null
 */
export function autoCompressFocus(
  focusPath: string,
  workspaceDir?: string,
  stateDir?: string
): {
  compressed: boolean;
  oldLines: number;
  newLines: number;
  milestonesArchived: boolean;
  backupPath: string | null;
  reason: string;
} {
  // 检查文件是否存在
  if (!fs.existsSync(focusPath)) {
    return {
      compressed: false,
      oldLines: 0,
      newLines: 0,
      milestonesArchived: false,
      backupPath: null,
      reason: 'File not found'
    };
  }

  // 加载配置
  const config = loadCompressionConfig(stateDir);

  const oldContent = fs.readFileSync(focusPath, 'utf-8');
  const oldLines = oldContent.split('\n').length;
  const oldSize = Buffer.byteLength(oldContent, 'utf-8');

  // 检查是否需要压缩（行数或大小阈值）
  const needsCompression = 
    oldLines > config.lineThreshold || 
    oldSize > config.sizeThreshold;

  if (!needsCompression) {
    return {
      compressed: false,
      oldLines,
      newLines: oldLines,
      milestonesArchived: false,
      backupPath: null,
      reason: 'Below threshold'
    };
  }

  // 检查频率限制
  if (stateDir && !canAutoCompress(stateDir)) {
    return {
      compressed: false,
      oldLines,
      newLines: oldLines,
      milestonesArchived: false,
      backupPath: null,
      reason: 'Rate limited (24h interval)'
    };
  }

  // 1. 提取里程碑
  const version = extractVersion(oldContent);
  const milestones = extractMilestones(oldContent);

  // 2. 归档里程碑到 daily memory
  let milestonesArchived = false;
  if (workspaceDir) {
    const archivePath = archiveMilestonesToDaily(workspaceDir, milestones, version);
    milestonesArchived = archivePath !== null;
  }

  // 3. 清理过期信息（传入配置）
  let newContent = cleanupStaleInfo(oldContent, workspaceDir, config);

  // 4. 压缩内容（使用 extractSummary）
  newContent = extractSummary(newContent, 50);

  // 5. 递增版本号和日期
  const newVersion = `${parseInt(version, 10) + 1}`;
  const today = new Date().toISOString().split('T')[0];
  newContent = newContent
    .replace(/\*\*版本\*\*:\s*v[\d.]+/i, `**版本**: v${newVersion}`)
    .replace(/\*\*更新\*\*:\s*\d{4}-\d{2}-\d{2}/, `**更新**: ${today}`);

  // 6. 备份原版本
  const backupPath = backupToHistory(focusPath, oldContent);

  // 7. 清理过期历史
  cleanupHistory(focusPath);

  // 8. 写入新内容
  fs.writeFileSync(focusPath, newContent, 'utf-8');

  // 9. 记录压缩时间
  if (stateDir) {
    recordCompressTime(stateDir);
  }

  const newLines = newContent.split('\n').length;

  return {
    compressed: true,
    oldLines,
    newLines,
    milestonesArchived,
    backupPath,
    reason: `Auto-compressed: ${oldLines} → ${newLines} lines`
  };
}

/**
 * 检查是否需要自动压缩
 */
export function needsAutoCompression(focusPath: string, stateDir?: string): boolean {
  if (!fs.existsSync(focusPath)) {
    return false;
  }

  try {
    const config = stateDir ? loadCompressionConfig(stateDir) : DEFAULT_COMPRESSION_CONFIG;
    const content = fs.readFileSync(focusPath, 'utf-8');
    const lines = content.split('\n').length;
    const size = Buffer.byteLength(content, 'utf-8');

    return lines > config.lineThreshold || size > config.sizeThreshold;
  } catch {
    return false;
  }
}

// ============================================================================
// 格式验证与模板恢复
// ============================================================================

/** CURRENT_FOCUS 模板路径（相对于插件根目录） */
const CURRENT_FOCUS_TEMPLATE_PATH = 'templates/workspace/okr/CURRENT_FOCUS.md';

/**
 * 验证 CURRENT_FOCUS.md 格式
 *
 * @param content 文件内容
 * @returns 验证结果
 */
export function validateCurrentFocus(content: string): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 检查必要字段
  if (!content.includes('**版本**') && !content.includes('**版本**:')) {
    errors.push('缺少版本字段: **版本**: vX');
  }

  if (!content.includes('**更新**') && !content.includes('**更新**:')) {
    errors.push('缺少更新日期字段: **更新**: YYYY-MM-DD');
  }

  // 检查必要章节
  if (!content.includes('📍 状态快照') && !content.includes('状态快照')) {
    warnings.push('缺少状态快照章节');
  }

  if (!content.includes('🔄 当前任务') && !content.includes('当前任务')) {
    warnings.push('缺少当前任务章节');
  }

  if (!content.includes('➡️ 下一步') && !content.includes('下一步')) {
    warnings.push('缺少下一步章节');
  }

  // 检查版本号格式
  const versionMatch = content.match(/\*\*版本\*\*:\s*v([\d.]+)/i);
  if (versionMatch) {
    const version = parseFloat(versionMatch[1]);
    if (isNaN(version) || version < 1) {
      errors.push(`版本号格式无效: ${versionMatch[1]}`);
    }
  }

  // 检查日期格式
  const dateMatch = content.match(/\*\*更新\*\*:\s*(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    const date = new Date(dateMatch[1]);
    if (isNaN(date.getTime())) {
      errors.push(`日期格式无效: ${dateMatch[1]}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * 从模板恢复 CURRENT_FOCUS.md
 *
 * @param focusPath CURRENT_FOCUS.md 路径
 * @param extensionRoot 插件根目录
 * @returns 恢复是否成功
 */
export function recoverFromTemplate(
  focusPath: string,
  extensionRoot: string
): {
  success: boolean;
  error?: string;
  templatePath?: string;
} {
  try {
    // 查找模板文件
    const templatePath = path.join(extensionRoot, CURRENT_FOCUS_TEMPLATE_PATH);

    if (!fs.existsSync(templatePath)) {
      return {
        success: false,
        error: `Template not found: ${templatePath}`
      };
    }

    // 读取模板
    let template = fs.readFileSync(templatePath, 'utf-8');

    // 替换日期占位符
    const today = new Date().toISOString().split('T')[0];
    template = template.replace(/{YYYY-MM-DD}/g, today);

    // 备份损坏的文件（如果存在）
    if (fs.existsSync(focusPath)) {
      const backupPath = `${focusPath}.corrupted.${Date.now()}.md`;
      fs.copyFileSync(focusPath, backupPath);
    }

    // 确保目录存在
    const focusDir = path.dirname(focusPath);
    if (!fs.existsSync(focusDir)) {
      fs.mkdirSync(focusDir, { recursive: true });
    }

    // 写入恢复的内容
    fs.writeFileSync(focusPath, template, 'utf-8');

    return {
      success: true,
      templatePath
    };
  } catch (error) {
    return {
      success: false,
      error: String(error)
    };
  }
}

/**
 * 安全读取 CURRENT_FOCUS.md（自动验证 + 恢复）
 *
 * @param focusPath CURRENT_FOCUS.md 路径
 * @param extensionRoot 插件根目录
 * @param logger 日志记录器
 * @returns 文件内容和恢复状态
 */
export function safeReadCurrentFocus(
  focusPath: string,
  extensionRoot: string,
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void }
): {
  content: string;
  recovered: boolean;
  validationErrors: string[];
} {
  // 文件不存在，从模板创建
  if (!fs.existsSync(focusPath)) {
    const result = recoverFromTemplate(focusPath, extensionRoot);
    if (result.success) {
      logger?.info?.(`[PD:Focus] Created CURRENT_FOCUS.md from template`);
      return {
        content: fs.readFileSync(focusPath, 'utf-8'),
        recovered: true,
        validationErrors: []
      };
    }
    return {
      content: '',
      recovered: false,
      validationErrors: [`Failed to create from template: ${result.error}`]
    };
  }

  // 读取并验证
  const content = fs.readFileSync(focusPath, 'utf-8');
  const validation = validateCurrentFocus(content);

  if (validation.valid) {
    return {
      content,
      recovered: false,
      validationErrors: []
    };
  }

  // 验证失败，尝试恢复
  logger?.warn?.(`[PD:Focus] CURRENT_FOCUS.md validation failed: ${validation.errors.join(', ')}`);

  const result = recoverFromTemplate(focusPath, extensionRoot);
  if (result.success) {
    logger?.info?.(`[PD:Focus] Recovered CURRENT_FOCUS.md from template`);
    return {
      content: fs.readFileSync(focusPath, 'utf-8'),
      recovered: true,
      validationErrors: validation.errors
    };
  }

  // 恢复失败，返回原始内容（让系统继续运行）
  logger?.warn?.(`[PD:Focus] Failed to recover: ${result.error}`);
  return {
    content,
    recovered: false,
    validationErrors: validation.errors
  };
}
