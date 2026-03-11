import * as path from 'path';

/**
 * Principles Disciple Directory Constants
 * Establishing a logical separation between Identity, State, and Memory.
 */
export const PD_DIRS = {
    /** 🧬 Core configuration, identity, and kernel rules (hidden) */
    IDENTITY: '.principles',
    
    /** ⚡ Volatile operational data, queues, and task status (hidden) */
    STATE: '.state',
    
    /** 📂 Legacy/Public documentation directory */
    DOCS: 'docs',
    
    /** 💾 Historical records, logs, and long-term memory */
    MEMORY: 'memory',
};

/**
 * Standard File Path Mappings
 */
export const PD_FILES = {
    // Identity Layer (Rooted in IDENTITY dir)
    PROFILE: path.join(PD_DIRS.IDENTITY, 'PROFILE.json'),
    PRINCIPLES: path.join(PD_DIRS.IDENTITY, 'PRINCIPLES.md'),
    THINKING_OS: path.join(PD_DIRS.IDENTITY, 'THINKING_OS.md'),
    KERNEL: path.join(PD_DIRS.IDENTITY, '00-kernel.md'),
    DECISION_POLICY: path.join(PD_DIRS.IDENTITY, 'DECISION_POLICY.json'),

    // State Layer (Rooted in STATE dir)
    EVOLUTION_QUEUE: path.join(PD_DIRS.STATE, 'evolution_queue.json'),
    WORKBOARD: path.join(PD_DIRS.STATE, 'WORKBOARD.json'),
    AGENT_SCORECARD: path.join(PD_DIRS.STATE, 'AGENT_SCORECARD.json'),
    PAIN_FLAG: path.join(PD_DIRS.STATE, '.pain_flag'),
    
    // Workflow Layer (Project Root for visibility)
    PLAN: 'PLAN.md',
    
    // Memory Layer
    SYSTEM_LOG: path.join(PD_DIRS.MEMORY, 'logs', 'SYSTEM.log'),
};

/**
 * Resolves a PD file path within a given workspace.
 */
export function resolvePdPath(workspaceDir: string, fileKey: keyof typeof PD_FILES): string {
    return path.join(workspaceDir, PD_FILES[fileKey]);
}
