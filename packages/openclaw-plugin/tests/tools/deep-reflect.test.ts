import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDeepReflectTool, deepReflectTool } from '../../src/tools/deep-reflect.js';
import { EventLogService } from '../../src/core/event-log.js';
import type { OpenClawPluginApi, PluginRuntime } from '../../src/openclaw-sdk.js';

vi.mock('../../src/service/subagent-workflow/deep-reflect-workflow-manager.js', () => ({
    DeepReflectWorkflowManager: vi.fn().mockImplementation(function() {
        return globalThis.__DR_MOCK_MANAGER;
    }),
    deepReflectWorkflowSpec: { workflowType: 'deep_reflect' },
}));

vi.mock('../../src/core/config.js', () => ({
    loadConfig: vi.fn(() => ({ mode: 'enabled', enabled: true, timeout_ms: 300 })),
}));

vi.mock('../../src/core/paths.js', () => ({
    resolvePdPath: vi.fn((_dir: string, key: string) => {
        const base = globalThis.__TEST_TEMP_DIR || '/tmp';
        if (key === 'STATE_DIR') return path.join(base, '.state');
        if (key === 'REFLECTION_LOG') return path.join(base, 'memory', 'REFLECTION_LOG.md');
        if (key === 'PAIN_SETTINGS') return path.join(base, '.principles', 'PAIN_SETTINGS.json');
        return path.join(base, key);
    }),
}));

declare global {
    var __TEST_TEMP_DIR: string | undefined;
    var __DR_MOCK_MANAGER: any;
}

