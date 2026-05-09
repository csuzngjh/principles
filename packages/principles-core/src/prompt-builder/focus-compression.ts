export interface FileArtifact {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  description: string;
}

export interface WorkingMemorySnapshot {
  lastUpdated: string;
  artifacts: FileArtifact[];
  currentTask?: {
    description: string;
    status: 'in_progress' | 'blocked' | 'reviewing' | 'completed';
    progress: number;
  };
  activeProblems: {
    problem: string;
    approach?: string;
  }[];
  nextActions: string[];
}

export interface FocusCompressionOptions {
  lineThreshold: number;
  sizeThreshold: number;
  keepCompletedTasks: number;
  maxWorkingMemoryArtifacts: number;
}

export interface FocusCompressionResult {
  needsCompression: boolean;
  compressed: boolean;
  oldLines: number;
  newContent: string;
  newVersion: string;
  milestones: { completedTasks: string[]; fileArtifacts: string[] };
}

export const DEFAULT_FOCUS_COMPRESSION_OPTIONS: FocusCompressionOptions = {
  lineThreshold: 100,
  sizeThreshold: 15 * 1024,
  keepCompletedTasks: 3,
  maxWorkingMemoryArtifacts: 10,
};

const WORKING_MEMORY_SECTION = '## 🧠 Working Memory';

function groupRegexMatch(match: RegExpExecArray | null, index: number): string {
  if (!match) return '';
  return match[index] ?? '';
}

export function extractVersion(content: string): string {
  const match = /\*\*版本\*\*:\s*v([\d.]+)/i.exec(content);
  return match ? groupRegexMatch(match, 1) || '1' : '1';
}

export function extractDate(content: string): string {
  const match = /\*\*更新\*\*:\s*(\d{4}-\d{2}-\d{2})/.exec(content);
  return match ? groupRegexMatch(match, 1) : new Date().toISOString().split('T')[0] ?? '';
}

export function extractSummary(content: string, maxLines = 30): string {
  const lines = content.split('\n');
  const sections = new Map<string, string[]>([
    ['header', []],
    ['snapshot', []],
    ['current', []],
    ['nextSteps', []],
    ['reference', []],
  ]);

  let currentSection = 'header';
  let hasStructuredSections = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

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
      continue;
    } else if (line.startsWith('<!--')) {
      continue;
    }

    const section = sections.get(currentSection);
    if (section) section.push(line);
  }

  if (!hasStructuredSections) {
    const result = lines.slice(0, maxLines);
    if (lines.length > maxLines) {
      result.push('');
      result.push('...[truncated, see CURRENT_FOCUS.md for full context]');
    }
    return result.join('\n');
  }

  const result: string[] = [
    ...(sections.get('header') ?? []).slice(0, 5),
    '',
    '---',
    '',
    ...(sections.get('snapshot') ?? []).slice(0, 10),
    '',
    ...(sections.get('nextSteps') ?? []).slice(0, 10),
    '',
    ...(sections.get('current') ?? []).slice(0, 15),
  ];

  const trimmed = result.slice(0, maxLines);
  if (result.length > maxLines) {
    trimmed.push('');
    trimmed.push('...[truncated, see CURRENT_FOCUS.md for full context]');
  }

  return trimmed.join('\n');
}

export function parseWorkingMemorySection(content: string): WorkingMemorySnapshot | null {
  const wmIndex = content.indexOf(WORKING_MEMORY_SECTION);
  if (wmIndex === -1) return null;

  const wmContent = content.substring(wmIndex);

  const snapshot: WorkingMemorySnapshot = {
    lastUpdated: new Date().toISOString(),
    artifacts: [],
    activeProblems: [],
    nextActions: [],
  };

  const updatedMatch = /Last updated:\s*([^\n]+)/i.exec(wmContent);
  if (updatedMatch) {
    snapshot.lastUpdated = groupRegexMatch(updatedMatch, 1).trim();
  }

  const tableRegex = /\|\s*`?([^`|\n]+)`?\s*\|\s*(created|modified|deleted)\s*\|\s*([^|\n]*)\s*\|/gi;
  let tableMatch: RegExpExecArray | null = tableRegex.exec(wmContent);
  while (tableMatch !== null) {
    snapshot.artifacts.push({
      path: groupRegexMatch(tableMatch, 1).trim(),
      action: groupRegexMatch(tableMatch, 2).toLowerCase() as 'created' | 'modified' | 'deleted',
      description: groupRegexMatch(tableMatch, 3).trim(),
    });
    tableMatch = tableRegex.exec(wmContent);
  }

  const problemRegex = /[-*]\s*(.+?)\s*(?:→|->)\s*(.+)/g;
  let problemMatch: RegExpExecArray | null = problemRegex.exec(wmContent);
  while (problemMatch !== null) {
    snapshot.activeProblems.push({
      problem: groupRegexMatch(problemMatch, 1).trim(),
      approach: groupRegexMatch(problemMatch, 2).trim(),
    });
    problemMatch = problemRegex.exec(wmContent);
  }

  const actionRegex = /^\s*[\d]+\.\s*(.+)$/gm;
  let actionMatch: RegExpExecArray | null = actionRegex.exec(wmContent);
  while (actionMatch !== null) {
    snapshot.nextActions.push(groupRegexMatch(actionMatch, 1).trim());
    actionMatch = actionRegex.exec(wmContent);
  }

  return snapshot;
}

export function workingMemoryToInjection(snapshot: WorkingMemorySnapshot | null): string {
  if (!snapshot) return '';

  if (
    snapshot.artifacts.length === 0 &&
    snapshot.activeProblems.length === 0 &&
    snapshot.nextActions.length === 0
  ) {
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

    if (inTaskSection && /^-\s*\[x\]/i.test(trimmed)) {
      completedTasks.push(trimmed.replace(/^-\s*\[x\]\s*/i, ''));
    }

    if (inWorkingMemory) {
      const fileMatch = /^\|\s*`?([^`|\n]+)`?\s*\|/.exec(trimmed);
      const filePath = fileMatch ? groupRegexMatch(fileMatch, 1).trim() : '';
      if (fileMatch && filePath && !filePath.includes('文件路径')) {
        fileArtifacts.push(filePath);
      }
    }
  }

  return {
    completedTasks: completedTasks.slice(-10),
    fileArtifacts: fileArtifacts.slice(-10),
  };
}

