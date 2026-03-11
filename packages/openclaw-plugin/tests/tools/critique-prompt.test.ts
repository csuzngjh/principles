import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 导入待测试的函数
import { buildCritiquePromptV2 } from '../../src/tools/critique-prompt.js';
import type { OpenClawPluginApi } from '../../src/openclaw-sdk.js';

describe('buildCritiquePromptV2', () => {
    let tempDir: string;
    let mockApi: OpenClawPluginApi;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critique-prompt-test-'));
        
        mockApi = {
            id: "test-plugin",
            name: "Test Plugin",
            source: "local",
            config: {},
            runtime: {} as any,
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
        } as unknown as OpenClawPluginApi;
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('基本结构', () => {
        it('应包含 "Critical Analysis Engine" 标识', () => {
            const result = buildCritiquePromptV2({
                context: '测试上下文',
                workspaceDir: tempDir,
            });

            expect(result).toContain('Critical Analysis Engine');
        });

        it('应包含用户上下文', () => {
            const result = buildCritiquePromptV2({
                context: '这是一个关于营销策略的计划',
                workspaceDir: tempDir,
            });

            expect(result).toContain('这是一个关于营销策略的计划');
        });
    });

    describe('元认知模型说明', () => {
        it('应说明元认知模型已继承，不应重复列出 T-01 到 T-09', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
            });

            // 应包含继承说明
            expect(result).toContain('Meta-Cognitive Models');
            expect(result).toContain('inherited');
            expect(result).toContain('thinking_os');
            
            // 不应重复列出具体的元认知模型
            expect(result).not.toContain('T-01: Map Before Territory');
            expect(result).not.toContain('T-02: Constraints as Lighthouses');
            expect(result).not.toContain('T-09: Divide and Conquer');
        });
    });

    describe('模型选择指南', () => {
        it('应包含 Step 1/2/3 选择指南', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
            });

            expect(result).toContain('Model Selection Guidelines');
            expect(result).toContain('Step 1');
            expect(result).toContain('Step 2');
            expect(result).toContain('Step 3');
        });

        it('Step 1 应包含任务类型判断指导', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
            });

            expect(result).toContain('general planning');
            expect(result).toContain('domain-specific');
        });

        it('Step 3 应包含 Fallback 说明', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
            });

            expect(result).toContain('Fallback');
            expect(result).toContain('Meta-Cognitive Models');
        });
    });

    describe('模型索引注入', () => {
        it('当有索引文件时，应注入索引内容', () => {
            const modelsDir = path.join(tempDir, '.principles', 'models');
            fs.mkdirSync(modelsDir, { recursive: true });
            
            const indexContent = `# 扩展思维模型索引

| ID | 名称 | 适用场景 |
|----|------|----------|
| MARKETING_4P | 营销4P | 营销策略 |
`;
            fs.writeFileSync(path.join(modelsDir, '_INDEX.md'), indexContent);

            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
            });

            expect(result).toContain('Domain-Specific Models');
            expect(result).toContain('MARKETING_4P');
        });

        it('当无索引文件时，应显示默认消息', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
            });

            expect(result).toContain('暂无扩展思维模型');
        });
    });

    describe('深度指令', () => {
        it('depth=1 时应使用轻量分析指令', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
                depth: 1,
            });

            expect(result).toContain('quick');
        });

        it('depth=2 时应使用平衡分析指令', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
                depth: 2,
            });

            expect(result).toContain('balanced');
        });

        it('depth=3 时应使用详尽分析指令', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
                depth: 3,
            });

            expect(result).toContain('thorough');
        });

        it('默认 depth 应为 2', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
                // 不指定 depth
            });

            expect(result).toContain('balanced');
        });
    });

    describe('深度边界值验证', () => {
        it('depth=0 时应 fallback 到 2 并输出警告', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
                depth: 0,
                api: mockApi,
            });

            expect(result).toContain('balanced');
            expect(mockApi.logger!.warn).toHaveBeenCalledWith(
                expect.stringContaining('Invalid depth value 0')
            );
        });

        it('depth=4 时应 fallback 到 2 并输出警告', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
                depth: 4,
                api: mockApi,
            });

            expect(result).toContain('balanced');
            expect(mockApi.logger!.warn).toHaveBeenCalledWith(
                expect.stringContaining('Invalid depth value 4')
            );
        });

        it('depth=-1 时应 fallback 到 2', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
                depth: -1,
                api: mockApi,
            });

            expect(result).toContain('balanced');
        });

        it('depth=999 时应 fallback 到 2', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
                depth: 999,
                api: mockApi,
            });

            expect(result).toContain('balanced');
        });
    });

    describe('输出结构', () => {
        it('应包含要求的输出结构', () => {
            const result = buildCritiquePromptV2({
                context: '测试',
                workspaceDir: tempDir,
            });

            expect(result).toContain('Blind Spots');
            expect(result).toContain('Risk Warnings');
            expect(result).toContain('Alternative Approaches');
            expect(result).toContain('Recommendations');
            expect(result).toContain('Confidence Level');
        });
    });
});