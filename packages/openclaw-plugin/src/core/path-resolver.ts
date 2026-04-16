/* eslint-disable no-console */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { PathResolutionError } from '../config/index.js';
import { atomicWriteFileSync } from '../utils/io.js';

export interface PathResolverOptions {
    workspaceDir?: string;
    normalizeWorkspace?: boolean;
    logger?: {
         
        debug?: (_msg: string) => void;
        info?: (_msg: string) => void;
        warn?: (_msg: string) => void;
        error?: (_msg: string) => void;
         
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

function isWindowsPath(inputPath: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(inputPath) || inputPath.startsWith('\\\\');
}

function isPosixAbsolutePath(inputPath: string): boolean {
    return inputPath.startsWith('/');
}

function getPathApi(inputPath: string): typeof path.posix | typeof path.win32 | typeof path {
    if (isWindowsPath(inputPath)) {
        return path.win32;
    }
    if (isPosixAbsolutePath(inputPath)) {
        return path.posix;
    }
    return path;
}

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
        const trimmed = extensionRootPath.trim();
        const pathApi = getPathApi(trimmed);
        PathResolver.extensionRoot = pathApi.normalize(trimmed);
    }

    static getExtensionRoot(): string | null {
        return PathResolver.extensionRoot;
    }

    constructor(options: PathResolverOptions = {}) {
        this.logger = options.logger;
        this.normalizeWorkspace = options.normalizeWorkspace ?? true;
        
        if (options.workspaceDir) {
            const original = options.workspaceDir;
            const normalized = this.normalizeWorkspace ? this.normalizePath(original) : original;
            if (original !== normalized) {
                this.log('info', `Workspace path normalized: ${original} -> ${normalized}`);
            }
            this.workspaceDir = normalized;
            this.initialized = true;
        }
    }

