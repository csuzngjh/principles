import * as fs from 'fs';
import * as path from 'path';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { ContextInjectionConfig, DEFAULT_CONTEXT_CONFIG } from '../types.js';
import { loadContextInjectionConfig } from '../hooks/prompt.js';

/**
 * Get workspace directory from context
 */
function getWorkspaceDir(ctx: PluginCommandContext): string {
    const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
    if (!workspaceDir) {
        throw new Error('[PD:Context] workspaceDir is required but not provided');
    }
    return workspaceDir;
}

/**
 * Save context injection config to PROFILE.json
 */
function saveConfig(workspaceDir: string, config: ContextInjectionConfig): boolean {
    const profilePath = path.join(workspaceDir, '.principles', 'PROFILE.json');
    
    try {
        // Ensure directory exists
        const dir = path.dirname(profilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Load existing profile or create new one
        let profile: Record<string, unknown> = {};
        if (fs.existsSync(profilePath)) {
            const raw = fs.readFileSync(profilePath, 'utf-8');
            profile = JSON.parse(raw);
        }
        
        // Update contextInjection
        profile.contextInjection = config;
        
        // Write back
        fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf-8');
        return true;
    } catch (e) {
        console.error(`[PD:Context] Failed to save config: ${String(e)}`);
        return false;
    }
}

/**
 * Format project focus value for display
 */
function formatProjectFocus(value: 'full' | 'summary' | 'off', isZh: boolean): string {
    const labels = {
        full: { zh: '📦 完整', en: '📦 Full' },
        summary: { zh: '📝 摘要', en: '📝 Summary' },
        off: { zh: '❌ 关闭', en: '❌ Off' }
    };
    return labels[value][isZh ? 'zh' : 'en'];
}

/**
 * Show current context injection status
 */
function showStatus(workspaceDir: string, isZh: boolean): string {
    const config = loadContextInjectionConfig(workspaceDir);
    
    if (isZh) {
        return `
📊 **上下文注入状态**

| 内容 | 状态 | 说明 |
|------|------|------|
| 核心原则 | ✅ 始终开启 | 不可关闭 |
| 思维模型 | ${config.thinkingOs ? '✅ 开启' : '❌ 关闭'} | /pd-context thinking on/off |
| 信任分数 | ${config.trustScore ? '✅ 开启' : '❌ 关闭'} | /pd-context trust on/off |
| 反思日志 | ${config.reflectionLog ? '✅ 开启' : '❌ 关闭'} | /pd-context reflection on/off |
| 项目上下文 | ${formatProjectFocus(config.projectFocus, isZh)} | /pd-context focus full/summary/off |

💡 输入 \`/pd-context help\` 查看更多选项
`.trim();
    } else {
        return `
📊 **Context Injection Status**

| Content | Status | Control |
|---------|--------|---------|
| Core Principles | ✅ Always ON | Not configurable |
| Thinking OS | ${config.thinkingOs ? '✅ ON' : '❌ OFF'} | /pd-context thinking on/off |
| Trust Score | ${config.trustScore ? '✅ ON' : '❌ OFF'} | /pd-context trust on/off |
| Reflection Log | ${config.reflectionLog ? '✅ ON' : '❌ OFF'} | /pd-context reflection on/off |
| Project Context | ${formatProjectFocus(config.projectFocus, isZh)} | /pd-context focus full/summary/off |

💡 Type \`/pd-context help\` for more options
`.trim();
    }
}

/**
 * Toggle a boolean setting
 */
function toggleSetting(
    workspaceDir: string,
    key: 'thinkingOs' | 'trustScore' | 'reflectionLog',
    value: string,
    isZh: boolean
): string {
    const config = loadContextInjectionConfig(workspaceDir);
    
    if (value === 'on') {
        config[key] = true;
    } else if (value === 'off') {
        config[key] = false;
    } else {
        return isZh 
            ? `❌ 无效值: "${value}"。使用 "on" 或 "off"。`
            : `❌ Invalid value: "${value}". Use "on" or "off".`;
    }
    
    if (saveConfig(workspaceDir, config)) {
        const keyName = isZh 
            ? { thinkingOs: '思维模型', trustScore: '信任分数', reflectionLog: '反思日志' }[key]
            : key;
        return isZh
            ? `✅ ${keyName} 已${config[key] ? '开启' : '关闭'}`
            : `✅ ${keyName} is now ${config[key] ? 'ON' : 'OFF'}`;
    } else {
        return isZh
            ? `❌ 保存配置失败`
            : `❌ Failed to save configuration`;
    }
}

/**
 * Set project focus mode
 */
function setProjectFocus(
    workspaceDir: string,
    value: string,
    isZh: boolean
): string {
    const config = loadContextInjectionConfig(workspaceDir);
    
    if (value !== 'full' && value !== 'summary' && value !== 'off') {
        return isZh
            ? `❌ 无效值: "${value}"。使用 "full"、"summary" 或 "off"。`
            : `❌ Invalid value: "${value}". Use "full", "summary", or "off".`;
    }
    
    config.projectFocus = value;
    
    if (saveConfig(workspaceDir, config)) {
        return isZh
            ? `✅ 项目上下文已设置为: ${formatProjectFocus(value, isZh)}`
            : `✅ Project context set to: ${formatProjectFocus(value, isZh)}`;
    } else {
        return isZh
            ? `❌ 保存配置失败`
            : `❌ Failed to save configuration`;
    }
}

/**
 * Apply a preset configuration
 */
function applyPreset(
    workspaceDir: string,
    preset: 'minimal' | 'standard' | 'full',
    isZh: boolean
): string {
    let config: ContextInjectionConfig;
    
    switch (preset) {
        case 'minimal':
            config = {
                thinkingOs: false,
                trustScore: true,
                reflectionLog: false,
                projectFocus: 'off'
            };
            break;
        case 'standard':
            config = {
                thinkingOs: true,
                trustScore: true,
                reflectionLog: false,
                projectFocus: 'off'
            };
            break;
        case 'full':
            config = {
                thinkingOs: true,
                trustScore: true,
                reflectionLog: true,
                projectFocus: 'summary'
            };
            break;
    }
    
    if (saveConfig(workspaceDir, config)) {
        const presetName = isZh
            ? { minimal: '最小模式', standard: '标准模式', full: '完整模式' }[preset]
            : `${preset} mode`;
        return isZh
            ? `✅ 已应用预设: ${presetName}\n\n${showStatus(workspaceDir, isZh)}`
            : `✅ Applied preset: ${presetName}\n\n${showStatus(workspaceDir, isZh)}`;
    } else {
        return isZh
            ? `❌ 保存配置失败`
            : `❌ Failed to save configuration`;
    }
}

/**
 * Show help message
 */
function showHelp(isZh: boolean): string {
    if (isZh) {
        return `
📖 **/pd-context 命令帮助**

**查看状态**:
\`/pd-context status\` - 显示当前上下文注入状态

**单项控制**:
\`/pd-context thinking on/off\` - 开关思维模型
\`/pd-context trust on/off\` - 开关信任分数
\`/pd-context reflection on/off\` - 开关反思日志
\`/pd-context focus full/summary/off\` - 设置项目上下文模式

**预设模式**:
\`/pd-context minimal\` - 最小模式（仅信任分数）
\`/pd-context standard\` - 标准模式（原则+思维模型+信任分数）
\`/pd-context full\` - 完整模式（全部开启）

**注意**: 核心原则始终注入，不可关闭。
`.trim();
    } else {
        return `
📖 **/pd-context Command Help**

**View Status**:
\`/pd-context status\` - Show current context injection status

**Individual Control**:
\`/pd-context thinking on/off\` - Toggle Thinking OS
\`/pd-context trust on/off\` - Toggle Trust Score
\`/pd-context reflection on/off\` - Toggle Reflection Log
\`/pd-context focus full/summary/off\` - Set Project Context mode

**Presets**:
\`/pd-context minimal\` - Minimal mode (trust score only)
\`/pd-context standard\` - Standard mode (principles + thinking + trust)
\`/pd-context full\` - Full mode (all enabled)

**Note**: Core Principles are always injected and cannot be disabled.
`.trim();
    }
}

/**
 * Main command handler
 */
export function handleContextCommand(ctx: PluginCommandContext): PluginCommandResult {
    const workspaceDir = getWorkspaceDir(ctx);
    const args = (ctx.args || '').trim().split(/\s+/);
    const subCommand = args[0]?.toLowerCase() || 'status';
    const value = args[1]?.toLowerCase() || '';
    
    // Detect language from context
    const isZh = (ctx.config?.language as string) === 'zh';
    
    let result: string;
    
    switch (subCommand) {
        case 'status':
            result = showStatus(workspaceDir, isZh);
            break;
        case 'thinking':
            result = toggleSetting(workspaceDir, 'thinkingOs', value, isZh);
            break;
        case 'trust':
            result = toggleSetting(workspaceDir, 'trustScore', value, isZh);
            break;
        case 'reflection':
            result = toggleSetting(workspaceDir, 'reflectionLog', value, isZh);
            break;
        case 'focus':
            result = setProjectFocus(workspaceDir, value, isZh);
            break;
        case 'minimal':
        case 'standard':
        case 'full':
            result = applyPreset(workspaceDir, subCommand, isZh);
            break;
        case 'help':
            result = showHelp(isZh);
            break;
        default:
            result = showHelp(isZh);
    }
    
    return { text: result };
}