export function validateCurrentFocus(content: string): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!content || !content.trim()) {
    errors.push('文件为空');
    return { valid: false, errors, warnings };
  }

  const nonPrintable = content.split('').filter(c => {
    const code = c.charCodeAt(0);
    return code < 32 && code !== 10 && code !== 13 && code !== 9;
  }).length;

  if (nonPrintable > content.length * 0.5) {
    errors.push('文件内容损坏（可能是二进制乱码）');
    return { valid: false, errors, warnings };
  }

  if (!content.includes('下一步') && !content.includes('Next')) {
    warnings.push('缺少下一步章节（建议保留）');
  }

  return {
    valid: true,
    errors,
    warnings,
  };
}

function generateWorkingMemorySection(snapshot: WorkingMemorySnapshot): string {
  const lines: string[] = [`> Last updated: ${snapshot.lastUpdated}`, ''];

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

  if (snapshot.currentTask) {
    lines.push('### 🎯 当前任务');
    lines.push(`- **描述**: ${snapshot.currentTask.description}`);
    lines.push(`- **状态**: ${snapshot.currentTask.status}`);
    lines.push(`- **进度**: ${snapshot.currentTask.progress}%`);
    lines.push('');
  }

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

  if (snapshot.nextActions.length > 0) {
    lines.push('### ➡️ 下一步行动');
    for (let i = 0; i < snapshot.nextActions.length; i++) {
      lines.push(`${i + 1}. ${snapshot.nextActions[i]}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function mergeWorkingMemory(content: string, snapshot: WorkingMemorySnapshot): string {
  const wmIndex = content.indexOf(WORKING_MEMORY_SECTION);

  const wmSection = generateWorkingMemorySection(snapshot);

  if (wmIndex === -1) {
    return content.trimEnd() + '\n\n' + WORKING_MEMORY_SECTION + '\n' + wmSection;
  } else {
    const beforeWm = content.substring(0, wmIndex);
    const afterWm = content.substring(wmIndex);
    const nextSectionMatch = /\n##\s/.exec(afterWm.substring(WORKING_MEMORY_SECTION.length));

    if (nextSectionMatch && nextSectionMatch.index !== undefined) {
      const nextSectionStart = WORKING_MEMORY_SECTION.length + nextSectionMatch.index;
      return beforeWm + WORKING_MEMORY_SECTION + '\n' + wmSection + '\n' + afterWm.substring(nextSectionStart);
    } else {
      return beforeWm + WORKING_MEMORY_SECTION + '\n' + wmSection;
    }
  }
}

export function cleanupStaleInfoPure(
  content: string,
  config: FocusCompressionOptions,
): string {
  const lines = content.split('\n');
  const result: string[] = [];

  let inWorkingMemory = false;
  let inFileTable = false;
  let completedCount = 0;
  let artifactCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^##\s*🧠\s*Working Memory/.test(trimmed)) {
      inWorkingMemory = true;
      inFileTable = false;
    } else if (/^##\s/.test(trimmed) && !trimmed.includes('Working Memory')) {
      inWorkingMemory = false;
      inFileTable = false;
    }

    if (inWorkingMemory && /^\|\s*文件路径/.test(trimmed)) {
      inFileTable = true;
      result.push(line);
      continue;
    }

    if (inFileTable && /^\|[^|]+\|[^|]+\|[^|]+\|/.test(trimmed)) {
      if (/^\|[-\s|:]+\|$/.test(trimmed)) {
        result.push(line);
        continue;
      }

      artifactCount++;
      if (artifactCount > config.maxWorkingMemoryArtifacts) {
        continue;
      }

      result.push(line);
      continue;
    }

    if (/^-\s*\[x\]/i.test(trimmed)) {
      completedCount++;
      if (completedCount > config.keepCompletedTasks) {
        continue;
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

export function compressFocusContent(
  content: string,
  options: FocusCompressionOptions = DEFAULT_FOCUS_COMPRESSION_OPTIONS,
): FocusCompressionResult {
  const lines = content.split('\n');
  const oldLines = lines.length;
  const oldSize = Buffer.byteLength(content, 'utf-8');

  const needsCompression = oldLines > options.lineThreshold || oldSize > options.sizeThreshold;

  if (!needsCompression) {
    return {
      needsCompression: false,
      compressed: false,
      oldLines,
      newContent: content,
      newVersion: extractVersion(content),
      milestones: { completedTasks: [], fileArtifacts: [] },
    };
  }

  const version = extractVersion(content);
  const milestones = extractMilestones(content);

  let newContent = content;

  newContent = cleanupStaleInfoPure(newContent, options);

  newContent = extractSummary(newContent, 50);

  const newVersion = `${parseInt(version, 10) + 1}`;
  const [today] = new Date().toISOString().split('T');
  newContent = newContent
    .replace(/\*\*版本\*\*:\s*v[\d.]+/i, `**版本**: v${newVersion}`)
    .replace(/\*\*更新\*\*:\s*\d{4}-\d{2}-\d{2}/, `**更新**: ${today}`);

  return {
    needsCompression: true,
    compressed: true,
    oldLines,
    newContent,
    newVersion,
    milestones,
  };
}

function extractDescription(text: string, filePath: string): string {
  const pathIndex = text.indexOf(filePath);
  if (pathIndex === -1) return '';

  const before = text.substring(Math.max(0, pathIndex - 100), pathIndex);

  const descPatterns = [
    /(?:description|说明|描述|功能|purpose)[:：]\s*([^\n]{5,50})/i,
    /\/\/\s*(.{5,50})/,
    /\*\s*(.{5,50})\s*$/,
  ];

  for (const pattern of descPatterns) {
    const match = before.match(pattern);
    if (match && match[1]) {
      return match[1].trim().substring(0, 50);
    }
  }

  return '';
}

function extractProblems(
  text: string,
  problems: { problem: string; approach?: string }[],
): void {
  const problemPattern = /(?:问题|problem|error|错误|失败|failed)[:：]\s*([^\n]{5,100})/gi;
  let problemMatch: RegExpExecArray | null = problemPattern.exec(text);
  while (problemMatch !== null) {
    const problemContent = groupRegexMatch(problemMatch, 1).trim();
    if (problemContent.length > 5) {
      problems.push({
        problem: problemContent,
        approach: undefined,
      });
    }
    problemMatch = problemPattern.exec(text);
  }

  const solutionPattern = /(?:解决|solution|方案|修复|fix)[:：]\s*([^\n]{5,100})/gi;
  let solutionMatch: RegExpExecArray | null = solutionPattern.exec(text);
  while (solutionMatch !== null) {
    const solutionContent = groupRegexMatch(solutionMatch, 1).trim();
    if (solutionContent.length > 5) {
      const lastProblem = problems[problems.length - 1];
      if (lastProblem && !lastProblem.approach) {
        lastProblem.approach = solutionContent;
      } else {
        problems.push({
          problem: solutionContent,
          approach: solutionContent,
        });
      }
    }
    solutionMatch = solutionPattern.exec(text);
  }
}

function extractNextActions(text: string, actions: string[]): void {
  const patterns = [
    /(?:下一步|next|接下来|todo|待办)[:：]?\s*\n?\s*[-\d]+\s*[.)]?\s*([^\n]{5,80})/gi,
    /[-\d]+\s*[.)]\s*([^\n]{5,80})/g,
  ];

  for (const pattern of patterns) {
    let nextMatch: RegExpExecArray | null = pattern.exec(text);
    while (nextMatch !== null) {
      const action = groupRegexMatch(nextMatch, 1).trim();
      if (action.length > 5 && !actions.includes(action)) {
        actions.push(action);
      }
      nextMatch = pattern.exec(text);
    }
  }
}

function deduplicateArtifacts(artifacts: FileArtifact[]): FileArtifact[] {
  const seen = new Map<string, FileArtifact>();

  for (const artifact of artifacts) {
    const key = artifact.path;
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, artifact);
    } else {
      if (artifact.description.length > existing.description.length) {
        existing.description = artifact.description;
      }
    }
  }

  return Array.from(seen.values());
}

export {
  extractDescription,
  extractProblems,
  extractNextActions,
  deduplicateArtifacts,
};
