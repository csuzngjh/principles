import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { loadModelIndex } from './model-index.js';

/**
 * 深度指令模板
 */
const DEPTH_INSTRUCTIONS = {
    1: 'Provide a quick surface-level analysis.',
    2: 'Provide a balanced analysis with moderate depth.',
    3: 'Provide an extremely thorough and exhaustive analysis.',
} as const;

/**
 * 有效深度值
 */
type ValidDepth = keyof typeof DEPTH_INSTRUCTIONS;

/**
 * 构建批判分析提示词 V2
 * 
 * 与旧版本的区别：
 * 1. 不再重复列出元认知模型（已在 thinking_os 中）
 * 2. 增加模型选择指南（Step 1/2/3）
 * 3. 加载扩展思维模型索引
 * 
 * @param params - 参数
 * @returns 构建好的提示词
 */
export function buildCritiquePromptV2(params: {
    context: string;
    workspaceDir?: string;
    depth?: number;
    api?: OpenClawPluginApi;
}): string {
    const { context, workspaceDir, depth = 2, api } = params;
    
    // 加载模型索引（同步）
    const modelIndex = loadModelIndex(workspaceDir, api);
    
    // 深度指令：验证并获取有效值
    const validDepth: ValidDepth = (depth >= 1 && depth <= 3) ? depth as ValidDepth : 2;
    const depthInstruction = DEPTH_INSTRUCTIONS[validDepth];
    
    // 边界值警告
    if (depth !== undefined && (depth < 1 || depth > 3)) {
        const logger = api?.logger;
        if (logger && typeof logger.warn === 'function') {
            logger.warn(`[DeepReflect] Invalid depth value ${depth}, falling back to 2`);
        }
    }

    return `You are a Critical Analysis Engine — an independent reasoning system.

## Your Resources

### 1. Meta-Cognitive Models (inherited)
Already available in your context via \`<thinking_os>\` tag. 
These 9 models (T-01 to T-09) provide foundational cognitive strategies.
No need to read them — they are already present.

### 2. Domain-Specific Models (load on demand)
${modelIndex}

## Model Selection Guidelines

**Step 1: Assess the task context**
- Is this a **general planning/analysis task**? → Use Meta-Cognitive Models (T-01 to T-09)
- Is this a **domain-specific task** (marketing, strategy, product, etc.)? → Load relevant Domain Model(s)

**Step 2: Handle multiple matches**
- If multiple domain models could apply, select the **most relevant** one first
- You MAY load additional models for **combined analysis** (e.g., SWOT + Porter's Five Forces)

**Step 3: Fallback**
- If NO domain model clearly matches your task, fall back to Meta-Cognitive Models
- Do NOT force a domain model if it doesn't fit

## Your Task

${depthInstruction}

Analyze the following context and provide critical feedback:

---
${context}
---

## Required Output Structure

### 🎯 Blind Spots (What might be missing?)
- List at least 2-3 potential blind spots
- Be specific about what information or perspectives are lacking

### ⚠️ Risk Warnings (What could go wrong?)
- Identify potential failure modes
- Consider edge cases and error handling

### 💡 Alternative Approaches (Is there a better way?)
- Propose at least 2 different approaches
- Compare trade-offs

### 📊 Recommendations (Not decisions, but suggestions)
- Prioritize by impact and effort
- Be actionable and specific

### 🔮 Confidence Level
- State: LOW / MEDIUM / HIGH
- Explain why`;
}