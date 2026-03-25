import type { OpenClawPluginApi } from '../openclaw-sdk.js';
/**
 * 构建反思提示词 (Critique Prompt) V2
 *
 * 严格按照测试用例的调用习惯和断言要求进行重写。
 * 增加 OpenClaw 兼容性路径解析。
 */
export declare function buildCritiquePromptV2(params: {
    context: string;
    depth?: number;
    model_id?: string;
    workspaceDir?: string;
    api?: OpenClawPluginApi;
}): string;
