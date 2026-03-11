import * as fs from 'fs';
import * as path from 'path';
import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { resolvePdPath } from '../core/paths.js';

// 安全日志函数
function safeLog(
    api: OpenClawPluginApi | undefined,
    level: 'info' | 'debug' | 'warn' | 'error',
    message: string
): void {
    try {
        if (api?.logger && typeof api.logger[level] === 'function') {
            api.logger[level](message);
        }
    } catch {
        // Ignore logging errors
    }
}

/**
 * 默认消息
 */
const DEFAULT_MESSAGE = '（暂无扩展思维模型）';

/**
 * 索引文件最大大小（字节）
 */
const MAX_INDEX_SIZE = 50 * 1024; // 50KB

/**
 * 加载自定义配置
 */
function loadCustomConfig(workspaceDir?: string): { modelsDir?: string } | undefined {
    if (!workspaceDir) return undefined;

    const configPath = resolvePdPath(workspaceDir, 'PAIN_SETTINGS');
    try {
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const settings = JSON.parse(raw);
            const modelsDir = settings.deep_reflection?.modelsDir;
            if (typeof modelsDir === 'string' && modelsDir.trim()) {
                return { modelsDir: modelsDir.trim() };
            }
        }
    } catch {
        // Ignore config errors
    }
    return undefined;
}

/**
 * 加载扩展思维模型索引
 * 
 * 支持自定义路径：通过 pain_settings.json 中的 deep_reflection.modelsDir 配置
 * 
 * @param workspaceDir - 工作空间目录
 * @param api - OpenClaw 插件 API（用于日志）
 * @returns 索引文件内容或默认消息
 */
export function loadModelIndex(
    workspaceDir?: string,
    api?: OpenClawPluginApi
): string {
    if (!workspaceDir) {
        return DEFAULT_MESSAGE;
    }

    const customConfig = loadCustomConfig(workspaceDir);
    const modelsDir = customConfig?.modelsDir 
        ? path.isAbsolute(customConfig.modelsDir) 
            ? customConfig.modelsDir 
            : path.join(workspaceDir, customConfig.modelsDir)
        : resolvePdPath(workspaceDir, 'MODELS_DIR');
    const indexPath = path.join(modelsDir, '_INDEX.md');

    if (customConfig?.modelsDir) {
        safeLog(api, 'debug', `[DeepReflect] Using custom models dir: ${modelsDir}`);
    }

    try {
        // 索引文件存在
        if (fs.existsSync(indexPath)) {
            // 检查文件大小
            const stats = fs.statSync(indexPath);
            if (stats.size > MAX_INDEX_SIZE) {
                safeLog(api, 'warn', `[DeepReflect] Index file too large (${stats.size} bytes), max is ${MAX_INDEX_SIZE}`);
                return DEFAULT_MESSAGE;
            }
            return fs.readFileSync(indexPath, 'utf8');
        }

        // 边缘情况：models 目录存在但索引文件不存在
        if (fs.existsSync(modelsDir)) {
            safeLog(
                api,
                'warn',
                `[DeepReflect] _INDEX.md not found but ${modelsDir.replace(workspaceDir, '')} exists. Please create an index file.`
            );
        }
    } catch (err) {
        safeLog(api, 'warn', `[DeepReflect] Failed to load model index: ${String(err)}`);
    }

    return DEFAULT_MESSAGE;
}