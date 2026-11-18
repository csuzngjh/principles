 
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { getSession } from '../core/session-tracker.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';
import { atomicWriteFileSync, normalizeCommandArgs } from '../utils/io.js';
import type { ContextInjectionConfig } from '../types.js';
import { loadContextInjectionConfig } from '../hooks/prompt.js';
import { getPdConfigPath } from '../core/pd-config-loader.js';

/**
 * Get workspace directory from context
 */
function getWorkspaceDir(ctx: PluginCommandContext): string {
    // resolvePluginCommandWorkspaceDir throws on failure — never returns falsy
    return resolvePluginCommandWorkspaceDir(ctx, 'context');
}

/**
 * Save context injection config to .pd/config.yaml
 */
function saveConfig(workspaceDir: string, config: ContextInjectionConfig): boolean {
    const configPath = getPdConfigPath(workspaceDir);
    
    try {
        // Ensure directory exists
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Load existing config or start fresh
        let rawConfig: Record<string, unknown> = {};
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                rawConfig = parsed as Record<string, unknown>;
            }
        }
        
        // Update contextInjection
        rawConfig.contextInjection = config;
        
        // Write back as YAML
        const yamlStr = yaml.dump(rawConfig, { indent: 2, lineWidth: 120, noRefs: true, forceQuotes: false });
        atomicWriteFileSync(configPath, yamlStr);
        return true;
    } catch (e) {
        console.error(`[PD:Context] Failed to save config: ${String(e)}`);
        return false;
    }
}

/**
 * Format project focus value for display.
 *
 * Principle Context (SPEC v1.1 §9.2, OD-C): the projectFocus injection chain
 * is RETIRED. The legacy value stays loadable for config compatibility but no
 * longer triggers any CURRENT_FOCUS read or prompt injection, so the status
 * display must not present it as a live runtime control.
 */
function formatProjectFocus(value: 'full' | 'summary' | 'off', isZh: boolean): string {
    const labels = {
        full: { zh: '📦 完整', en: '📦 Full' },
        summary: { zh: '📝 摘要', en: '📝 Summary' },
        off: { zh: '❌ 关闭', en: '❌ Off' }
    };
    return labels[value][isZh ? 'zh' : 'en'];
}

const PROJECT_FOCUS_DEPRECATED_ZH = '⚠️ 已弃用：projectFocus 注入链已退役（Principle Context 只供 Adaptive Selector 使用），该设置不再产生任何 CURRENT_FOCUS 读取或注入';
const PROJECT_FOCUS_DEPRECATED_EN = '⚠️ Deprecated: the projectFocus injection chain is retired (Principle Context is consumed only by the Adaptive selector); this setting no longer triggers any CURRENT_FOCUS read or injection';

/**
 * Show current context injection status
 */
function showStatus(workspaceDir: string, isZh: boolean, sessionId?: string): string {
    const config = loadContextInjectionConfig(workspaceDir);
    const receipt = formatSessionReceipt(sessionId, isZh);

    if (isZh) {
        return `
📊 **上下文注入状态**

| 内容 | 状态 | 说明 |
|------|------|------|
| 核心原则 | ✅ 始终开启 | 不可关闭 |
| 思维模型 | ${config.thinkingOs ? '✅ 开启' : '❌ 关闭'} | /pd-context thinking on/off |
| 项目上下文 | ${formatProjectFocus(config.projectFocus, isZh)} | ⚠️ 已弃用（无注入效果） |

${PROJECT_FOCUS_DEPRECATED_ZH}

${receipt}
💡 输入 \`/pd-context help\` 查看更多选项
`.trim();
    } else {
        return `
📊 **Context Injection Status**

| Content | Status | Control |
|---------|--------|---------|
| Core Principles | ✅ Always ON | Not configurable |
| Thinking OS | ${config.thinkingOs ? '✅ ON' : '❌ OFF'} | /pd-context thinking on/off |
| Project Context | ${formatProjectFocus(config.projectFocus, isZh)} | ⚠️ Deprecated (no injection effect) |

${PROJECT_FOCUS_DEPRECATED_EN}

${receipt}
💡 Type \`/pd-context help\` for more options
`.trim();
    }
}

/**
 * PRI-534: per-session receipt summary (injected principles + blocks +
 * auto-corrections this session). Degrades to a quiet hint when no session
 * identity is available (e.g., non-chat invocations).
 */
