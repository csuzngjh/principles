import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils/io.js';
import {
  extractVersion,
  extractDate,
  validateCurrentFocus,
  compressFocusContent,
  cleanupStaleInfoPure,
  extractDescription,
  extractProblems,
  extractNextActions,
  deduplicateArtifacts,
} from '@principles/core/prompt-builder';
import type {
  FileArtifact,
  WorkingMemorySnapshot,
} from '@principles/core/prompt-builder';

export {
  extractVersion,
  extractDate,
  extractSummary,
  parseWorkingMemorySection,
  workingMemoryToInjection,
  extractMilestones,
  validateCurrentFocus,
  mergeWorkingMemory,
  compressFocusContent,
} from '@principles/core/prompt-builder';

export type {
  FileArtifact,
  WorkingMemorySnapshot,
} from '@principles/core/prompt-builder';

function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errorStr = error instanceof Error ? error.message : String(error);
  console.error(`[focus-history] ${timestamp} ERROR: ${message}${errorStr ? ' - ' + errorStr : ''}`);
}

const MAX_HISTORY_FILES = 10;
const FULL_MODE_HISTORY_COUNT = 3;
const MAX_ARTIFACTS = 20;
const MAX_PROBLEMS = 5;
const MAX_NEXT_ACTIONS = 5;
const LAST_COMPRESS_FILE = '.last_compress';
const CURRENT_FOCUS_TEMPLATE_PATH = 'templates/workspace/okr/CURRENT_FOCUS.md';

const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  lineThreshold: 100,
  sizeThreshold: 15 * 1024,
  intervalMs: 24 * 60 * 60 * 1000,
  keepCompletedTasks: 3,
  maxWorkingMemoryArtifacts: 10,
};

interface CompressionConfig {
  lineThreshold: number;
  sizeThreshold: number;
  intervalMs: number;
  keepCompletedTasks: number;
  maxWorkingMemoryArtifacts: number;
}

export function getHistoryDir(focusPath: string): string {
  return path.join(path.dirname(focusPath), '.history');
}

