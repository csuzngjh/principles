import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceContext } from '../core/workspace-context.js';
// 安全日志函数
function safeLog(api, level, message) {
    try {
        if (api?.logger && typeof api.logger[level] === 'function') {
            api.logger[level](message);
        }
    }
    catch {
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
function loadCustomConfig(wctx) {
    try {
        const config = wctx.config;
        const modelsDir = config.get('deep_reflection.modelsDir');
        if (typeof modelsDir === 'string' && modelsDir.trim()) {
            return { modelsDir: modelsDir.trim() };
        }
    }
    catch {
        // Ignore config errors
    }
    return undefined;
}
/**
 * 加载模型索引并返回格式化后的字符串
 *
 * @param workspaceDir 工作区目录
 * @param api OpenClaw 插件 API
 * @returns 格式化后的模型索引内容或默认消息
 */
export function loadModelIndex(workspaceDir, api) {
    if (!workspaceDir)
        return DEFAULT_MESSAGE;
    try {
        const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
        const customConfig = loadCustomConfig(wctx);
        let modelsDir;
        if (customConfig?.modelsDir) {
            modelsDir = path.isAbsolute(customConfig.modelsDir)
                ? customConfig.modelsDir
                : path.join(workspaceDir, customConfig.modelsDir);
            // 👈 关键修复：显式输出测试用例期待的 debug 日志
            safeLog(api, 'debug', `[DeepReflect] Using custom models dir: ${modelsDir}`);
        }
        else {
            modelsDir = wctx.resolve('MODELS_DIR');
        }
        const indexPath = path.join(modelsDir, '_INDEX.md');
        if (!fs.existsSync(indexPath)) {
            if (fs.existsSync(modelsDir)) {
                safeLog(api, 'warn', `[DeepReflect] _INDEX.md not found but ${modelsDir.replace(workspaceDir, '')} exists. Please create an index file.`);
            }
            return DEFAULT_MESSAGE;
        }
        const stats = fs.statSync(indexPath);
        if (stats.size > MAX_INDEX_SIZE) {
            safeLog(api, 'warn', `[DeepReflect] Index file too large (${stats.size} bytes). Max is ${MAX_INDEX_SIZE}.`);
            return DEFAULT_MESSAGE;
        }
        const content = fs.readFileSync(indexPath, 'utf-8');
        return content.trim() || DEFAULT_MESSAGE;
    }
    catch (err) {
        safeLog(api, 'warn', `[DeepReflect] Failed to load model index: ${String(err)}`);
        return DEFAULT_MESSAGE;
    }
}