function formatSessionReceipt(sessionId: string | undefined, isZh: boolean): string {
    if (!sessionId) return '';
    const state = getSession(sessionId);
    const injected = state?.injectedPrincipleIds ?? [];
    const blocks = state?.blockedAttempts ?? 0;
    const autoCorrects = state?.receiptAutoCorrects ?? 0;
    const preview = injected.slice(0, 3).join(', ') + (injected.length > 3 ? ` …(+${injected.length - 3})` : '');
    if (isZh) {
        return `🧾 **本会话回执**：注入原则 ${injected.length} 条${preview ? `（${preview}）` : ''} · 拦截 ${blocks} 次 · 自动纠正 ${autoCorrects} 次

`;
    }
    return `🧾 **Session receipt**: ${injected.length} principle(s) injected${preview ? ` (${preview})` : ''} · ${blocks} block(s) · ${autoCorrects} auto-correction(s)

`;
}

/**
 * Toggle a boolean setting
 */
 
 
function toggleSetting(
    workspaceDir: string,
    key: 'thinkingOs',
    value: string,
    isZh: boolean
): string {
    const config = loadContextInjectionConfig(workspaceDir);
    const oldValue = config[key];

    if (value === 'on') {
        config[key] = true;
    } else if (value === 'off') {
        config[key] = false;
    } else {
        return isZh
            ? `❌ 无效值: "${value}"。使用 "on" 或 "off"。`
            : `❌ Invalid value: "${value}". Use "on" or "off".`;
    }

    const newValue = config[key];
    const keyName = isZh
        ? { thinkingOs: '思维模型' }[key]
        : key;
    
    // No change needed
    if (oldValue === newValue) {
        return isZh
            ? `ℹ️ ${keyName} 已经是 ${newValue ? '开启' : '关闭'} 状态`
            : `ℹ️ ${keyName} is already ${newValue ? 'ON' : 'OFF'}`;
    }
    
    if (saveConfig(workspaceDir, config)) {
        // Verify the save by re-reading
        const verifyConfig = loadContextInjectionConfig(workspaceDir);
        const verifyValue = verifyConfig[key];
        
        if (verifyValue !== newValue) {
            return isZh
                ? `⚠️ ${keyName} 保存后验证失败，请重试`
                : `⚠️ ${keyName} verification failed after save, please retry`;
        }
        
        const arrow = isZh ? '→' : '→';
        const oldLabel = oldValue ? (isZh ? '开启' : 'ON') : (isZh ? '关闭' : 'OFF');
        const newLabel = newValue ? (isZh ? '开启' : 'ON') : (isZh ? '关闭' : 'OFF');
        
        return isZh
            ? `✅ ${keyName} 已更新: ${oldLabel} ${arrow} ${newLabel}\n\n💡 下次对话时生效`
            : `✅ ${keyName} updated: ${oldLabel} ${arrow} ${newLabel}\n\n💡 Takes effect on next turn`;
    } else {
        return isZh
            ? `❌ 保存配置失败`
            : `❌ Failed to save configuration`;
    }
}

/**
 * Retired focus control (Principle Context SPEC v1.1 §9.2, OD-C): the
 * projectFocus setter is a deprecated notice ONLY. It must never write the
 * config file and never flip any Principle Context egress authorization —
 * the prompt path no longer consumes this value at all.
 */
function setProjectFocus(
    _workspaceDir: string,
    value: string,
    isZh: boolean
): string {
    const validModes = ['full', 'summary', 'off'] as const;
    type FocusMode = typeof validModes[number];
    if (value !== '' && !validModes.includes(value as FocusMode)) {
        return isZh
            ? `❌ 无效值: "${value}"。\n\n${PROJECT_FOCUS_DEPRECATED_ZH}`
            : `❌ Invalid value: "${value}".\n\n${PROJECT_FOCUS_DEPRECATED_EN}`;
    }
    return isZh
        ? `⚠️ /pd-context focus 已弃用，本次操作未执行、配置未修改。\n\n${PROJECT_FOCUS_DEPRECATED_ZH}\n\n💡 Principle Context 由 Owner 手动维护（memory/okr/CURRENT_FOCUS.md），是否发送由 adaptiveActivation.sendPrincipleContext（默认 false）控制，与该设置无关。`
        : `⚠️ /pd-context focus is deprecated; nothing was executed and the config was NOT modified.\n\n${PROJECT_FOCUS_DEPRECATED_EN}\n\n💡 The Principle Context is Owner-maintained (memory/okr/CURRENT_FOCUS.md); whether it is sent is controlled by adaptiveActivation.sendPrincipleContext (default false), unrelated to this setting.`;
}

