import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDeepReflectTool, deepReflectTool } from '../../src/tools/deep-reflect.js';
import { EventLogService } from '../../src/core/event-log.js';
import type { OpenClawPluginApi, PluginRuntime } from '../../src/openclaw-sdk.js';

describe('createDeepReflectTool', () => {
    let mockApi: OpenClawPluginApi;
    let mockSubagent: any;
    let tempDir: string;

    const mockAsyncFn = <T extends (...args: any[]) => Promise<any>>(
        impl: ReturnType<typeof vi.fn>
    ) => {
        const fn = vi.fn() as unknown as T;
        Object.defineProperty(fn, 'constructor', {
            value: function AsyncFunction() {},
            writable: true,
            configurable: true,
        });
        return fn;
    };

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-reflect-test-'));

        mockSubagent = {
            run: mockAsyncFn().mockResolvedValue({ runId: 'test-run-123' }),
            waitForRun: mockAsyncFn().mockResolvedValue({ status: 'ok' }),
            getSessionMessages: mockAsyncFn().mockResolvedValue({
                messages: [],
                assistantTexts: ['Insight 1', 'Insight 2']
            }),
            deleteSession: mockAsyncFn().mockResolvedValue(undefined),
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

            expect(mockSubagent.waitForRun).toHaveBeenCalledWith({ runId: 'test-run-123' });
            expect(mockSubagent.getSessionMessages).toHaveBeenCalled();
            expect(mockSubagent.deleteSession).toHaveBeenCalled();

            expect(result).toContain('Insight 1');
            expect(result).toContain('Insight 2');
        });

        it('should keep sessionKey for message fetch and cleanup while waiting by runId', async () => {
            mockSubagent.run.mockResolvedValue({ runId: 'run-from-runtime' });
            mockSubagent.waitForRun.mockResolvedValue({ status: 'ok' });
            mockSubagent.getSessionMessages.mockResolvedValue({
                messages: [],
                assistantTexts: ['Insight']
            });

            await executeTool({ context: 'Need clearer workflow tracing.' });

            expect(mockSubagent.waitForRun).toHaveBeenCalledWith({ runId: 'run-from-runtime' });
            expect(mockSubagent.getSessionMessages).toHaveBeenCalledWith({
                sessionKey: expect.stringMatching(/^agent:main:reflection:/)
            });
            expect(mockSubagent.deleteSession).toHaveBeenCalledWith({
                sessionKey: expect.stringMatching(/^agent:main:reflection:/)
            });
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

            expect(callArgs.extraSystemPrompt).not.toContain('T-01: Map Before Territory');
            expect(callArgs.extraSystemPrompt).not.toContain('T-09: Divide and Conquer');

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

            expect(callArgs.extraSystemPrompt).toContain('Model Selection Guidelines');
        });
    });

    describe('工具参数定义', () => {
        it('model_id 应为可选参数', () => {
            const schema = deepReflectTool.parameters;
            const hasModelId = 'model_id' in schema.properties;
            if (hasModelId) {
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

    describe('Bug 修复：sessionId 使用完整 sessionKey', () => {
        it('sessionKey 应包含完整前缀而非纯 UUID', async () => {
            mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
            mockSubagent.waitForRun.mockResolvedValue({ status: 'ok' });
            mockSubagent.getSessionMessages.mockResolvedValue({
                messages: [],
                assistantTexts: ['Insight']
            });

            await executeTool({ context: 'Testing session key fix.' });

            const runCall = mockSubagent.run.mock.calls[0][0];
            expect(runCall.sessionKey).toMatch(/^agent:main:reflection:/);
            expect(runCall.sessionKey.split(':').length).toBeGreaterThan(1);
        });

        it('eventLog 应记录完整 sessionKey 而非纯 UUID', async () => {
            mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
            mockSubagent.waitForRun.mockResolvedValue({ status: 'ok' });
            mockSubagent.getSessionMessages.mockResolvedValue({
                messages: [],
                assistantTexts: ['Analysis complete. Found 2 issues.']
            });

            await executeTool({ context: 'Testing event log sessionId.' });

            EventLogService.flushAll();

            const stateDir = path.join(tempDir, '.state');
            const eventsFile = path.join(stateDir, 'logs', 'events.jsonl');

            expect(fs.existsSync(eventsFile)).toBe(true);

            const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
            const deepReflectionEvents = lines
                .filter((l) => l.includes('deep_reflection'))
                .map((l) => JSON.parse(l));

            expect(deepReflectionEvents.length).toBeGreaterThan(0);

            const event = deepReflectionEvents[0];
            expect(event.sessionId).toMatch(/^agent:main:reflection:/);
            expect(event.sessionId.split(':').length).toBeGreaterThan(1);

            const isBareUuid = !event.sessionId.includes(':');
            expect(isBareUuid).toBe(false);
        });
    });

    describe('Surface degrade 检查', () => {
        it('当 subagent runtime 不可用时（embedded 模式），应返回错误而非抛出', async () => {
            const embeddedSubagent = {
                run: vi.fn(),
                waitForRun: vi.fn(),
                getSessionMessages: vi.fn(),
                deleteSession: vi.fn(),
            };

            const embeddedApi = {
                ...mockApi,
                runtime: {
                    subagent: embeddedSubagent,
                } as unknown as PluginRuntime,
            };

            const tool = createDeepReflectTool(embeddedApi);
            const result = await tool.execute('test-call-id', { context: 'Testing embedded mode.' });

            expect(result.content[0].text).toContain('Subagent runtime 不可用');
            expect(result.content[0].text).toContain('embedded');
            expect(embeddedSubagent.run).not.toHaveBeenCalled();
        });

        it('当 subagent 为 undefined 时，应返回错误', async () => {
            const noSubagentApi = {
                ...mockApi,
                runtime: {
                    subagent: undefined,
                } as unknown as PluginRuntime,
            };

            const tool = createDeepReflectTool(noSubagentApi);
            const result = await tool.execute('test-call-id', { context: 'Testing no subagent.' });

            expect(result.content[0].text).toContain('Subagent runtime 不可用');
        });
    });
});
