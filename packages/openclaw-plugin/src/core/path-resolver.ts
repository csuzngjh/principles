import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * ============================================================================
 * Principles Disciple - 路径解析器
 * ============================================================================
 * 
 * 【核心概念】
 * 
 * 1. 工作区 (Workspace): 智能体的"意识空间"，存放核心 MD 文件和配置
 *    - 示例: ~/clawd 或 ~/.openclaw/workspace
 *    - 包含: AGENTS.md, HEARTBEAT.md, .principles/, .state/ 等
 * 
 * 2. 状态目录 (State Dir): 运行时状态文件，自动管理
 *    - 示例: ~/clawd/.state
 *    - 包含: evolution_queue.json, trust_scorecard.json 等
 * 
 * 【路径解析优先级】（从高到低）
 * 
 * 1. 构造函数参数 workspaceDir（代码直接传入）
 * 2. 环境变量 PD_WORKSPACE_DIR（用户手动设置）
 * 3. 环境变量 OPENCLAW_WORKSPACE（OpenClaw 框架设置）
 * 4. 配置文件 ~/.openclaw/principles-disciple.json（安装脚本创建）
 * 5. 默认值 ~/.openclaw/workspace（最后兜底）
 * 
 * 【环境变量说明】
 * 
 * PD_WORKSPACE_DIR - 手动指定工作区目录
 *   用法: export PD_WORKSPACE_DIR=~/my-custom-workspace
 *   场景: 你想把智能体的"大脑"放在特定位置
 * 
 * PD_STATE_DIR - 手动指定状态目录
 *   用法: export PD_STATE_DIR=~/my-custom-workspace/.state
 *   场景: 通常不需要设置，会自动在 workspace 下创建 .state
 * 
 * OPENCLAW_WORKSPACE - OpenClaw 框架的工作区
 *   用法: 由 OpenClaw 自动设置
 *   场景: 当你使用 OpenClaw 时，它会告诉插件工作区在哪
 * 
 * DEBUG - 启用调试日志
 *   用法: export DEBUG=true
 *   场景: 排查路径问题时使用
 */

export interface PathResolverOptions {
    workspaceDir?: string;
    normalizeWorkspace?: boolean;
    logger?: {
        debug?: (msg: string) => void;
        info?: (msg: string) => void;
        warn?: (msg: string) => void;
        error?: (msg: string) => void;
    };
}

// 默认工作区路径: ~/.openclaw/workspace
const DEFAULT_WORKSPACE_SUBPATH = '.openclaw/workspace';

/**
 * 环境变量名称定义
 * 
 * 这些环境变量可以在启动 OpenClaw 时设置，用于覆盖默认路径
 */
export const PD_ENV_VARS = {
    // 手动指定工作区目录（最高优先级）
    // 示例: PD_WORKSPACE_DIR=/home/user/my-workspace openclaw gateway
    WORKSPACE_DIR: 'PD_WORKSPACE_DIR',
    
    // 手动指定状态目录
    // 示例: PD_STATE_DIR=/home/user/my-workspace/.state
    STATE_DIR: 'PD_STATE_DIR',
    
    // 启用调试模式
    // 示例: DEBUG=true openclaw gateway
    DEBUG: 'DEBUG',
} as const;

/**
 * 环境变量说明文档（用于帮助输出）
 */
export const PD_ENV_DESCRIPTIONS: Record<keyof typeof PD_ENV_VARS, { desc: string; example: string }> = {
    WORKSPACE_DIR: {
        desc: '指定智能体工作区目录（存放 MD 文件和配置）',
        example: 'PD_WORKSPACE_DIR=/home/user/clawd',
    },
    STATE_DIR: {
        desc: '指定状态文件目录（存放 JSON 运行时数据）',
        example: 'PD_STATE_DIR=/home/user/clawd/.state',
    },
    DEBUG: {
        desc: '启用路径解析调试日志',
        example: 'DEBUG=true',
    },
};

export function printEnvVarHelp(): void {
    console.log('\n📁 Principles Disciple - Environment Variables\n');
    console.log('You can customize directory paths using environment variables:\n');
    
    for (const [key, varName] of Object.entries(PD_ENV_VARS)) {
        const info = PD_ENV_DESCRIPTIONS[key as keyof typeof PD_ENV_VARS];
        console.log(`  ${varName}`);
        console.log(`    Description: ${info.desc}`);
        console.log(`    Example: ${info.example}`);
        console.log();
    }
    
    console.log('💡 Tips:');
    console.log('  - These can be set in your shell profile (~/.bashrc, ~/.zshrc)');
    console.log('  - Or passed when starting OpenClaw gateway');
    console.log('  - Example: PD_WORKSPACE_DIR=/custom/path openclaw-gateway start\n');
}

