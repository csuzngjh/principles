import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { loadModelIndex } from './model-index.js';

/**
 * 深度指令模板 (必须与测试用例中的 quick/balanced/thorough 关键字对齐)
 */
const DEPTH_INSTRUCTIONS = {
    1: 'Provide a quick surface-level analysis.',
    2: 'Provide a balanced analysis with moderate depth.',
    3: 'Provide an extremely thorough and exhaustive analysis.',
};

/**
 * 构建反思提示词 (Critique Prompt) V2
 * 
 * 严格按照测试用例的调用习惯和断言要求进行重写。
 * 增加 OpenClaw 兼容性路径解析。
 */
export function buildCritiquePromptV2(
    params: {
        context: string;
        depth?: number;
        model_id?: string;
        workspaceDir?: string;
        api?: OpenClawPluginApi;
    }
): string {
    const { context, depth = 2, model_id, workspaceDir, api } = params;
    
    // 1. 确定工作区目录 (优先级：显式传入 > api.config > api.workspaceDir > api.resolvePath)
    const effectiveWorkspaceDir = workspaceDir 
        || (api?.config?.workspaceDir as string) 
        || api?.workspaceDir 
        || api?.resolvePath?.('.');
    
    if (!effectiveWorkspaceDir) {
        throw new Error('Workspace directory is required for deep reflection.');
    }

    // 2. 深度校验与警告日志
    let validatedDepth = 2;
    if (typeof depth === 'number') {
        if (depth >= 1 && depth <= 3) {
            validatedDepth = depth;
        } else {
            if (api?.logger) {
                api.logger.warn(`[DeepReflect] Invalid depth value ${depth}. Falling back to 2.`);
            }
        }
    }
    
    const depthMsg = DEPTH_INSTRUCTIONS[validatedDepth as keyof typeof DEPTH_INSTRUCTIONS];

    // 3. 加载模型索引
    const modelIndexMessage = loadModelIndex(effectiveWorkspaceDir, api);

    // 4. 构造最终提示词
    return `
# Role: Principal Critical Thinker & Strategist
---
[SYSTEM_ID: Critical Analysis Engine]

## Objective
Provide a high-intensity critical analysis and actionable feedback for the provided task context.

## Depth Requirement
${depthMsg}

## Meta-Cognitive Models
The agent has inherited meta-cognitive models (T-01 to T-09) from the **thinking_os** framework. Use these as your foundational logic.

## Model Selection Guidelines
Step 1: Determine if the task context is a **general planning** task or **domain-specific**.
Step 2: Select 1-2 relevant models.
Step 3: If no match is found, use **Fallback** to **Meta-Cognitive Models**.

## Domain-Specific Models Index
${modelIndexMessage}

## Task Context to Analyze
---
${context}
---

## Instructions
1. Apply the selected models rigorously.
2. Identify blind spots and logic gaps.
3. Provide high-impact recommendations.

## Output Structure
- **Blind Spots**: ...
- **Risk Warnings**: ...
- **Alternative Approaches**: ...
- **Recommendations**: ...
- **Confidence Level**: [LOW/MEDIUM/HIGH]
`.trim();
}
