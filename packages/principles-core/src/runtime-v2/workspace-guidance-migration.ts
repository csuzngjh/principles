export interface MigrationResult {
  migrated: string;
  changed: boolean;
  reason?: string;
}

type ActionType = 'remove-line' | 'replace';

interface MigrationRule {
  pattern: RegExp;
  description: string;
  filenameSuffixes: string[];
  actionType: ActionType;
  replacement?: string;
}

const MIGRATION_RULES: MigrationRule[] = [
  {
    pattern: /Physical interception|physical blocking|物理拦截/i,
    description: 'Remove Physical interception / physical blocking / 物理拦截 references (AGENTS.md)',
    filenameSuffixes: ['AGENTS.md'],
    actionType: 'remove-line',
  },
  {
    pattern: /Single source of truth.*PLAN/i,
    description: 'Remove Single source of truth PLAN references (AGENTS.md)',
    filenameSuffixes: ['AGENTS.md'],
    actionType: 'remove-line',
  },
  {
    pattern: /PLAN\.md` \(status: READY\)|PLAN\.md`（状态：READY）/,
    description: 'Remove PLAN.md status: READY references (AGENTS.md, THINKING_OS.md)',
    filenameSuffixes: ['AGENTS.md', 'THINKING_OS.md'],
    actionType: 'remove-line',
  },
  {
    pattern: /project physical plan|项目物理计划/i,
    description: 'Remove project physical plan / 项目物理计划 references (AGENTS.md)',
    filenameSuffixes: ['AGENTS.md'],
    actionType: 'remove-line',
  },
  {
    pattern: /L2 delegation.*(PLAN|gate|blocking)|L2 委派.*(PLAN|gate|拦截)/i,
    description: 'Remove L2 delegation / L2 委派 tied to PLAN.md gate enforcement (AGENTS.md)',
    filenameSuffixes: ['AGENTS.md'],
    actionType: 'remove-line',
  },
  {
    pattern: / or `PLAN\.md`/,
    description: 'Replace "or PLAN.md" in T-02 PHYSICAL_MEMORY_PERSISTENCE (en)',
    filenameSuffixes: ['THINKING_OS.md'],
    actionType: 'replace',
    replacement: '',
  },
  {
    pattern: /或 `PLAN\.md`/,
    description: 'Replace "或 PLAN.md" in T-02 PHYSICAL_MEMORY_PERSISTENCE (zh)',
    filenameSuffixes: ['THINKING_OS.md'],
    actionType: 'replace',
    replacement: '',
  },
  {
    pattern: /PLAN\.md mechanism protects|PLAN\.md 机制保护/,
    description: 'Remove PLAN.md mechanism protects / PLAN.md 机制保护 lines (MEMORY.md)',
    filenameSuffixes: ['MEMORY.md'],
    actionType: 'remove-line',
  },
  {
    pattern: /STATUS: READY|STATUS：READY/,
    description: 'Remove STATUS: READY references (MEMORY.md)',
    filenameSuffixes: ['MEMORY.md'],
    actionType: 'remove-line',
  },
  {
    pattern: /Ensure `PLAN\.md` contains `## Target Files` heading|确保 `PLAN\.md` 包含 `## Target Files` 标题/,
    description: 'Remove PLAN.md Target Files heading checks (admin/SKILL.md)',
    filenameSuffixes: ['admin/SKILL.md'],
    actionType: 'remove-line',
  },
  {
    pattern: /,\s*`PLAN\.md`\s*/,
    description: 'Remove PLAN.md from list as trailing item (admin/SKILL.md, pd-grooming/SKILL.md)',
    filenameSuffixes: ['admin/SKILL.md', 'pd-grooming/SKILL.md'],
    actionType: 'replace',
    replacement: '',
  },
  {
    pattern: /`PLAN\.md`\s*,\s*/,
    description: 'Remove PLAN.md from list as leading item (admin/SKILL.md, pd-grooming/SKILL.md)',
    filenameSuffixes: ['admin/SKILL.md', 'pd-grooming/SKILL.md'],
    actionType: 'replace',
    replacement: '',
  },
  {
    pattern: /Check `PLAN\.md` or early conversation/,
    description: 'Replace Check PLAN.md or early conversation (en, reflection/SKILL.md)',
    filenameSuffixes: ['reflection/SKILL.md'],
    actionType: 'replace',
    replacement: 'Check early conversation context',
  },
  {
    pattern: /Update `PLAN\.md`/,
    description: 'Replace Update PLAN.md with Update memory/.scratchpad.md (en, reflection/SKILL.md)',
    filenameSuffixes: ['reflection/SKILL.md'],
    actionType: 'replace',
    replacement: 'Update `memory/.scratchpad.md`',
  },
  {
    pattern: /检查 `PLAN\.md` 或早期对话/,
    description: 'Replace Check PLAN.md or early conversation (zh, reflection/SKILL.md)',
    filenameSuffixes: ['reflection/SKILL.md'],
    actionType: 'replace',
    replacement: '检查早期对话上下文',
  },
  {
    pattern: /更新 `PLAN\.md`/,
    description: 'Replace Update PLAN.md (zh, reflection/SKILL.md)',
    filenameSuffixes: ['reflection/SKILL.md'],
    actionType: 'replace',
    replacement: '更新 `memory/.scratchpad.md`',
  },
  {
    pattern: /, `PLAN\.md`, and /,
    description: 'Remove PLAN.md from task descriptions (en, report/SKILL.md)',
    filenameSuffixes: ['report/SKILL.md'],
    actionType: 'replace',
    replacement: ' and ',
  },
  {
    pattern: /、`PLAN\.md` 和/,
    description: 'Remove PLAN.md from task descriptions (zh, report/SKILL.md)',
    filenameSuffixes: ['report/SKILL.md'],
    actionType: 'replace',
    replacement: '和',
  },
];