describe('createDeepReflectTool (workflow helper path)', () => {
    let mockApi: OpenClawPluginApi;
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-reflect-test-'));
        globalThis.__TEST_TEMP_DIR = tempDir;

        fs.mkdirSync(path.join(tempDir, '.state', 'logs'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'memory'), { recursive: true });

        const mockSubagent = {
            run: vi.fn().mockResolvedValue({ runId: 'test-run-123' }),
            waitForRun: vi.fn().mockResolvedValue({ status: 'ok' }),
            getSessionMessages: vi.fn().mockResolvedValue({ messages: [], assistantTexts: [] }),
            deleteSession: vi.fn().mockResolvedValue(undefined),
        };

        mockApi = {
            id: "test-plugin",
            name: "Test Plugin",
            source: "local",
            workspaceDir: tempDir,
            config: { workspaceDir: tempDir },
            runtime: { subagent: mockSubagent } as unknown as PluginRuntime,
            logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
            registerTool: vi.fn(),
            registerHook: vi.fn(),
            registerHttpRoute: vi.fn(),
            registerService: vi.fn(),
            registerCommand: vi.fn(),
            resolvePath: vi.fn((p: string) => path.join(tempDir, p)),
            on: vi.fn(),
        };

        globalThis.__DR_MOCK_MANAGER = {
            startWorkflow: vi.fn().mockResolvedValue({
                workflowId: 'wf-test-123',
                childSessionKey: 'agent:main:subagent:workflow-test-123',
                state: 'active',
            }),
            dispose: vi.fn(),
            store: {
                getWorkflow: vi.fn().mockReturnValue({
                    workflow_id: 'wf-test-123',
                    state: 'completed',
                    child_session_key: 'agent:main:subagent:workflow-test-123',
                }),
            },
        };
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        globalThis.__TEST_TEMP_DIR = undefined;
        globalThis.__DR_MOCK_MANAGER = undefined;
        vi.clearAllMocks();
    });

    const executeTool = async (rawParams: Record<string, unknown>) => {
        const tool = createDeepReflectTool(mockApi);
        return tool.execute('test-call-id', rawParams);
    };

    describe('参数验证', () => {
        it('context 为空时应返回错误', async () => {
            const result = await executeTool({ context: '' });
            expect(result.content[0].text).toContain('必须提供反思上下文');
        });

        it('workspaceDir 缺失时应返回错误', async () => {
            const noWsApi = {
                ...mockApi,
                workspaceDir: undefined,
                config: {},
                resolvePath: vi.fn(() => undefined),
            };
            const tool = createDeepReflectTool(noWsApi as any);
            const result = await tool.execute('test-call-id', { context: 'test' });
            // effectiveWorkspaceDir resolves to undefined, tool should fail gracefully
            expect(result.content[0].text).toMatch(/失败|required|Workspace/i);
        });
    });

    describe('workflow 执行', () => {
        it('应创建 DeepReflectWorkflowManager 并调用 startWorkflow', async () => {
            const { DeepReflectWorkflowManager } = await import('../../src/service/subagent-workflow/deep-reflect-workflow-manager.js');
            const reflectionLogPath = path.join(tempDir, 'memory', 'REFLECTION_LOG.md');
            fs.writeFileSync(reflectionLogPath, `# Reflection Log\n\n### Insights\nTest insight here\n\n`);

            const result = await executeTool({ context: 'Need to improve caching.' });

            expect(DeepReflectWorkflowManager).toHaveBeenCalledWith({
                workspaceDir: tempDir,
                logger: mockApi.logger,
                subagent: mockApi.runtime.subagent,
            });
            expect(globalThis.__DR_MOCK_MANAGER.startWorkflow).toHaveBeenCalled();
            expect(result.content[0].text).toContain('Test insight here');
        });

        it('应传递正确的 taskInput 给 startWorkflow', async () => {
            const { DeepReflectWorkflowManager } = await import('../../src/service/subagent-workflow/deep-reflect-workflow-manager.js');
            const reflectionLogPath = path.join(tempDir, 'memory', 'REFLECTION_LOG.md');
            fs.writeFileSync(reflectionLogPath, `# Reflection Log\n\n### Insights\nDone\n\n`);

            await executeTool({ context: 'Test context', depth: 3 });

            expect(DeepReflectWorkflowManager).toHaveBeenCalledWith(
                expect.objectContaining({ workspaceDir: tempDir })
            );
            const startArgs = globalThis.__DR_MOCK_MANAGER.startWorkflow.mock.calls[0][1];
            expect(startArgs.taskInput).toEqual({
                context: 'Test context',
                depth: 3,
                model_id: undefined,
            });
        });
    });

    describe('超时处理', () => {
        it('workflow 超时应返回超时提示', async () => {
            // Create PAIN_SETTINGS.json to override default 60s timeout
            const settingsPath = path.join(tempDir, '.principles', 'PAIN_SETTINGS.json');
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
            fs.writeFileSync(settingsPath, JSON.stringify({ deep_reflection: { timeout_ms: 300 } }));

            globalThis.__DR_MOCK_MANAGER.store.getWorkflow.mockReturnValue({
                workflow_id: 'wf-test-123',
                state: 'active',
            });

            const result = await executeTool({ context: 'Timeout test.' });

            expect(result.content[0].text).toContain('超时');
            expect(globalThis.__DR_MOCK_MANAGER.dispose).toHaveBeenCalled();
        }, 10000);
    });

    describe('错误处理', () => {
        it('workflow terminal_error 应返回错误信息', async () => {
            globalThis.__DR_MOCK_MANAGER.store.getWorkflow.mockReturnValue({
                workflow_id: 'wf-test-123',
                state: 'terminal_error',
            });

            const result = await executeTool({ context: 'Error test.' });

            expect(result.content[0].text).toContain('失败');
            expect(globalThis.__DR_MOCK_MANAGER.dispose).toHaveBeenCalled();
        });

        it('startWorkflow 抛出异常应返回友好错误', async () => {
            globalThis.__DR_MOCK_MANAGER.startWorkflow.mockRejectedValue(new Error('Network error'));

            const result = await executeTool({ context: 'Crash test.' });

            expect(result.content[0].text).toContain('失败');
            expect(result.content[0].text).toContain('Network error');
        });
    });

    describe('向后兼容：model_id 参数', () => {
        it('当传入 model_id 时，应输出警告日志', async () => {
            const reflectionLogPath = path.join(tempDir, 'memory', 'REFLECTION_LOG.md');
            fs.writeFileSync(reflectionLogPath, `# Reflection Log\n\n### Insights\nDone\n\n`);

            await executeTool({ model_id: 'T-01', context: 'Test.' });

            expect(mockApi.logger!.warn).toHaveBeenCalledWith(
                expect.stringContaining('deprecated')
            );
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
});
