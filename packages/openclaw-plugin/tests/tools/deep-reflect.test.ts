import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDeepReflectTool, deepReflectTool } from '../../src/tools/deep-reflect.js';
import type { OpenClawPluginApi, PluginRuntime } from '../../src/openclaw-sdk.js';

describe('createDeepReflectTool', () => {
    let mockApi: OpenClawPluginApi;
    let mockSubagent: any;
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-reflect-test-'));
        
        mockSubagent = {
            run: vi.fn(),
            waitForRun: vi.fn(),
            getSessionMessages: vi.fn(),
            deleteSession: vi.fn().mockResolvedValue(undefined),
        };

        mockApi = {
            id: "test-plugin",
            name: "Test Plugin",
            source: "local",
            config: { workspaceDir: tempDir },
            runtime: {
                subagent: mockSubagent,
            } as unknown as PluginRuntime,
            logger: {
                info: vi.fn(),
                error: vi.fn(),
                warn: vi.fn(),
                debug: vi.fn(),
            },
            registerTool: vi.fn(),
            registerHook: vi.fn(),
            registerHttpRoute: vi.fn(),
            registerChannel: vi.fn(),
            registerGatewayMethod: vi.fn(),
            registerCli: vi.fn(),
            registerService: vi.fn(),
            registerProvider: vi.fn(),
            registerCommand: vi.fn(),
            resolvePath: vi.fn((p: string) => path.join(tempDir, p)),
            on: vi.fn(),
        };
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    // Helper to create tool and extract text result
    const executeTool = async (rawParams: Record<string, unknown>) => {
        const tool = createDeepReflectTool(mockApi);
        const result = await tool.execute('test-call-id', rawParams);
        return result.content[0]?.text || '';
    };

    describe('基本功能', () => {
        it('should execute reflection and return insights', async () => {
            mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
            mockSubagent.waitForRun.mockResolvedValue({ status: 'ok' });
            mockSubagent.getSessionMessages.mockResolvedValue({
                messages: [],
                assistantTexts: ['Insight 1', 'Insight 2']
            });

            const result = await executeTool({ context: 'Need to improve caching.' });

            expect(mockSubagent.run).toHaveBeenCalledWith(expect.objectContaining({
                extraSystemPrompt: expect.stringContaining('Critical Analysis Engine'),
                deliver: false,
            }));

            expect(mockSubagent.waitForRun).toHaveBeenCalled();
            expect(mockSubagent.getSessionMessages).toHaveBeenCalled();
            expect(mockSubagent.deleteSession).toHaveBeenCalled();

            expect(result).toContain('Insight 1');
            expect(result).toContain('Insight 2');
        });

        it('should return a timeout warning cleanly without throwing', async () => {
            mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
            mockSubagent.waitForRun.mockResolvedValue({ status: 'timeout' });

            const result = await executeTool({ context: 'Timeout testing.' });

            expect(result).toContain('超时');
            expect(mockSubagent.deleteSession).toHaveBeenCalled();
        });

        it('should handle REFLECTION_OK and return quick success', async () => {
            mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
            mockSubagent.waitForRun.mockResolvedValue({ status: 'ok' });
            mockSubagent.getSessionMessages.mockResolvedValue({
                messages: [],
                assistantTexts: ['I have reviewed the plan. REFLECTION_OK.']
            });

            const result = await executeTool({ context: 'Testing OK.' });

            expect(result).toContain('未发现显著问题');
            expect(mockSubagent.deleteSession).toHaveBeenCalled();
        });

        it('should enforce deleteSession even if a system level exception occurs', async () => {
            mockSubagent.run.mockResolvedValue({ runId: 'error-run' });
            mockSubagent.waitForRun.mockRejectedValue(new Error('API throw'));

            const tool = createDeepReflectTool(mockApi);
            await expect(tool.execute('test-call-id', { context: 'Testing failure.' }))
                .rejects.toThrow('API throw');

            // Expected to be called in the finally block
            expect(mockSubagent.deleteSession).toHaveBeenCalled();
        });
    });

    describe('新功能：子智能体自主选择模型', () => {
        it('extraSystemPrompt 应包含模型选择指南', async () => {
            mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
            mockSubagent.waitForRun.mockResolvedValue({ status: 'ok' });
            mockSubagent.getSessionMessages.mockResolvedValue({
                messages: [],
                assistantTexts: ['Analysis complete.']
            });

            await executeTool({ context: 'Marketing plan for Q4.' });

            const callArgs = mockSubagent.run.mock.calls[0][0];
            
            // 应包含模型选择指南
            expect(callArgs.extraSystemPrompt).toContain('Model Selection Guidelines');
            expect(callArgs.extraSystemPrompt).toContain('Step 1');
            expect(callArgs.extraSystemPrompt).toContain('Step 2');
            expect(callArgs.extraSystemPrompt).toContain('Step 3');
        });

        it('extraSystemPrompt 不应重复列出元认知模型', async () => {
            mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
            mockSubagent.waitForRun.mockResolvedValue({ status: 'ok' });
            mockSubagent.getSessionMessages.mockResolvedValue({
                messages: [],
                assistantTexts: ['Analysis complete.']
            });

            await executeTool({ context: 'Test context.' });

            const callArgs = mockSubagent.run.mock.calls[0][0];
            
            // 不应重复列出具体的元认知模型
            expect(callArgs.extraSystemPrompt).not.toContain('T-01: Map Before Territory');
            expect(callArgs.extraSystemPrompt).not.toContain('T-09: Divide and Conquer');
            
            // 应说明元认知模型已继承
            expect(callArgs.extraSystemPrompt).toContain('Meta-Cognitive Models');
            expect(callArgs.extraSystemPrompt).toContain('inherited');
        });

        it('当有模型索引时，应注入索引内容', async () => {
            const modelsDir = path.join(tempDir, '.principles', 'models');
            fs.mkdirSync(modelsDir, { recursive: true });
            
            const indexContent = `# 扩展思维模型索引
| ID | 名称 | 适用场景 |
|----|------|----------|
| MARKETING_4P | 营销4P | 营销策略 |
`;
            fs.writeFileSync(path.join(modelsDir, '_INDEX.md'), indexContent);

            mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
            mockSubagent.waitForRun.mockResolvedValue({ status: 'ok' });
            mockSubagent.getSessionMessages.mockResolvedValue({
                messages: [],
                assistantTexts: ['Analysis complete.']
            });

            await executeTool({ context: 'Marketing plan.' });

            const callArgs = mockSubagent.run.mock.calls[0][0];
            
            expect(callArgs.extraSystemPrompt).toContain('MARKETING_4P');
        });
    });

    describe('向后兼容：model_id 参数（deprecated）', () => {
        it('当传入 model_id 时，应输出警告日志', async () => {
            mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
            mockSubagent.waitForRun.mockResolvedValue({ status: 'ok' });
            mockSubagent.getSessionMessages.mockResolvedValue({
                messages: [],
                assistantTexts: ['Analysis complete.']
            });

            await executeTool({ model_id: 'T-01', context: 'Test.' });

            expect(mockApi.logger!.warn).toHaveBeenCalledWith(
                expect.stringContaining('deprecated')
            );
        });

        it('当传入 model_id 时，仍应使用新的提示词格式', async () => {
            mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
            mockSubagent.waitForRun.mockResolvedValue({ status: 'ok' });
            mockSubagent.getSessionMessages.mockResolvedValue({
                messages: [],
                assistantTexts: ['Analysis complete.']
            });

            await executeTool({ model_id: 'T-05', context: 'Test.' });

            const callArgs = mockSubagent.run.mock.calls[0][0];
            
            // 应使用新的提示词格式
            expect(callArgs.extraSystemPrompt).toContain('Model Selection Guidelines');
        });
    });

    describe('工具参数定义', () => {
        it('model_id 应为可选参数', () => {
            const schema = deepReflectTool.parameters;
            
            // 检查 model_id 是否在 schema 中（可能是可选的）
            const hasModelId = 'model_id' in schema.properties;
            
            // 如果存在 model_id，检查它是否是可选的
            if (hasModelId) {
                // model_id 应该是可选的（不在 required 数组中）
                const required = (schema as any).required || [];
                expect(required).not.toContain('model_id');
            }
        });

        it('context 应为必需参数', () => {
            const schema = deepReflectTool.parameters;
            const required = (schema as any).required || [];
            
            expect(required).toContain('context');
        });

        it('depth 应为可选参数', () => {
            const schema = deepReflectTool.parameters;
            const required = (schema as any).required || [];
            
            expect(required).not.toContain('depth');
        });
    });
});
