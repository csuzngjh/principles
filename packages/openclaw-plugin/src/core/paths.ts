import * as path from 'path';

/**
 * Principles Disciple Directory Constants
 * Establishing a logical separation between Identity, State, and Memory.
 */
export const PD_DIRS = {
    /** 🧬 Core configuration, identity, and kernel rules (hidden) */
    IDENTITY: '.principles',
    
    /** 🧠 Deep Reflection mental models */
    MODELS: path.join('.principles', 'models'),
    
    /** ⚡ Volatile operational data, queues, and task status (hidden) */
    STATE: '.state',
    
    /** 💾 Historical records, logs, and long-term memory */
    MEMORY: 'memory',
    
    /** 🎯 Strategic objectives and focus areas */
    OKR: path.join('memory', 'okr'),

    /** 📁 Internal logs directory */
    LOGS: path.join('memory', 'logs'),

    /** 🧠 Session persistence directory */
    SESSIONS: path.join('.state', 'sessions'),

    /** 🩹 Semantic pain samples for L3 retrieval */
    PAIN_SAMPLES: path.join('memory', 'pain'),
};

/**
 * Standard File Path Mappings
 */
export const PD_FILES = {
    // Identity Layer
    PROFILE: path.join(PD_DIRS.IDENTITY, 'PROFILE.json'),
    PRINCIPLES: path.join(PD_DIRS.IDENTITY, 'PRINCIPLES.md'),
    THINKING_OS: path.join(PD_DIRS.IDENTITY, 'THINKING_OS.md'),
    KERNEL: path.join(PD_DIRS.IDENTITY, '00-kernel.md'),
    DECISION_POLICY: path.join(PD_DIRS.IDENTITY, 'DECISION_POLICY.json'),
    MODELS_DIR: PD_DIRS.MODELS,

    // State Layer
    STATE_DIR: PD_DIRS.STATE,
    EVOLUTION_QUEUE: path.join(PD_DIRS.STATE, 'evolution_queue.json'),
    EVOLUTION_DIRECTIVE: path.join(PD_DIRS.STATE, 'evolution_directive.json'),
    WORKBOARD: path.join(PD_DIRS.STATE, 'WORKBOARD.json'),
    AGENT_SCORECARD: path.join(PD_DIRS.STATE, 'AGENT_SCORECARD.json'),
    PAIN_FLAG: path.join(PD_DIRS.STATE, '.pain_flag'),
    SYSTEM_CAPABILITIES: path.join(PD_DIRS.STATE, 'SYSTEM_CAPABILITIES.json'),
    PAIN_SETTINGS: path.join(PD_DIRS.STATE, 'pain_settings.json'),
    PAIN_CANDIDATES: path.join(PD_DIRS.STATE, 'pain_candidates.json'),
    THINKING_OS_USAGE: path.join(PD_DIRS.STATE, 'thinking_os_usage.json'),
    SESSION_DIR: PD_DIRS.SESSIONS,
    DICTIONARY: path.join(PD_DIRS.STATE, 'pain_dictionary.json'),
    
    // Workflow Layer (Project Root)
    PLAN: 'PLAN.md',
    HEARTBEAT: 'HEARTBEAT.md',
    
    // Memory Layer
    SYSTEM_LOG: path.join(PD_DIRS.LOGS, 'SYSTEM.log'),
    MEMORY_MD: path.join(PD_DIRS.MEMORY, 'MEMORY.md'),
    REFLECTION_LOG: path.join(PD_DIRS.MEMORY, 'reflection-log.md'),
    USER_CONTEXT: path.join(PD_DIRS.MEMORY, 'USER_CONTEXT.md'),
    OKR_DIR: PD_DIRS.OKR,
    CURRENT_FOCUS: path.join(PD_DIRS.OKR, 'CURRENT_FOCUS.md'),
    WEEK_STATE: path.join(PD_DIRS.OKR, 'WEEK_STATE.json'),
    THINKING_OS_CANDIDATES: path.join(PD_DIRS.MEMORY, 'THINKING_OS_CANDIDATES.md'),
    SEMANTIC_PAIN: path.join(PD_DIRS.PAIN_SAMPLES, 'confusion_samples.md'),
};

/**
 * Resolves a PD file path within a given workspace.
 */
export function resolvePdPath(workspaceDir: string, fileKey: keyof typeof PD_FILES): string {
    return path.join(workspaceDir, PD_FILES[fileKey]);
}
