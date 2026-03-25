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
export declare function normalizeLanguage(lang: string): SupportedLanguage;
export declare const commandDescriptions: Record<string, Record<SupportedLanguage, string>>;
/**
 * Get localized command description.
 * @param name - Command name (e.g., 'pd-init')
 * @param lang - Language code (e.g., 'zh-CN', 'en-US', 'zh', 'en')
 * @returns Localized description or fallback to English then command name
 */
export declare function getCommandDescription(name: string, lang: string): string;
/**
 * Get all command descriptions for a language.
 * @param lang - Language code (e.g., 'zh-CN', 'en-US', 'zh', 'en')
 * @returns Object mapping command names to descriptions
 */
export declare function getAllCommandDescriptions(lang: string): Record<string, string>;
