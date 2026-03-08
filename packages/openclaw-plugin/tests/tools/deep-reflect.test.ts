import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deepReflectTool } from '../../src/tools/deep-reflect.js';
import type { OpenClawPluginApi, PluginRuntime } from '../../src/openclaw-sdk.js';

describe('deepReflectTool', () => {
    let mockApi: OpenClawPluginApi;
    let mockSubagent: any;

    beforeEach(() => {
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
            config: {},
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
            resolvePath: vi.fn(),
            on: vi.fn(),
        };
    });

    it('should execute reflection and return insights', async () => {
        mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
        mockSubagent.waitForRun.mockResolvedValue({ status: 'ok' });
        mockSubagent.getSessionMessages.mockResolvedValue({
            messages: [],
            assistantTexts: ['Insight 1', 'Insight 2']
        });

        const result = await deepReflectTool.handler(
            { model_id: 'T-01', context: 'Need to improve caching.' },
            mockApi
        );

        expect(mockSubagent.run).toHaveBeenCalledWith(expect.objectContaining({
            extraSystemPrompt: expect.stringContaining('Critique Engine'),
            deliver: false,
        }));

        expect(mockSubagent.waitForRun).toHaveBeenCalledWith({ runId: 'test-run-123', timeoutMs: 60000 });
        expect(mockSubagent.getSessionMessages).toHaveBeenCalled();
        expect(mockSubagent.deleteSession).toHaveBeenCalled();

        expect(result).toContain('Insight 1');
        expect(result).toContain('Insight 2');
    });

    it('should return a timeout warning cleanly without throwing', async () => {
        mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
        mockSubagent.waitForRun.mockResolvedValue({ status: 'timeout' });

        const result = await deepReflectTool.handler(
            { model_id: 'T-01', context: 'Timeout testing.' },
            mockApi
        );

        expect(result).toContain('反思超时');
        expect(mockSubagent.deleteSession).toHaveBeenCalled();
    });

    it('should handle REFLECTION_OK and return quick success', async () => {
        mockSubagent.run.mockResolvedValue({ runId: 'test-run-123' });
        mockSubagent.waitForRun.mockResolvedValue({ status: 'ok' });
        mockSubagent.getSessionMessages.mockResolvedValue({
            messages: [],
            assistantTexts: ['I have reviewed the plan. REFLECTION_OK.']
        });

        const result = await deepReflectTool.handler(
            { model_id: 'T-01', context: 'Testing OK.' },
            mockApi
        );

        expect(result).toContain('未发现显著问题');
        expect(mockSubagent.deleteSession).toHaveBeenCalled();
    });

    it('should enforce deleteSession even if a system level exception occurs', async () => {
        mockSubagent.run.mockResolvedValue({ runId: 'error-run' });
        mockSubagent.waitForRun.mockRejectedValue(new Error('API throw'));

        await expect(deepReflectTool.handler(
            { model_id: 'T-01', context: 'Testing failure.' },
            mockApi
        )).rejects.toThrow('API throw');

        // Expected to be called in the finally block
        expect(mockSubagent.deleteSession).toHaveBeenCalled();
    });
});
