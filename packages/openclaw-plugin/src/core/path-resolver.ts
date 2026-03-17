import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

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

const DEFAULT_WORKSPACE_SUBPATH = '.openclaw/workspace';

export const PD_ENV_VARS = {
    WORKSPACE_DIR: 'PD_WORKSPACE_DIR',
    STATE_DIR: 'PD_STATE_DIR',
    DEBUG: 'DEBUG',
} as const;

export const PD_ENV_DESCRIPTIONS: Record<keyof typeof PD_ENV_VARS, { desc: string; example: string }> = {
    WORKSPACE_DIR: {
        desc: 'Override the default workspace directory',
        example: 'PD_WORKSPACE_DIR=/home/user/my-workspace',
    },
    STATE_DIR: {
        desc: 'Override the default state directory (.state)',
        example: 'PD_STATE_DIR=/home/user/my-workspace/.state',
    },
    DEBUG: {
        desc: 'Enable debug logging for path resolution',
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
    private static extensionRoot: string | null = null;
    private workspaceDir: string | null = null;
    private stateDir: string | null = null;
    private readonly logger?: PathResolverOptions['logger'];
    private readonly normalizeWorkspace: boolean;
    private initialized = false;


    static setExtensionRoot(extensionRootPath: string): void {
        if (!extensionRootPath || !extensionRootPath.trim()) {
            return;
        }
        PathResolver.extensionRoot = path.resolve(extensionRootPath.trim());
    }

    static getExtensionRoot(): string | null {
        return PathResolver.extensionRoot;
    }

    constructor(options: PathResolverOptions = {}) {
        this.logger = options.logger;
        this.normalizeWorkspace = options.normalizeWorkspace ?? true;
        
        if (options.workspaceDir) {
            this.workspaceDir = options.workspaceDir;
            this.initialized = true;
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
        const extensionRoot = PathResolver.extensionRoot || path.resolve(process.cwd(), 'packages', 'openclaw-plugin');
        const extensionSrc = path.join(extensionRoot, 'src');
        const extensionDist = path.join(extensionRoot, 'dist');
        const evolutionWorker = fs.existsSync(extensionSrc)
            ? path.join(extensionSrc, 'service', 'evolution-worker.ts')
            : path.join(extensionDist, 'service', 'evolution-worker.js');

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
            'EXTENSION_ROOT': extensionRoot,
            'EXTENSION_SRC': extensionSrc,
            'EXTENSION_DIST': extensionDist,
            'EVOLUTION_WORKER': evolutionWorker,
            'LOGS': path.join(memory, 'logs'),
            'SYSTEM_LOG': path.join(memory, 'logs', 'SYSTEM.log'),
            'REFLECTION_LOG': path.join(memory, 'reflection-log.md'),
            'USER_CONTEXT': path.join(memory, 'USER_CONTEXT.md'),
            'OKR_DIR': path.join(memory, 'okr'),
            'CURRENT_FOCUS': path.join(memory, 'okr', 'CURRENT_FOCUS.md'),
            'WEEK_STATE': path.join(memory, 'okr', 'WEEK_STATE.json'),
            'THINKING_OS_CANDIDATES': path.join(memory, 'THINKING_OS_CANDIDATES.md'),
            'EVOLUTION_STREAM': path.join(memory, 'evolution.jsonl'),
            'EVOLUTION_LOCK': path.join(memory, '.locks', 'evolution'),
            'PRINCIPLE_BLACKLIST': path.join(state, 'principle_blacklist.json'),
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
