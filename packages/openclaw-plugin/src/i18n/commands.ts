/**
 * Command internationalization module.
 * Provides localized descriptions for all plugin commands.
 */

export type SupportedLanguage = 'zh' | 'en';

/**
 * Normalize language code to supported language.
 * Handles variants like zh-CN, zh-TW, en-US, etc.
 * @param lang - Language code (e.g., 'zh-CN', 'en-US', 'zh', 'en')
 * @returns Normalized language ('zh' or 'en')
 */
export function normalizeLanguage(lang: string): SupportedLanguage {
  if (lang.toLowerCase().startsWith('zh')) return 'zh';
  return 'en';
}

export const commandDescriptions: Record<string, Record<SupportedLanguage, string>> = {
  'pd-init': {
    zh: '初始化工作区（生成 PRINCIPLES.md、THINKING_OS.md 等）',
    en: 'Initialize workspace (generate PRINCIPLES.md, THINKING_OS.md, etc.)'
  },
  'pd-bootstrap': {
    zh: '扫描环境工具并建议升级',
    en: 'Scan environment tools and suggest upgrades'
  },
  'pd-research': {
    zh: '研究工具升级方案',
    en: 'Research tool upgrade solutions'
  },
  'pd-thinking': {
    zh: '管理思维模型 [status|propose|audit]（默认关闭，/pd-context thinking on 开启）',
    en: 'Manage Thinking OS [status|propose|audit] (off by default, enable via /pd-context thinking on)'
  },
  'pd-help': {
    zh: '显示所有命令和使用指南',
    en: 'Show all commands and usage guide'
  },
  'pd-status': {
    zh: '查看系统状态（GFI、Pain 词典）',
    en: 'View system status (GFI, Pain dictionary)'
  },
  'pd-context': {
    zh: '控制上下文注入 [status|thinking|reflection|focus|preset] - 输入 /pd-context help 查看详情',
    en: 'Control context injection [status|thinking|reflection|focus|preset] - Type /pd-context help for details'
  },
  'pd-focus': {
    zh: '管理 CURRENT_FOCUS.md [status|history|compress|rollback] - 查看/压缩/回滚焦点文件',
    en: 'Manage CURRENT_FOCUS.md [status|history|compress|rollback] - View/compress/rollback focus file'
  },
  'pd-evolution-status': {
    zh: '查看 evolution 闭环状态（candidate/probation/active）',
    en: 'Show evolution loop status (candidate/probation/active)'
  },
  'pd-principle-rollback': {
    zh: '回滚原则并加入黑名单 <principle-id> [reason]',
    en: 'Rollback principle and blacklist pattern <principle-id> [reason]'
  },
  'pd-rollback': {
    zh: '回滚情绪事件惩罚 <event-id>|last',
    en: 'Rollback empathy event penalty <event-id>|last'
  },
  'pd-export': {
    zh: '导出数据 [analytics|corrections --redacted]',
    en: 'Export data [analytics|corrections --redacted]'
  },
  'pd-samples': {
    zh: '查看或审核纠错样本 [review approve|reject <sample-id> [note]]',
    en: 'List or review correction samples [review approve|reject <sample-id> [note]]'
  },
  'pd-pain': {
    zh: '从 OpenClaw 会话报告 pain（context-bound provenance）',
    en: 'Report pain from OpenClaw session (context-bound provenance)'
  },
  'pd-workflow-debug': {
    zh: '调试 workflow 状态与事件 [workflowId]',
    en: 'Debug workflow state and events [workflowId]'
  },
  'pd-promote-impl': {
    zh: '提升候选实现到 active [list|show <id>|<id>]（半废弃）',
    en: 'Promote candidate implementation to active [list|show <id>|<id>] (semi-deprecated)'
  },
  'pd-disable-impl': {
    zh: '禁用 active 实现 [list|<id> --reason "..."]（半废弃）',
    en: 'Disable active implementation [list|<id> --reason "..."] (semi-deprecated)'
  },
  'pd-archive-impl': {
    zh: '永久归档实现 [list|<id>]（半废弃）',
    en: 'Archive implementation permanently [list|<id>] (semi-deprecated)'
  },
  'pd-rollback-impl': {
    zh: '回滚到上一个 active 实现 [list|<id> --reason "..."]（半废弃）',
    en: 'Rollback to previous active implementation [list|<id> --reason "..."] (semi-deprecated)'
  },
};

/**
 * Get localized command description.
 * @param name - Command name (e.g., 'pd-init')
 * @param lang - Language code (e.g., 'zh-CN', 'en-US', 'zh', 'en')
 * @returns Localized description or fallback to English then command name
 */
export function getCommandDescription(name: string, lang: string): string {
  const normalizedLang = normalizeLanguage(lang);
  const descriptions = commandDescriptions[name];
  if (!descriptions) {
    return name;
  }
  return descriptions[normalizedLang] || descriptions.en || name;
}

/**
 * Get all command descriptions for a language.
 * @param lang - Language code (e.g., 'zh-CN', 'en-US', 'zh', 'en')
 * @returns Object mapping command names to descriptions
 */
export function getAllCommandDescriptions(lang: string): Record<string, string> {
  const normalizedLang = normalizeLanguage(lang);
  const result: Record<string, string> = {};
  for (const [name, descriptions] of Object.entries(commandDescriptions)) {
    result[name] = descriptions[normalizedLang] || descriptions.en || name;
  }
  return result;
}