    private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void {
        const prefix = '[PD:PathResolver]';
        const fullMsg = `${prefix} ${msg}`;
        
        if (process.env.DEBUG === 'true') {
            this.logger?.debug?.(fullMsg);
        }
        
        switch (level) {
            case 'debug':
                this.logger?.debug?.(fullMsg);
                break;
            case 'info':
                this.logger?.info?.(fullMsg);
                break;
            case 'warn':
                this.logger?.warn?.(fullMsg);
                break;
            case 'error':
                this.logger?.error?.(fullMsg);
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
        const pathApi = getPathApi(inputPath);
        let normalized = pathApi === path ? path.resolve(inputPath) : pathApi.normalize(inputPath);
        
        if (this.normalizeWorkspace) {
            const problematicSuffixes = ['/memory', '/docs', '\\memory', '\\docs'];
            
            for (const suffix of problematicSuffixes) {
                if (normalized.endsWith(suffix)) {
                    const parent = pathApi.dirname(normalized);
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

        // If workspaceDir was explicitly provided via constructor, use workspace-based state dir
        // This ensures tests and programmatic usage don't get polluted by global config
        if (this.initialized && this.workspaceDir) {
            const pathApi = getPathApi(this.workspaceDir);
            this.stateDir = pathApi.join(this.workspaceDir, '.state');
            this.log('debug', `Using workspace-based state directory: ${this.stateDir}`);
            return this.stateDir;
        }

        const fileConfig = loadConfigFromFile();
        if (fileConfig?.state) {
            this.stateDir = fileConfig.state;
            this.log('info', `Using state directory from config file: ${this.stateDir}`);
            return this.stateDir;
        }

        const workspaceDir = this.getWorkspaceDir();
        const pathApi = getPathApi(workspaceDir);
        this.stateDir = pathApi.join(workspaceDir, '.state');
        this.log('debug', `Computed state directory: ${this.stateDir}`);

        return this.stateDir;
    }

    resolve(key: string): string {
        const workspace = this.getWorkspaceDir();
        const state = this.getStateDir();
        const workspacePath = getPathApi(workspace);
        const extensionRoot = PathResolver.extensionRoot || path.resolve(process.cwd(), 'packages', 'openclaw-plugin');
        const extensionPath = getPathApi(extensionRoot);
        const memory = workspacePath.join(workspace, 'memory');
        const extensionSrc = extensionPath.join(extensionRoot, 'src');
        const extensionDist = extensionPath.join(extensionRoot, 'dist');
        const evolutionWorker = fs.existsSync(extensionSrc)
            ? extensionPath.join(extensionSrc, 'service', 'evolution-worker.ts')
            : extensionPath.join(extensionDist, 'service', 'evolution-worker.js');

        const pathMap: Record<string, string> = {
            'PROFILE': workspacePath.join(workspace, '.principles', 'PROFILE.json'),
            'PRINCIPLES': workspacePath.join(workspace, '.principles', 'PRINCIPLES.md'),
            'THINKING_OS': workspacePath.join(workspace, '.principles', 'THINKING_OS.md'),
            'DECISION_POLICY': workspacePath.join(workspace, '.principles', 'DECISION_POLICY.json'),
            'MODELS_DIR': workspacePath.join(workspace, '.principles', 'models'),
            'PLAN': workspacePath.join(workspace, 'PLAN.md'),
            'AGENT_SCORECARD': workspacePath.join(state, 'AGENT_SCORECARD.json'),
            'PAIN_FLAG': workspacePath.join(state, '.pain_flag'),
            'EVOLUTION_QUEUE': workspacePath.join(state, 'evolution_queue.json'),
            'EVOLUTION_DIRECTIVE': workspacePath.join(state, 'evolution_directive.json'),
            'WORKBOARD': workspacePath.join(state, 'WORKBOARD.json'),
            'SYSTEM_CAPABILITIES': workspacePath.join(state, 'SYSTEM_CAPABILITIES.json'),
            'PAIN_SETTINGS': workspacePath.join(state, 'pain_settings.json'),
            'PAIN_CANDIDATES': workspacePath.join(state, 'pain_candidates.json'),
            'THINKING_OS_USAGE': workspacePath.join(state, 'thinking_os_usage.json'),
            'DICTIONARY': workspacePath.join(state, 'pain_dictionary.json'),
            'STATE_DIR': state,
            'EXTENSION_ROOT': extensionRoot,
            'EXTENSION_SRC': extensionSrc,
            'EXTENSION_DIST': extensionDist,
            'EVOLUTION_WORKER': evolutionWorker,
            'LOGS': workspacePath.join(memory, 'logs'),
            'SYSTEM_LOG': workspacePath.join(memory, 'logs', 'SYSTEM.log'),
            'REFLECTION_LOG': workspacePath.join(memory, 'reflection-log.md'),
            'USER_CONTEXT': workspacePath.join(memory, 'USER_CONTEXT.md'),
            'OKR_DIR': workspacePath.join(memory, 'okr'),
            'CURRENT_FOCUS': workspacePath.join(memory, 'okr', 'CURRENT_FOCUS.md'),
            'WEEK_STATE': workspacePath.join(memory, 'okr', 'WEEK_STATE.json'),
            'THINKING_OS_CANDIDATES': workspacePath.join(memory, 'THINKING_OS_CANDIDATES.md'),
            'EVOLUTION_STREAM': workspacePath.join(memory, 'evolution.jsonl'),
            'EVOLUTION_LOCK': workspacePath.join(memory, '.locks', 'evolution'),
            'PRINCIPLE_BLACKLIST': workspacePath.join(state, 'principle_blacklist.json'),
            'MEMORY': memory,
        };

        const resolved = pathMap[key];
        if (!resolved) {
            this.log('warn', `Unknown path key: ${key}`);
            throw new PathResolutionError(key);
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

    static createFromHookContext(ctx: Record<string, unknown>): PathResolver {
        const resolver = new PathResolver();

        if (ctx?.workspaceDir) {
            let workspaceDir = String(ctx.workspaceDir);

            if (resolver.normalizeWorkspace) {
                workspaceDir = resolver.normalizePath(workspaceDir);
            }

            resolver.workspaceDir = workspaceDir;
            resolver.initialized = true;
            resolver.log('info', `Created from hook context with workspace: ${workspaceDir}`);
        }

        if (ctx?.stateDir) {
            resolver.stateDir = String(ctx.stateDir);
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
    
    atomicWriteFileSync(target, JSON.stringify(defaultConfig, null, 2));
    
    console.log(`✅ Created default config at: ${target}`);
    console.log(`   You can edit this file to customize paths.`);

    return target;
}

// ── OpenClaw API Workspace Resolution ────────────────────────────

/**
 * Resolve workspace directory via OpenClaw's official API.
 *
 * Replaces the removed `api.workspaceDir` field.
 *
 * Priority: api.runtime.agent.resolveAgentWorkspaceDir(agentId)
 *           → PathResolver.getWorkspaceDir() (PD env vars, config file, default)
 *
 * @param api - Plugin API instance
 * @param agentId - Agent ID (defaults to 'main' if not provided)
 * @returns Resolved workspace directory, or `undefined` if all resolution paths fail
 */
export function resolveWorkspaceDirFromApi(
    api: OpenClawPluginApi | undefined,
    agentId?: string,
): string | undefined {
    if (!api) return undefined;

    // 1. Official API: api.runtime.agent.resolveAgentWorkspaceDir

    const officialAgent = (api.runtime as { agent?: { resolveAgentWorkspaceDir?: (cfg: unknown, id: string) => string } }).agent;

    if (officialAgent?.resolveAgentWorkspaceDir) {
        try {
            return officialAgent.resolveAgentWorkspaceDir(api.config, agentId ?? 'main');
        } catch {
            // Fall through to config check
        }
    }

    // 2. Direct config workspaceDir (for tests and programmatic usage)
    const cfgWorkspaceDir = (api.config as { workspaceDir?: string })?.workspaceDir;
    if (cfgWorkspaceDir && cfgWorkspaceDir.trim()) {
        return cfgWorkspaceDir.trim();
    }

    // 3. Fallback: PathResolver (PD_WORKSPACE_DIR env, config file, default)
    try {
        const pr = new PathResolver();
        return pr.getWorkspaceDir();
    } catch {
        return undefined;
    }
}
