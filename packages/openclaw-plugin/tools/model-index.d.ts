import type { OpenClawPluginApi } from '../openclaw-sdk.js';
/**
 * 加载模型索引并返回格式化后的字符串
 *
 * @param workspaceDir 工作区目录
 * @param api OpenClaw 插件 API
 * @returns 格式化后的模型索引内容或默认消息
 */
export declare function loadModelIndex(workspaceDir: string, api?: OpenClawPluginApi): string;
