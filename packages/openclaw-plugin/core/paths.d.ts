/**
 * Principles Disciple Directory Constants
 * Establishing a logical separation between Identity, State, and Memory.
 */
export declare const PD_DIRS: {
    IDENTITY: string;
    MODELS: string;
    STATE: string;
    MEMORY: string;
    OKR: string;
    LOGS: string;
    SESSIONS: string;
    PAIN_SAMPLES: string;
    LOCKS: string;
};
/**
 * Standard File Path Mappings
 */
export declare const PD_FILES: {
    PROFILE: string;
    PRINCIPLES: string;
    THINKING_OS: string;
    KERNEL: string;
    DECISION_POLICY: string;
    MODELS_DIR: string;
    STATE_DIR: string;
    EVOLUTION_QUEUE: string;
    EVOLUTION_DIRECTIVE: string;
    WORKBOARD: string;
    AGENT_SCORECARD: string;
    PAIN_FLAG: string;
    SYSTEM_CAPABILITIES: string;
    PAIN_SETTINGS: string;
    PAIN_CANDIDATES: string;
    THINKING_OS_USAGE: string;
    TRAJECTORY_DB: string;
    TRAJECTORY_BLOBS_DIR: string;
    EXPORTS_DIR: string;
    SESSION_DIR: string;
    DICTIONARY: string;
    PRINCIPLE_BLACKLIST: string;
    PLAN: string;
    MEMORY_MD: string;
    HEARTBEAT: string;
    SYSTEM_LOG: string;
    REFLECTION_LOG: string;
    USER_CONTEXT: string;
    OKR_DIR: string;
    CURRENT_FOCUS: string;
    WEEK_STATE: string;
    THINKING_OS_CANDIDATES: string;
    SEMANTIC_PAIN: string;
    EVOLUTION_STREAM: string;
    EVOLUTION_LOCK: string;
};
/**
 * Resolves a PD file path within a given workspace.
 */
export declare function resolvePdPath(workspaceDir: string, fileKey: keyof typeof PD_FILES): string;
