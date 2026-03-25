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
/**
 * 简单的日志记录器
 */
function logError(message, error) {
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
export function getHistoryDir(focusPath) {
    return path.join(path.dirname(focusPath), '.history');
}
/**
 * 从 CURRENT_FOCUS.md 提取版本号
 * 支持整数和小数版本（如 v1, v1.1, v1.2）
 */
export function extractVersion(content) {
    const match = content.match(/\*\*版本\*\*:\s*v([\d.]+)/i);
    return match ? match[1] : '1';
}
/**
 * 从 CURRENT_FOCUS.md 提取更新日期
 */
export function extractDate(content) {
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
export function backupToHistory(focusPath, content) {
    try {
        const historyDir = getHistoryDir(focusPath);
        // 确保历史目录存在
        if (!fs.existsSync(historyDir)) {
            try {
                fs.mkdirSync(historyDir, { recursive: true });
            }
            catch (error) {
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
        }
        catch (error) {
            logError(`Failed to write backup file: ${backupPath}`, error);
            return null;
        }
    }
    catch (error) {
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
export function cleanupHistory(focusPath, maxFiles = MAX_HISTORY_FILES) {
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
            }
            catch (error) {
                // 单个文件删除失败不应中断整个清理过程
                logError(`Failed to delete history file: ${file.path}`, error);
            }
        }
    }
    catch (error) {
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
export function getHistoryVersions(focusPath, count = FULL_MODE_HISTORY_COUNT) {
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
export function compressFocus(focusPath, newContent) {
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
export function extractSummary(content, maxLines = 30) {
    const lines = content.split('\n');
    const sections = {
        header: [], // 标题和元数据
        snapshot: [], // 状态快照
        current: [], // 当前任务
        nextSteps: [], // 下一步
        reference: [] // 参考
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
        }
        else if (/^#{1,3}\s*.*当前任务|🔄/.test(trimmedLine)) {
            currentSection = 'current';
            hasStructuredSections = true;
        }
        else if (/^#{1,3}\s*.*下一步|➡️/.test(trimmedLine)) {
            currentSection = 'nextSteps';
            hasStructuredSections = true;
        }
        else if (/^#{1,3}\s*.*参考|📎/.test(trimmedLine)) {
            currentSection = 'reference';
            hasStructuredSections = true;
        }
        else if (trimmedLine === '---') {
            continue; // 跳过分隔线
        }
        else if (line.startsWith('<!--')) {
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
    const result = [
        ...sections.header.slice(0, 5), // 标题 + 元数据
        '',
        '---',
        '',
        ...sections.snapshot.slice(0, 10), // 状态快照
        '',
        ...sections.nextSteps.slice(0, 10), // 下一步（优先级高）
        '',
        ...sections.current.slice(0, 15), // 当前任务
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
export function extractWorkingMemory(messages, workspaceDir) {
    const snapshot = {
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
        const toolUses = [];
        if (typeof msg.content === 'string') {
            text = msg.content;
        }
        else if (Array.isArray(msg.content)) {
            const textParts = [];
            for (const c of msg.content) {
                if (!c || typeof c !== 'object')
                    continue;
                const obj = c;
                // 提取文本内容
                if (obj.type === 'text' && typeof obj.text === 'string') {
                    textParts.push(obj.text);
                }
                // 提取工具调用（关键：文件操作在这里！）
                if (obj.type === 'tool_use' && typeof obj.name === 'string' && typeof obj.input === 'object') {
                    toolUses.push({
                        name: obj.name,
                        input: obj.input
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
                    const action = toolUse.name === 'write_file' || toolUse.name === 'create_file' ? 'created' : 'modified';
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
        if (!text)
            continue;
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
function extractFileArtifacts(text, artifacts, workspaceDir) {
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
        let action = 'modified';
        const contextBefore = text.substring(Math.max(0, match.index - 200), match.index);
        if (contextBefore.toLowerCase().includes('created') ||
            contextBefore.includes('新建') ||
            contextBefore.includes('创建')) {
            action = 'created';
        }
        else if (contextBefore.toLowerCase().includes('deleted') ||
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
function extractDescription(text, filePath) {
    // 在文件路径附近查找描述性文字
    const pathIndex = text.indexOf(filePath);
    if (pathIndex === -1)
        return '';
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
function extractProblems(text, problems) {
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
            }
            else {
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
function extractNextActions(text, actions) {
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
function deduplicateArtifacts(artifacts) {
    const seen = new Map();
    for (const artifact of artifacts) {
        const key = artifact.path;
        const existing = seen.get(key);
        if (!existing) {
            seen.set(key, artifact);
        }
        else {
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
export function parseWorkingMemorySection(content) {
    const wmIndex = content.indexOf(WORKING_MEMORY_SECTION);
    if (wmIndex === -1)
        return null;
    const wmContent = content.substring(wmIndex);
    const snapshot = {
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
            action: match[2].toLowerCase(),
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
export function mergeWorkingMemory(content, snapshot) {
    const wmIndex = content.indexOf(WORKING_MEMORY_SECTION);
    // 生成 Working Memory 章节
    const wmSection = generateWorkingMemorySection(snapshot);
    if (wmIndex === -1) {
        // 没有 Working Memory 章节，追加到末尾
        return content.trimEnd() + '\n\n' + WORKING_MEMORY_SECTION + '\n' + wmSection;
    }
    else {
        // 替换现有的 Working Memory 章节
        const beforeWm = content.substring(0, wmIndex);
        // 查找下一个 ## 标题（如果有的话）
        const afterWm = content.substring(wmIndex);
        const nextSectionMatch = afterWm.substring(WORKING_MEMORY_SECTION.length).match(/\n##\s/);
        if (nextSectionMatch && nextSectionMatch.index !== undefined) {
            const nextSectionStart = WORKING_MEMORY_SECTION.length + nextSectionMatch.index;
            return beforeWm + WORKING_MEMORY_SECTION + '\n' + wmSection + '\n' + afterWm.substring(nextSectionStart);
        }
        else {
            return beforeWm + WORKING_MEMORY_SECTION + '\n' + wmSection;
        }
    }
}
/**
 * 生成 Working Memory 章节内容
 */
function generateWorkingMemorySection(snapshot) {
    const lines = [`> Last updated: ${snapshot.lastUpdated}`, ''];
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
            }
            else {
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
export function workingMemoryToInjection(snapshot) {
    if (!snapshot)
        return '';
    if (snapshot.artifacts.length === 0 &&
        snapshot.activeProblems.length === 0 &&
        snapshot.nextActions.length === 0) {
        return '';
    }
    const lines = ['<working_memory preserved="true">'];
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
            }
            else {
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