export function backupToHistory(focusPath: string, content: string): string | null {
  try {
    const historyDir = getHistoryDir(focusPath);

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
    const timestamp = Date.now();
    const backupName = `CURRENT_FOCUS.v${version}.${date}.${timestamp}.md`;
    const backupPath = path.join(historyDir, backupName);

    if (fs.existsSync(backupPath)) {
      return null;
    }

    try {
      atomicWriteFileSync(backupPath, content);
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

export function cleanupHistory(focusPath: string, maxFiles: number = MAX_HISTORY_FILES): void {
  try {
    const historyDir = getHistoryDir(focusPath);

    if (!fs.existsSync(historyDir)) {
      return;
    }

    const files = fs.readdirSync(historyDir)
      .filter(f => f.startsWith('CURRENT_FOCUS.v') && f.endsWith('.md'))
      .map(f => ({
        name: f,
        path: path.join(historyDir, f),
        mtime: fs.statSync(path.join(historyDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime);

    const toDelete = files.slice(maxFiles);
    for (const file of toDelete) {
      try {
        fs.unlinkSync(file.path);
      } catch (error) {
        logError(`Failed to delete history file: ${file.path}`, error);
      }
    }
  } catch (error) {
    logError('Unexpected error in cleanupHistory', error);
  }
}

export async function getHistoryVersions(focusPath: string, count: number = FULL_MODE_HISTORY_COUNT): Promise<string[]> {
  const historyDir = getHistoryDir(focusPath);

  let allFiles: string[];
  try {
    allFiles = await fs.promises.readdir(historyDir);
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const historyFiles = allFiles.filter(f => f.startsWith('CURRENT_FOCUS.v') && f.endsWith('.md'));

  const statResults = await Promise.allSettled(
    historyFiles.map(async f => {
      const filePath = path.join(historyDir, f);
      const stat = await fs.promises.stat(filePath);
      return {
        path: filePath,
        mtime: stat.mtime.getTime()
      };
    })
  );

  const filesWithStat = statResults
    .filter((r): r is PromiseFulfilledResult<{path: string, mtime: number}> => r.status === 'fulfilled')
    .map(r => r.value);

  const selectedFiles = filesWithStat
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, count);

  const readResults = await Promise.allSettled(
    selectedFiles.map(f => fs.promises.readFile(f.path, 'utf-8'))
  );

  return readResults
    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
    .map(r => r.value);
}

export function compressFocus(focusPath: string, newContent: string): {
  backupPath: string | null;
  cleanedCount: number;
} {
  let oldContent = '';
  if (fs.existsSync(focusPath)) {
    oldContent = fs.readFileSync(focusPath, 'utf-8');
  }

  const backupPath = oldContent ? backupToHistory(focusPath, oldContent) : null;

  const oldVersion = extractVersion(oldContent);
  const versionParts = oldVersion.split('.');
  const majorVersion = parseInt(versionParts[0]!, 10) || 1;
  const newVersion = `${majorVersion + 1}`;
  const [today] = new Date().toISOString().split('T');

  const updatedContent = newContent
    .replace(/\*\*版本\*\*:\s*v[\d.]+/i, `**版本**: v${newVersion}`)
    .replace(/\*\*更新\*\*:\s*\d{4}-\d{2}-\d{2}/, `**更新**: ${today}`);

  atomicWriteFileSync(focusPath, updatedContent);

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

export function extractWorkingMemory(
  messages: { role?: string; content?: string | unknown[] }[],
  workspaceDir?: string
): WorkingMemorySnapshot {
  const snapshot: WorkingMemorySnapshot = {
    lastUpdated: new Date().toISOString(),
    artifacts: [],
    activeProblems: [],
    nextActions: []
  };

  const recentMessages = messages
    .filter(m => m.role === 'assistant')
    .slice(-10);

  for (const msg of recentMessages) {
    let text = '';
    const toolUses: { name: string; input: Record<string, unknown> }[] = [];

    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts: string[] = [];

      for (const c of msg.content) {
        if (!c || typeof c !== 'object') continue;
        const obj = c as Record<string, unknown>;

        if (obj.type === 'text' && typeof obj.text === 'string') {
          textParts.push(obj.text);
        }

        if (obj.type === 'tool_use' && typeof obj.name === 'string' && typeof obj.input === 'object') {
          toolUses.push({
            name: obj.name,
            input: obj.input as Record<string, unknown>
          });
        }
      }

      text = textParts.join('\n');
    }

    for (const toolUse of toolUses) {
      if (['write_file', 'replace', 'create_file'].includes(toolUse.name)) {
        const filePath = toolUse.input.file_path || toolUse.input.absolute_path || toolUse.input.path;
        if (typeof filePath === 'string' && filePath.trim()) {
          if (filePath.includes('node_modules') ||
              filePath.endsWith('.d.ts') ||
              filePath.includes('.config.')) {
            continue;
          }

          const displayPath = workspaceDir && filePath.startsWith(workspaceDir)
            ? path.relative(workspaceDir, filePath)
            : filePath;

          const action: 'created' | 'modified' | 'deleted' =
            toolUse.name === 'write_file' || toolUse.name === 'create_file' ? 'created' : 'modified';

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

    extractFileArtifacts(text, snapshot.artifacts, workspaceDir);
    extractProblems(text, snapshot.activeProblems);
    extractNextActions(text, snapshot.nextActions);
  }

  snapshot.artifacts = deduplicateArtifacts(snapshot.artifacts).slice(-MAX_ARTIFACTS);
  snapshot.activeProblems = snapshot.activeProblems.slice(-MAX_PROBLEMS);
  snapshot.nextActions = snapshot.nextActions.slice(-MAX_NEXT_ACTIONS);

  return snapshot;
}

function extractFileArtifacts(
  text: string,
  artifacts: FileArtifact[],
  workspaceDir?: string
): void {
  const filePathRegex = /(?:file_path|absolute_path)["']?\s*[:=]\s*["']([^"']+\.(ts|js|json|md|yaml|yml|py|sh|mjs|cjs))["']/gi;

  let match;
  while ((match = filePathRegex.exec(text)) !== null) {
    const [, filePath] = match;

    if (filePath!.includes('node_modules') ||
        filePath!.endsWith('.d.ts') ||
        filePath!.includes('.config.')) {
      continue;
    }

    const displayPath = workspaceDir && filePath!.startsWith(workspaceDir)
      ? path.relative(workspaceDir, filePath!)
      : filePath!;

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

    const description = extractDescription(text, filePath!);

    artifacts.push({
      path: displayPath,
      action,
      description
    });
  }

  const genericPathRegex = /[`"']([a-zA-Z0-9_./]+\.(ts|js|mjs|cjs|py))[`"']/g;

  while ((match = genericPathRegex.exec(text)) !== null) {
    const [, filePath] = match;

    if (filePath!.length < 10 ||
        filePath!.includes('node_modules') ||
        filePath!.includes('.config.') ||
        filePath!.endsWith('.d.ts') ||
        filePath!.endsWith('.test.ts') ||
        filePath!.endsWith('.spec.ts')) {
      continue;
    }

    if (artifacts.some(a => a.path === filePath || a.path.endsWith(filePath!) || filePath!.endsWith(a.path))) {
      continue;
    }

    const description = extractDescription(text, filePath!);

    artifacts.push({
      path: filePath!,
      action: 'modified',
      description
    });
  }
}

export function cleanupStaleInfo(
  content: string,
  workspaceDir?: string,
  config?: CompressionConfig
): string {
  const effectiveConfig = config || DEFAULT_COMPRESSION_CONFIG;
  const coreOptions = {
    lineThreshold: effectiveConfig.lineThreshold,
    sizeThreshold: effectiveConfig.sizeThreshold,
    keepCompletedTasks: effectiveConfig.keepCompletedTasks,
    maxWorkingMemoryArtifacts: workspaceDir ? Infinity : effectiveConfig.maxWorkingMemoryArtifacts,
  };
  let result = cleanupStaleInfoPure(content, coreOptions);

  if (workspaceDir) {
    const lines = result.split('\n');
    const filtered: string[] = [];
    let inFileTable = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (/^\|\s*文件路径/.test(trimmed)) {
        inFileTable = true;
        filtered.push(line);
        continue;
      }

      if (inFileTable && /^\|[^|]+\|[^|]+\|[^|]+\|/.test(trimmed)) {
        if (/^\|[-\s|:]+\|$/.test(trimmed)) {
          filtered.push(line);
          continue;
        }
        const match = /^\|\s*`?([^`|\n]+)`?\s*\|/.exec(trimmed);
        if (match && match[1]) {
          const filePath = match[1].trim();
          const fullPath = path.join(workspaceDir, filePath);
          if (!fs.existsSync(fullPath)) {
            continue;
          }
        }
      } else if (inFileTable && /^##\s/.test(trimmed)) {
        inFileTable = false;
      }

      filtered.push(line);
    }

    result = filtered.join('\n');
  }

  return result;
}

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
      lineThreshold: compression.line_threshold ?? DEFAULT_COMPRESSION_CONFIG.lineThreshold,
      sizeThreshold: (compression.size_threshold_kb ?? 15) * 1024,
      intervalMs: (compression.interval_hours ?? 24) * 60 * 60 * 1000,
      keepCompletedTasks: compression.keep_completed_tasks ?? DEFAULT_COMPRESSION_CONFIG.keepCompletedTasks,
      maxWorkingMemoryArtifacts: compression.max_working_memory_artifacts ?? DEFAULT_COMPRESSION_CONFIG.maxWorkingMemoryArtifacts,
    };
  } catch {
    return DEFAULT_COMPRESSION_CONFIG;
  }
}

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

function recordCompressTime(stateDir: string): void {
  try {
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    atomicWriteFileSync(path.join(stateDir, LAST_COMPRESS_FILE), Date.now().toString());
  } catch (error) {
    logError('Failed to record compress time', error);
  }
}

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
  newContent?: string;
} {
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

  const config = loadCompressionConfig(stateDir);

  const oldContent = fs.readFileSync(focusPath, 'utf-8');
  const oldLines = oldContent.split('\n').length;
  const oldSize = Buffer.byteLength(oldContent, 'utf-8');

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

  const coreOptions = {
    lineThreshold: config.lineThreshold,
    sizeThreshold: config.sizeThreshold,
    keepCompletedTasks: config.keepCompletedTasks,
    maxWorkingMemoryArtifacts: config.maxWorkingMemoryArtifacts,
  };
  const prefilteredContent = workspaceDir
    ? cleanupStaleInfo(oldContent, workspaceDir, config)
    : oldContent;
  const coreResult = compressFocusContent(prefilteredContent, coreOptions);

  if (!coreResult.compressed) {
    return {
      compressed: false,
      oldLines,
      newLines: oldLines,
      milestonesArchived: false,
      backupPath: null,
      reason: 'Compression returned no content'
    };
  }

  let milestonesArchived = false;
  if (workspaceDir) {
    const archivePath = archiveMilestonesToDaily(workspaceDir, coreResult.milestones, coreResult.newVersion);
    milestonesArchived = archivePath !== null;
  }

  const backupPath = backupToHistory(focusPath, oldContent);

  cleanupHistory(focusPath);

  atomicWriteFileSync(focusPath, coreResult.newContent);

  if (stateDir) {
    recordCompressTime(stateDir);
  }

  const newLines = coreResult.newContent.split('\n').length;

  return {
    compressed: true,
    oldLines,
    newLines,
    milestonesArchived,
    backupPath,
    newContent: coreResult.newContent,
    reason: `Auto-compressed: ${oldLines} → ${newLines} lines`
  };
}

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

export function archiveMilestonesToDaily(
  workspaceDir: string,
  milestones: { completedTasks: string[]; fileArtifacts: string[] },
  version: string
): string | null {
  if (milestones.completedTasks.length === 0 && milestones.fileArtifacts.length === 0) {
    return null;
  }

  const [dateStr] = new Date().toISOString().split('T');
  const memoryDir = path.join(workspaceDir, 'memory');
  const dailyLogPath = path.join(memoryDir, `${dateStr}.md`);
  const timestamp = new Date().toISOString();

  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }

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

  try {
    fs.appendFileSync(dailyLogPath, lines.join('\n'), 'utf-8');
    return dailyLogPath;
  } catch (error) {
    logError(`Failed to archive milestones to ${dailyLogPath}`, error);
    return null;
  }
}

export function recoverFromTemplate(
  focusPath: string,
  extensionRoot: string
): {
  success: boolean;
  error?: string;
  templatePath?: string;
} {
  try {
    const templatePath = path.join(extensionRoot, CURRENT_FOCUS_TEMPLATE_PATH);

    if (!fs.existsSync(templatePath)) {
      return {
        success: false,
        error: `Template not found: ${templatePath}`
      };
    }

    let template = fs.readFileSync(templatePath, 'utf-8');

    const today = new Date().toISOString().split('T')[0] ?? '';
    template = template.replace(/{YYYY-MM-DD}/g, today);

    if (fs.existsSync(focusPath)) {
      const backupPath = `${focusPath}.corrupted.${Date.now()}.md`;
      fs.copyFileSync(focusPath, backupPath);
    }

    const focusDir = path.dirname(focusPath);
    if (!fs.existsSync(focusDir)) {
      fs.mkdirSync(focusDir, { recursive: true });
    }

    atomicWriteFileSync(focusPath, template);

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

export function safeReadCurrentFocus(
  focusPath: string,
  extensionRoot: string,
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void }
): {
  content: string;
  recovered: boolean;
  validationErrors: string[];
} {
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

  const content = fs.readFileSync(focusPath, 'utf-8');
  const validation = validateCurrentFocus(content);

  if (validation.warnings.length > 0) {
    logger?.warn?.(`[PD:Focus] CURRENT_FOCUS.md warnings: ${validation.warnings.join(', ')}`);
  }

  if (!validation.valid) {
    logger?.warn?.(`[PD:Focus] CURRENT_FOCUS.md corrupted: ${validation.errors.join(', ')}`);

    const result = recoverFromTemplate(focusPath, extensionRoot);
    if (result.success) {
      logger?.info?.(`[PD:Focus] Recovered CURRENT_FOCUS.md from template`);
      return {
        content: fs.readFileSync(focusPath, 'utf-8'),
        recovered: true,
        validationErrors: validation.errors
      };
    }

    logger?.warn?.(`[PD:Focus] Failed to recover: ${result.error}`);
    return {
      content,
      recovered: false,
      validationErrors: validation.errors
    };
  }

  return {
    content,
    recovered: false,
    validationErrors: []
  };
}
