import * as path from 'path';

const posixJoin = (...parts: string[]): string => path.posix.join(...parts);

function isWindowsPath(input: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(input) || input.startsWith('\\\\');
}

function joinWorkspacePath(workspaceDir: string, relativePath: string): string {
    if (isWindowsPath(workspaceDir)) {
        return path.win32.join(workspaceDir, relativePath);
    }
    if (workspaceDir.startsWith('/')) {
        return path.posix.join(workspaceDir, relativePath);
    }
    return path.join(workspaceDir, relativePath);
}

/**
 * Principles Disciple Directory Constants
 * Establishing a logical separation between Identity, State, and Memory.
 */
export const PD_DIRS = {
    IDENTITY: '.principles',
    MODELS: posixJoin('.principles', 'models'),
    STATE: '.state',
    MEMORY: 'memory',
    OKR: posixJoin('memory', 'okr'),
    LOGS: posixJoin('memory', 'logs'),
    SESSIONS: posixJoin('.state', 'sessions'),
    PAIN_SAMPLES: posixJoin('memory', 'pain'),
    LOCKS: posixJoin('memory', '.locks'),
    NOCTURNAL_SAMPLES: posixJoin('.state', 'nocturnal', 'samples'),
    NOCTURNAL_MEMORY: posixJoin('.state', 'nocturnal', 'memory'),
    NOCTURNAL_EXPORTS: posixJoin('.state', 'exports', 'orpo'),
    IMPL_CODE_DIR: posixJoin('.state', 'principles', 'implementations'),
};

/**
 * Standard File Path Mappings
 */
export const PD_FILES = {
    PROFILE: posixJoin(PD_DIRS.IDENTITY, 'PROFILE.json'),
    PRINCIPLES: posixJoin(PD_DIRS.IDENTITY, 'PRINCIPLES.md'),
    THINKING_OS: posixJoin(PD_DIRS.IDENTITY, 'THINKING_OS.md'),
    KERNEL: posixJoin(PD_DIRS.IDENTITY, '00-kernel.md'),
    DECISION_POLICY: posixJoin(PD_DIRS.IDENTITY, 'DECISION_POLICY.json'),
    MODELS_DIR: PD_DIRS.MODELS,

    STATE_DIR: PD_DIRS.STATE,
    EVOLUTION_QUEUE: posixJoin(PD_DIRS.STATE, 'evolution_queue.json'),
    EVOLUTION_DIRECTIVE: posixJoin(PD_DIRS.STATE, 'evolution_directive.json'),
    WORKBOARD: posixJoin(PD_DIRS.STATE, 'WORKBOARD.json'),
    AGENT_SCORECARD: posixJoin(PD_DIRS.STATE, 'AGENT_SCORECARD.json'),
    PAIN_FLAG: posixJoin(PD_DIRS.STATE, '.pain_flag'),
    SYSTEM_CAPABILITIES: posixJoin(PD_DIRS.STATE, 'SYSTEM_CAPABILITIES.json'),
    PAIN_SETTINGS: posixJoin(PD_DIRS.STATE, 'pain_settings.json'),
    PAIN_CANDIDATES: posixJoin(PD_DIRS.STATE, 'pain_candidates.json'),
    THINKING_OS_USAGE: posixJoin(PD_DIRS.STATE, 'thinking_os_usage.json'),
    TRAJECTORY_DB: posixJoin(PD_DIRS.STATE, 'trajectory.db'),
    TRAJECTORY_BLOBS_DIR: posixJoin(PD_DIRS.STATE, 'blobs'),
    EXPORTS_DIR: posixJoin(PD_DIRS.STATE, 'exports'),
    SESSION_DIR: PD_DIRS.SESSIONS,
    DICTIONARY: posixJoin(PD_DIRS.STATE, 'pain_dictionary.json'),
    PRINCIPLE_BLACKLIST: posixJoin(PD_DIRS.STATE, 'principle_blacklist.json'),
    NOCTURNAL_SAMPLES_DIR: PD_DIRS.NOCTURNAL_SAMPLES,
    NOCTURNAL_MEMORY_DIR: PD_DIRS.NOCTURNAL_MEMORY,
    NOCTURNAL_EXPORTS_DIR: PD_DIRS.NOCTURNAL_EXPORTS,
    IMPL_CODE_DIR: PD_DIRS.IMPL_CODE_DIR,

    PLAN: 'PLAN.md',
    MEMORY_MD: 'MEMORY.md',
    HEARTBEAT: 'HEARTBEAT.md',

    SYSTEM_LOG: posixJoin(PD_DIRS.LOGS, 'SYSTEM.log'),
    REFLECTION_LOG: posixJoin(PD_DIRS.MEMORY, 'reflection-log.md'),
    USER_CONTEXT: posixJoin(PD_DIRS.MEMORY, 'USER_CONTEXT.md'),
    OKR_DIR: PD_DIRS.OKR,
    CURRENT_FOCUS: posixJoin(PD_DIRS.OKR, 'CURRENT_FOCUS.md'),
    WEEK_STATE: posixJoin(PD_DIRS.OKR, 'WEEK_STATE.json'),
    THINKING_OS_CANDIDATES: posixJoin(PD_DIRS.MEMORY, 'THINKING_OS_CANDIDATES.md'),
    SEMANTIC_PAIN: posixJoin(PD_DIRS.PAIN_SAMPLES, 'confusion_samples.md'),
    EVOLUTION_STREAM: posixJoin(PD_DIRS.MEMORY, 'evolution.jsonl'),
    EVOLUTION_LOCK: posixJoin(PD_DIRS.LOCKS, 'evolution'),
};

/**
 * Resolves a PD file path within a given workspace.
 */
export function resolvePdPath(workspaceDir: string, fileKey: keyof typeof PD_FILES): string {
    return joinWorkspacePath(workspaceDir, PD_FILES[fileKey]);
}