export interface PDConfig {
    workspace?: string;
    state?: string;
    debug?: boolean;
}

const PD_CONFIG_FILE = 'principles-disciple.json';
const PD_CONFIG_LOCATIONS = [
    path.join(process.cwd(), PD_CONFIG_FILE),
    path.join(os.homedir(), '.openclaw', PD_CONFIG_FILE),
    path.join(os.homedir(), '.principles', PD_CONFIG_FILE),
];

function findConfigFile(): string | null {
    for (const loc of PD_CONFIG_LOCATIONS) {
        if (fs.existsSync(loc)) {
            return loc;
        }
    }
    return null;
}

function loadConfigFromFile(): PDConfig | null {
    const configPath = findConfigFile();
    if (!configPath) {
        return null;
    }
    
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(content);
        console.log(`[PD:PathResolver] Loaded config from: ${configPath}`);
        return config;
    } catch (e) {
        console.warn(`[PD:PathResolver] Failed to load config from ${configPath}: ${String(e)}`);
        return null;
    }
}

export class PathResolver {
    private workspaceDir: string | null = null;
    private stateDir: string | null = null;
    private readonly logger?: PathResolverOptions['logger'];
    private readonly normalizeWorkspace: boolean;
    private initialized = false;

    constructor(options: PathResolverOptions = {}) {
        this.logger = options.logger;
        this.normalizeWorkspace = options.normalizeWorkspace ?? true;
        
        if (options.workspaceDir) {
            this.workspaceDir = options.workspaceDir;
        }
    }

    private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void {
        const prefix = '[PD:PathResolver]';
        const fullMsg = `${prefix} ${msg}`;
        
        if (process.env.DEBUG === 'true') {
            console.debug(fullMsg);
        }
        
        switch (level) {
            case 'debug':
                this.logger?.debug?.(fullMsg);
                break;
            case 'info':
                this.logger?.info?.(fullMsg) || console.log(fullMsg);
                break;
            case 'warn':
                this.logger?.warn?.(fullMsg) || console.warn(fullMsg);
                break;
            case 'error':
                this.logger?.error?.(fullMsg) || console.error(fullMsg);
                break;
        }
    }

    private detectWorkspaceDir(): string {
        const envWorkspace = process.env.PD_WORKSPACE_DIR;
        if (envWorkspace && envWorkspace.trim()) {
            this.log('info', `Using workspace from PD_WORKSPACE_DIR: ${envWorkspace}`);
            return envWorkspace.trim();
        }

        const envOpenclaw = process.env.OPENCLAW_WORKSPACE;
        if (envOpenclaw && envOpenclaw.trim()) {
            this.log('info', `Using workspace from OPENCLAW_WORKSPACE: ${envOpenclaw}`);
            return envOpenclaw.trim();
        }

        const fileConfig = loadConfigFromFile();
        if (fileConfig?.workspace) {
            this.log('info', `Using workspace from config file: ${fileConfig.workspace}`);
            return fileConfig.workspace;
        }

        const homeDir = os.homedir();
        const defaultWorkspace = path.join(homeDir, DEFAULT_WORKSPACE_SUBPATH);
        this.log('info', `Using default workspace: ${defaultWorkspace}`);
        
        return defaultWorkspace;
    }

    private normalizePath(inputPath: string): string {
        let normalized = path.resolve(inputPath);
        
        if (this.normalizeWorkspace) {
            const problematicSuffixes = ['/memory', '/docs'];
            
            for (const suffix of problematicSuffixes) {
                if (normalized.endsWith(suffix)) {
                    const parent = path.dirname(normalized);
                    this.log('warn', `Detected subdirectory suffix '${suffix}' in path. Normalized to parent: ${parent}`);
                    normalized = parent;
                    break;
                }
            }
        }
        
        return normalized;
    }

    normalizeWorkspacePath(inputPath: string): string {
        return this.normalizePath(inputPath);
    }

    getWorkspaceDir(): string {
        if (this.initialized && this.workspaceDir) {
            return this.workspaceDir;
        }

        let dir = this.detectWorkspaceDir();
        
        if (this.normalizeWorkspace) {
            const originalDir = dir;
            dir = this.normalizePath(dir);
            
            if (originalDir !== dir) {
                this.log('info', `Workspace path normalized: ${originalDir} -> ${dir}`);
            }
        }

        this.workspaceDir = dir;
        this.initialized = true;
        this.log('debug', `Final workspace directory: ${this.workspaceDir}`);
        
        return this.workspaceDir;
    }

