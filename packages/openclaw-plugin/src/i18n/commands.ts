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
    zh: '初始化战略访谈和OKR',
    en: 'Initialize strategy interview and OKRs'
  },
  'pd-okr': {
    zh: '目标与关键结果管理',
    en: 'Manage OKRs and align goals'
  },
  'pd-bootstrap': {
    zh: '环境工具扫描与升级',
    en: 'Scan and upgrade environment tools'
  },
  'pd-research': {
    zh: '发起工具升级研究',
    en: 'Research tool upgrades'
  },
  'pd-thinking': {
    zh: '管理思维模型与候选方案',
    en: 'Manage Thinking OS mental models'
  },
  'pd-evolve': {
    zh: '执行完整进化循环',
    en: 'Run full evolution loop'
  },
  'pd-daily': {
    zh: '配置并发送进化日报',
    en: 'Configure and send daily report'
  },
  'pd-grooming': {
    zh: '工作区数字大扫除',
    en: 'Workspace cleanup and grooming'
  },
  'pd-trust': {
    zh: '查看信任积分与安全等级',
    en: 'View trust score and security stage'
  },
  'pd-help': {
    zh: '获取交互式命令引导',
    en: 'Get interactive command guidance'
  },
  'pd-status': {
    zh: '查看数字神经系统状态（GFI和痛苦词典）',
    en: 'View Digital Nerve System status (GFI and Pain Dictionary)'
  }
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
  return descriptions[normalizedLang] || descriptions['en'] || name;
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
    result[name] = descriptions[normalizedLang] || descriptions['en'] || name;
  }
  return result;
}
