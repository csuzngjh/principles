import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 导入待测试的函数
import { loadModelIndex } from '../../src/tools/model-index.js';
import type { OpenClawPluginApi } from '../../src/openclaw-sdk.js';

describe('loadModelIndex', () => {
    let tempDir: string;
    let mockApi: OpenClawPluginApi;

    beforeEach(() => {
        // 创建临时目录
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-index-test-'));
        
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
        // 清理临时目录
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('边界情况', () => {
        it('当 workspaceDir 为 undefined 时，应返回默认消息', () => {
            const result = loadModelIndex(undefined, mockApi);
            
            expect(result).toBe('（暂无扩展思维模型）');
        });

        it('当 workspaceDir 为空字符串时，应返回默认消息', () => {
            const result = loadModelIndex('', mockApi);
            
            expect(result).toBe('（暂无扩展思维模型）');
        });
    });

    describe('索引文件存在', () => {
        it('应返回索引文件内容', () => {
            const modelsDir = path.join(tempDir, 'docs', 'models');
            fs.mkdirSync(modelsDir, { recursive: true });
            
            const indexContent = `# 扩展思维模型索引

| ID | 名称 | 适用场景 |
|----|------|----------|
| MARKETING_4P | 营销4P | 营销策略 |
`;
            fs.writeFileSync(path.join(modelsDir, '_INDEX.md'), indexContent);

            const result = loadModelIndex(tempDir, mockApi);
            
            expect(result).toContain('扩展思维模型索引');
            expect(result).toContain('MARKETING_4P');
        });
    });

    describe('索引文件不存在', () => {
        it('当 models 目录不存在时，应返回默认消息（无警告）', () => {
            const result = loadModelIndex(tempDir, mockApi);
            
            expect(result).toBe('（暂无扩展思维模型）');
            expect(mockApi.logger!.warn).not.toHaveBeenCalled();
        });

        it('当 models 目录存在但索引文件不存在时，应返回默认消息并输出警告日志', () => {
            const modelsDir = path.join(tempDir, 'docs', 'models');
            fs.mkdirSync(modelsDir, { recursive: true });
            
            // 创建一个模型文件，但不创建索引文件
            fs.writeFileSync(path.join(modelsDir, 'marketing_4p.md'), '# 营销4P模型');

            const result = loadModelIndex(tempDir, mockApi);
            
            expect(result).toBe('（暂无扩展思维模型）');
            expect(mockApi.logger!.warn).toHaveBeenCalledWith(
                expect.stringContaining('_INDEX.md not found')
            );
        });
    });

    describe('文件大小限制', () => {
        it('当索引文件超过 50KB 时，应返回默认消息并输出警告日志', () => {
            const modelsDir = path.join(tempDir, 'docs', 'models');
            fs.mkdirSync(modelsDir, { recursive: true });
            
            // 创建一个超过 50KB 的文件
            const largeContent = 'x'.repeat(51 * 1024);
            fs.writeFileSync(path.join(modelsDir, '_INDEX.md'), largeContent);

            const result = loadModelIndex(tempDir, mockApi);
            
            expect(result).toBe('（暂无扩展思维模型）');
            expect(mockApi.logger!.warn).toHaveBeenCalledWith(
                expect.stringContaining('Index file too large')
            );
        });

        it('当索引文件刚好 50KB 时，应正常返回内容', () => {
            const modelsDir = path.join(tempDir, 'docs', 'models');
            fs.mkdirSync(modelsDir, { recursive: true });
            
            // 创建一个刚好 50KB 的文件
            const exactContent = 'x'.repeat(50 * 1024);
            fs.writeFileSync(path.join(modelsDir, '_INDEX.md'), exactContent);

            const result = loadModelIndex(tempDir, mockApi);
            
            expect(result).toBe(exactContent);
        });
    });

    describe('错误处理', () => {
        it('当读取文件失败时，应返回默认消息并记录错误日志', () => {
            const modelsDir = path.join(tempDir, 'docs', 'models');
            fs.mkdirSync(modelsDir, { recursive: true });
            
            const indexPath = path.join(modelsDir, '_INDEX.md');
            
            // 创建一个目录而非文件，导致读取失败
            fs.mkdirSync(indexPath, { recursive: true });

            const result = loadModelIndex(tempDir, mockApi);
            
            expect(result).toBe('（暂无扩展思维模型）');
            expect(mockApi.logger!.warn).toHaveBeenCalledWith(
                expect.stringContaining('Failed to load model index')
            );
        });
    });

    describe('api 参数可选', () => {
        it('当 api 为 undefined 时，不应抛出错误', () => {
            const result = loadModelIndex(tempDir);
            
            expect(result).toBe('（暂无扩展思维模型）');
        });
    });

    describe('自定义路径支持', () => {
        it('应从配置文件读取自定义 modelsDir', () => {
            const stateDir = path.join(tempDir, 'memory', '.state');
            fs.mkdirSync(stateDir, { recursive: true });
            
            const config = {
                deep_reflection: {
                    modelsDir: 'custom-models'
                }
            };
            fs.writeFileSync(path.join(stateDir, 'pain_settings.json'), JSON.stringify(config));

            const customModelsDir = path.join(tempDir, 'custom-models');
            fs.mkdirSync(customModelsDir, { recursive: true });
            
            const indexContent = `# 自定义模型索引\n|CUSTOM|自定义模型|测试|`;
            fs.writeFileSync(path.join(customModelsDir, '_INDEX.md'), indexContent);

            const result = loadModelIndex(tempDir, mockApi);
            
            expect(result).toContain('自定义模型');
            expect(mockApi.logger!.debug).toHaveBeenCalledWith(
                expect.stringContaining('custom-models')
            );
        });

        it('支持绝对路径的自定义 modelsDir', () => {
            const stateDir = path.join(tempDir, 'memory', '.state');
            fs.mkdirSync(stateDir, { recursive: true });
            
            const absCustomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-models-'));
            
            const config = {
                deep_reflection: {
                    modelsDir: absCustomDir
                }
            };
            fs.writeFileSync(path.join(stateDir, 'pain_settings.json'), JSON.stringify(config));

            const indexContent = `# 绝对路径模型\n|ABS|绝对路径|测试|`;
            fs.writeFileSync(path.join(absCustomDir, '_INDEX.md'), indexContent);

            const result = loadModelIndex(tempDir, mockApi);
            
            expect(result).toContain('绝对路径');
            
            fs.rmSync(absCustomDir, { recursive: true, force: true });
        });

        it('当配置无效时应回退到默认路径', () => {
            const stateDir = path.join(tempDir, 'memory', '.state');
            fs.mkdirSync(stateDir, { recursive: true });
            
            const config = {
                deep_reflection: {
                    modelsDir: 123
                }
            };
            fs.writeFileSync(path.join(stateDir, 'pain_settings.json'), JSON.stringify(config));

            const result = loadModelIndex(tempDir, mockApi);
            
            expect(result).toBe('（暂无扩展思维模型）');
        });

        it('当自定义路径不存在时应返回默认消息', () => {
            const stateDir = path.join(tempDir, 'memory', '.state');
            fs.mkdirSync(stateDir, { recursive: true });
            
            const config = {
                deep_reflection: {
                    modelsDir: 'non-existent-path'
                }
            };
            fs.writeFileSync(path.join(stateDir, 'pain_settings.json'), JSON.stringify(config));

            const result = loadModelIndex(tempDir, mockApi);
            
            expect(result).toBe('（暂无扩展思维模型）');
        });
    });
});