/**
 * Apply a preset configuration
 *
 * Principle Context (SPEC v1.1 §9.2): presets now control thinkingOs ONLY.
 * The loaded projectFocus value is preserved verbatim — a preset must never
 * modify it (and never touch sendPrincipleContext, which lives in a different
 * config section entirely).
 */
function applyPreset(
    workspaceDir: string,
    preset: 'minimal' | 'standard' | 'full',
    isZh: boolean
): string {
    const current = loadContextInjectionConfig(workspaceDir);
    let config: ContextInjectionConfig;

    switch (preset) {
        case 'minimal':
            config = {
                thinkingOs: false,
                projectFocus: current.projectFocus
            };
            break;
        case 'standard':
            config = {
                thinkingOs: false,
                projectFocus: current.projectFocus
            };
            break;
        case 'full':
            config = {
                thinkingOs: true,
                projectFocus: current.projectFocus
            };
            break;
    }

    if (saveConfig(workspaceDir, config)) {
        const presetName = isZh
            ? { minimal: '最小模式', standard: '标准模式', full: '完整模式' }[preset]
            : `${preset} mode`;
        const note = isZh
            ? '\n\n（projectFocus 已弃用，预设不再修改它；本预设仅调整思维模型）'
            : '\n\n(projectFocus is deprecated; presets no longer modify it — only Thinking OS changed)';
        return isZh
            ? `✅ 已应用预设: ${presetName}${note}\n\n${showStatus(workspaceDir, isZh)}`
            : `✅ Applied preset: ${presetName}${note}\n\n${showStatus(workspaceDir, isZh)}`;
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
\`/pd-context reflection on/off\` - 开关反思日志
\`/pd-context focus\` - ⚠️ 已弃用：项目上下文注入已退役，该子命令不再修改任何配置

**预设模式**:
\`/pd-context minimal\` - 最小模式（仅核心原则）
\`/pd-context standard\` - 标准模式（原则，不含思维模型）
\`/pd-context full\` - 完整模式（原则+思维模型）

**注意**: 核心原则始终注入，不可关闭。项目上下文（CURRENT_FOCUS.md）现为 Owner 手动维护的 Principle Context 来源文件，是否发送由 \`adaptiveActivation.sendPrincipleContext\`（默认 false）控制。
`.trim();
    } else {
        return `
📖 **/pd-context Command Help**

**View Status**:
\`/pd-context status\` - Show current context injection status

**Individual Control**:
\`/pd-context thinking on/off\` - Toggle Thinking OS
\`/pd-context reflection on/off\` - Toggle Reflection Log
\`/pd-context focus\` - ⚠️ Deprecated: project-context injection is retired; this subcommand no longer modifies any config

**Presets**:
\`/pd-context minimal\` - Minimal mode (core principles only)
\`/pd-context standard\` - Standard mode (principles, no Thinking OS)
\`/pd-context full\` - Full mode (principles + Thinking OS)

**Note**: Core Principles are always injected and cannot be disabled. The project context file (CURRENT_FOCUS.md) is now the Owner-maintained Principle Context source; whether it is sent is controlled by \`adaptiveActivation.sendPrincipleContext\` (default false).
`.trim();
    }
}

/**
 * Main command handler
 */
     
export function handleContextCommand(ctx: PluginCommandContext): PluginCommandResult {
    const workspaceDir = getWorkspaceDir(ctx);
    const args = normalizeCommandArgs(ctx.args).trim().split(/\s+/);
    const subCommand = args[0]?.toLowerCase() || 'status';
    const value = args[1]?.toLowerCase() || '';
    
    // Detect language from context
    const isZh = (ctx.config?.language as string) === 'zh';
    
     
     
    let result: string;
    
    switch (subCommand) {
        case 'status':
            result = showStatus(workspaceDir, isZh, ctx.sessionId);
            break;
        case 'thinking':
            result = toggleSetting(workspaceDir, 'thinkingOs', value, isZh);
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