    getStateDir(): string {
        if (this.stateDir) {
            return this.stateDir;
        }

        const envStateDir = process.env.PD_STATE_DIR;
        if (envStateDir && envStateDir.trim()) {
            this.stateDir = envStateDir.trim();
            this.log('info', `Using state directory from PD_STATE_DIR: ${this.stateDir}`);
            return this.stateDir;
        }

        const fileConfig = loadConfigFromFile();
        if (fileConfig?.state) {
            this.stateDir = fileConfig.state;
            this.log('info', `Using state directory from config file: ${this.stateDir}`);
            return this.stateDir;
        }

        this.stateDir = path.join(this.getWorkspaceDir(), '.state');
        this.log('debug', `Computed state directory: ${this.stateDir}`);
        
        return this.stateDir;
    }

    resolve(key: string): string {
        const workspace = this.getWorkspaceDir();
        const state = this.getStateDir();
        const memory = path.join(workspace, 'memory');
        
        const pathMap: Record<string, string> = {
            'PROFILE': path.join(workspace, '.principles', 'PROFILE.json'),
            'PRINCIPLES': path.join(workspace, '.principles', 'PRINCIPLES.md'),
            'THINKING_OS': path.join(workspace, '.principles', 'THINKING_OS.md'),
            'KERNEL': path.join(workspace, '.principles', '00-kernel.md'),
            'DECISION_POLICY': path.join(workspace, '.principles', 'DECISION_POLICY.json'),
            'MODELS_DIR': path.join(workspace, '.principles', 'models'),
            'PLAN': path.join(workspace, 'PLAN.md'),
            'AGENT_SCORECARD': path.join(state, 'AGENT_SCORECARD.json'),
            'PAIN_FLAG': path.join(state, '.pain_flag'),
            'EVOLUTION_QUEUE': path.join(state, 'evolution_queue.json'),
            'EVOLUTION_DIRECTIVE': path.join(state, 'evolution_directive.json'),
            'WORKBOARD': path.join(state, 'WORKBOARD.json'),
            'SYSTEM_CAPABILITIES': path.join(state, 'SYSTEM_CAPABILITIES.json'),
            'PAIN_SETTINGS': path.join(state, 'pain_settings.json'),
            'PAIN_CANDIDATES': path.join(state, 'pain_candidates.json'),
            'THINKING_OS_USAGE': path.join(state, 'thinking_os_usage.json'),
            'DICTIONARY': path.join(state, 'pain_dictionary.json'),
            'STATE_DIR': state,
            'LOGS': path.join(memory, 'logs'),
            'SYSTEM_LOG': path.join(memory, 'logs', 'SYSTEM.log'),
            'REFLECTION_LOG': path.join(memory, 'reflection-log.md'),
            'USER_CONTEXT': path.join(memory, 'USER_CONTEXT.md'),
            'OKR_DIR': path.join(memory, 'okr'),
            'CURRENT_FOCUS': path.join(memory, 'okr', 'CURRENT_FOCUS.md'),
            'WEEK_STATE': path.join(memory, 'okr', 'WEEK_STATE.json'),
            'THINKING_OS_CANDIDATES': path.join(memory, 'THINKING_OS_CANDIDATES.md'),
            'MEMORY': memory,
        };

        const resolved = pathMap[key];
        if (!resolved) {
            this.log('warn', `Unknown path key: ${key}`);
            throw new Error(`Unknown path key: ${key}`);
        }

        this.log('debug', `Resolved path for '${key}': ${resolved}`);
        
        return resolved;
    }

    ensureStateDir(): void {
        const stateDir = this.getStateDir();
        
        if (!fs.existsSync(stateDir)) {
            this.log('info', `Creating state directory: ${stateDir}`);
            fs.mkdirSync(stateDir, { recursive: true });
        }
    }

    static createFromHookContext(ctx: any): PathResolver {
        const resolver = new PathResolver();
        
        if (ctx?.workspaceDir) {
            let workspaceDir = ctx.workspaceDir;
            
            if (resolver.normalizeWorkspace) {
                workspaceDir = resolver.normalizePath(workspaceDir);
            }
            
            resolver.workspaceDir = workspaceDir;
            resolver.initialized = true;
            resolver.log('info', `Created from hook context with workspace: ${workspaceDir}`);
        }
        
        if (ctx?.stateDir) {
            resolver.stateDir = ctx.stateDir;
        }
        
        return resolver;
    }
}

export function createDefaultConfig(targetPath?: string): string {
    const defaultConfig: PDConfig = {
        workspace: path.join(os.homedir(), '.openclaw', 'workspace'),
        state: path.join(os.homedir(), '.openclaw', 'workspace', '.state'),
        debug: false,
    };
    
    const target = targetPath || path.join(os.homedir(), '.openclaw', PD_CONFIG_FILE);
    const dir = path.dirname(target);
    
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(target, JSON.stringify(defaultConfig, null, 2), 'utf8');
    
    console.log(`✅ Created default config at: ${target}`);
    console.log(`   You can edit this file to customize paths.`);
    
    return target;
}
