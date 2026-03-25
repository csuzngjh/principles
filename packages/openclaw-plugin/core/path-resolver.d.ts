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
export declare const PD_ENV_VARS: {
    readonly WORKSPACE_DIR: "PD_WORKSPACE_DIR";
    readonly STATE_DIR: "PD_STATE_DIR";
    readonly DEBUG: "DEBUG";
};
export declare const PD_ENV_DESCRIPTIONS: Record<keyof typeof PD_ENV_VARS, {
    desc: string;
    example: string;
}>;
export declare function printEnvVarHelp(): void;
export interface PDConfig {
    workspace?: string;
    state?: string;
    debug?: boolean;
}
export declare class PathResolver {
    private static extensionRoot;
    private workspaceDir;
    private stateDir;
    private readonly logger?;
    private readonly normalizeWorkspace;
    private initialized;
    static setExtensionRoot(extensionRootPath: string): void;
    static getExtensionRoot(): string | null;
    constructor(options?: PathResolverOptions);
    private log;
    private detectWorkspaceDir;
    private normalizePath;
    normalizeWorkspacePath(inputPath: string): string;
    getWorkspaceDir(): string;
    getStateDir(): string;
    resolve(key: string): string;
    ensureStateDir(): void;
    static createFromHookContext(ctx: any): PathResolver;
}
export declare function createDefaultConfig(targetPath?: string): string;
