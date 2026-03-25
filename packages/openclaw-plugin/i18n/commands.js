/**
 * Command internationalization module.
 * Provides localized descriptions for all plugin commands.
 */
/**
 * Normalize language code to supported language.
 * Handles variants like zh-CN, zh-TW, en-US, etc.
 * @param lang - Language code (e.g., 'zh-CN', 'en-US', 'zh', 'en')
 * @returns Normalized language ('zh' or 'en')
 */
export function normalizeLanguage(lang) {
    if (lang.toLowerCase().startsWith('zh'))
        return 'zh';
    return 'en';
}
export const commandDescriptions = {
    'pd-init': {
        zh: '初始化工作区（生成 PRINCIPLES.md、THINKING_OS.md 等）',
        en: 'Initialize workspace (generate PRINCIPLES.md, THINKING_OS.md, etc.)'
    },
    'pd-okr': {
        zh: '管理 OKR 目标与关键结果',
        en: 'Manage OKR goals and key results'
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
        zh: '管理思维模型 [status|propose|audit]',
        en: 'Manage Thinking OS [status|propose|audit]'
    },
    'pd-evolve': {
        zh: '执行进化循环处理 Pain 信号',
        en: 'Run evolution loop to process Pain signals'
    },
    'pd-daily': {
        zh: '配置并发送进化日报',
        en: 'Configure and send daily evolution report'
    },
    'pd-grooming': {
        zh: '工作区清理与大扫除',
        en: 'Workspace cleanup and grooming'
    },
    'pd-trust': {
        zh: '查看信任分数和权限等级 (1-4)',
        en: 'View trust score and permission stage (1-4)'
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
        zh: '控制上下文注入 [status|thinking|trust|reflection|focus|preset] - 输入 /pd-context help 查看详情',
        en: 'Control context injection [status|thinking|trust|reflection|focus|preset] - Type /pd-context help for details'
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
        zh: '导出 analytics 或纠错样本 [analytics|corrections --redacted]',
        en: 'Export analytics or correction samples [analytics|corrections --redacted]'
    },
    'pd-samples': {
        zh: '查看或审核纠错样本 [review approve|reject <sample-id> [note]]',
        en: 'List or review correction samples [review approve|reject <sample-id> [note]]'
    }
};
/**
 * Get localized command description.
 * @param name - Command name (e.g., 'pd-init')
 * @param lang - Language code (e.g., 'zh-CN', 'en-US', 'zh', 'en')
 * @returns Localized description or fallback to English then command name
 */
export function getCommandDescription(name, lang) {
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
export function getAllCommandDescriptions(lang) {
    const normalizedLang = normalizeLanguage(lang);
    const result = {};
    for (const [name, descriptions] of Object.entries(commandDescriptions)) {
        result[name] = descriptions[normalizedLang] || descriptions['en'] || name;
    }
    return result;
}