export const STALE_PLAN_MD_PATTERNS: { pattern: RegExp; description: string }[] =
  MIGRATION_RULES.map((rule) => ({ pattern: rule.pattern, description: rule.description }));

function filenameMatches(filename: string, suffix: string): boolean {
  const normalized = filename.replace(/\\/g, '/');
  return normalized === suffix || normalized.endsWith('/' + suffix);
}

export function migrateWorkspaceGuidance(
  content: string,
  filename: string,
): MigrationResult {
  if (content.length === 0) {
    return { migrated: content, changed: false };
  }

  const applicableRules = MIGRATION_RULES.filter((rule) =>
    rule.filenameSuffixes.some((suffix) => filenameMatches(filename, suffix)),
  );

  if (applicableRules.length === 0) {
    return { migrated: content, changed: false };
  }

  const removeLineRules = applicableRules.filter(
    (r) => r.actionType === 'remove-line',
  );
  const replaceRules = applicableRules.filter(
    (r) => r.actionType === 'replace',
  );

  const triggeredDescriptions: string[] = [];
  let memoryMdContentRemoved = false;

  const lines = content.split('\n');
  const keptLines: string[] = [];

  for (const line of lines) {
    let shouldRemove = false;
    for (const rule of removeLineRules) {
      if (rule.pattern.test(line)) {
        shouldRemove = true;
        if (!triggeredDescriptions.includes(rule.description)) {
          triggeredDescriptions.push(rule.description);
        }
        if (filenameMatches(filename, 'MEMORY.md')) {
          memoryMdContentRemoved = true;
        }
        break;
      }
    }
    if (!shouldRemove) {
      keptLines.push(line);
    }
  }

  let migrated = keptLines.join('\n');

  for (const rule of replaceRules) {
    const replacement = rule.replacement ?? '';
    const before = migrated;
    const flags = rule.pattern.flags.includes('g')
      ? rule.pattern.flags
      : rule.pattern.flags + 'g';
    const globalPattern = new RegExp(rule.pattern.source, flags);
    migrated = migrated.replace(globalPattern, replacement);
    if (migrated !== before && !triggeredDescriptions.includes(rule.description)) {
      triggeredDescriptions.push(rule.description);
    }
  }

  if (memoryMdContentRemoved) {
    const historicalNote =
      '[Historical: confirm-first gate was removed in PRI-286. This section is preserved for reference only.]';
    if (!migrated.endsWith('\n')) {
      migrated = migrated + '\n';
    }
    migrated = migrated + historicalNote;
  }

  const changed = migrated !== content;
  const reason = changed
    ? `Migrated stale PLAN.md guidance: ${triggeredDescriptions.join('; ')}`
    : undefined;

  return { migrated, changed, reason };
}

export function containsStalePlanMdGuidance(
  content: string,
  filename: string,
): boolean {
  const applicableRules = MIGRATION_RULES.filter((rule) =>
    rule.filenameSuffixes.some((suffix) => filenameMatches(filename, suffix)),
  );

  for (const rule of applicableRules) {
    if (rule.pattern.test(content)) {
      return true;
    }
  }

  return false;
}
