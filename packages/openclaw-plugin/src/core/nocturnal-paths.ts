/**
 * Nocturnal Paths — Canonical Path Registry for Sleep-Mode Reflection Artifacts
 * =============================================================================
 *
 * PURPOSE: Establishes a single source of truth for all nocturnal artifact paths.
 * Prevents path fragmentation and ensures consistent resolution across modules.
 *
 * ARCHITECTURE:
 *   Operator-facing  (read by agent, injected into prompts):
 *     memory/reflection-log.md       ← human-readable lessons, NOT training data
 *
 *   Nocturnal artifacts (structured, NOT injected into prompts):
 *     .state/nocturnal/samples/     ← decision-point JSON artifacts (Phase 2+)
 *     .state/nocturnal/memory/      ← short-term reflection memory (Phase 2+)
 *     .state/exports/orpo/          ← approved training pairs, immutable (Phase 3+)
 *
 * DESIGN CONSTRAINTS:
 * - Nocturnal samples are NEVER written to memory/reflection-log.md
 * - Prompt injection reads ONLY from memory/reflection-log.md
 * - Each nocturnal artifact category has its own subdirectory
 * - All paths go through this registry — no ad-hoc path construction
 *
 * USAGE:
 *   import { NocturnalPathResolver, NOCTURNAL_DIRS, NOCTURNAL_FILES } from './nocturnal-paths.js';
 *   const sampleDir = NocturnalPathResolver.samplesDir(workspaceDir);
 */

import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Directory Constants
// ---------------------------------------------------------------------------

export const NOCTURNAL_DIRS = {
    /** Root directory for all nocturnal reflection artifacts */
    ROOT: '.state/nocturnal',

    /**
     * Structured decision-point samples from nocturnal reflection.
     * Each file is a JSON artifact containing:
     *   - session snapshot reference
     *   - target principle
     *   - decision-point contrastive pair
     *   - arbiter approval status
     */
    SAMPLES: '.state/nocturnal/samples',

    /**
     * Short-term operator-facing reflection memory.
     * Written by nocturnal service, NOT injected into prompts directly.
     * Consumed by operator on next session start.
     */
    MEMORY: '.state/nocturnal/memory',

    /**
     * Nocturnal runtime bookkeeping (cooldowns, quotas).
     * NOTE: nocturnal-runtime.json is written to stateDir directly
     * (not under NOCTURNAL_DIRS.ROOT) for simpler migration.
     */
    // RUNTIME is in {stateDir}/nocturnal-runtime.json (not here)

    /**
     * Approved training pairs ready for export.
     * Immutable once written — never modified in place.
     * Consumed by external trainer (not the plugin).
     */
    EXPORTS: '.state/exports/orpo',
} as const;

// ---------------------------------------------------------------------------
// File Path Constants (within their respective directories)
// ---------------------------------------------------------------------------

export const NOCTURNAL_FILES = {
    /**
     * Arbiter review queue for pending samples.
     * Not written by nocturnal service directly — created during arbiter review.
     * Format: JSON array of sample refs pending approval.
     */
    REVIEW_QUEUE: '.state/nocturnal/review-queue.json',

    /**
     * Lineage metadata for all samples.
     * Written alongside each sample file for traceability.
     */
    LINEAGE_INDEX: '.state/nocturnal/samples/lineage-index.json',
} as const;

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

/**
 * Cross-platform path join for workspace-relative paths.
 * Handles Windows vs POSIX differences.
 */
function joinWorkspacePath(workspaceDir: string, relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(workspaceDir)) {
        // Windows
        return path.win32.join(workspaceDir, ...normalized.split('/'));
    }
    return path.posix.join(workspaceDir, ...normalized.split('/'));
}

/**
 * Resolves a nocturnal directory path within a workspace.
 */
export function resolveNocturnalDir(workspaceDir: string, dirKey: keyof typeof NOCTURNAL_DIRS): string {
    return joinWorkspacePath(workspaceDir, NOCTURNAL_DIRS[dirKey]);
}

/**
 * Resolves a nocturnal file path within a workspace.
 */
export function resolveNocturnalFile(workspaceDir: string, fileKey: keyof typeof NOCTURNAL_FILES): string {
    return joinWorkspacePath(workspaceDir, NOCTURNAL_FILES[fileKey]);
}

// ---------------------------------------------------------------------------
// NocturnalPathResolver — Fluent API for common resolutions
// ---------------------------------------------------------------------------

export const NocturnalPathResolver = {
    /**
     * Returns the samples directory path.
     * Creates the directory if it does not exist.
     */
    samplesDir(workspaceDir: string): string {
        const dir = resolveNocturnalDir(workspaceDir, 'SAMPLES');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    },

    /**
     * Returns the memory directory path.
     * Creates the directory if it does not exist.
     */
    memoryDir(workspaceDir: string): string {
        const dir = resolveNocturnalDir(workspaceDir, 'MEMORY');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    },

    /**
     * Returns the exports directory path.
     * Creates the directory if it does not exist.
     */
    exportsDir(workspaceDir: string): string {
        const dir = resolveNocturnalDir(workspaceDir, 'EXPORTS');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    },

    /**
     * Returns the path for a named sample file.
     * File is NOT created — caller decides when to write.
     */
    samplePath(workspaceDir: string, sampleId: string): string {
        const dir = resolveNocturnalDir(workspaceDir, 'SAMPLES');
        // Sanitize sampleId for filesystem
        const safeId = sampleId.replace(/[/\\:]/g, '_');
        return path.join(dir, `${safeId}.json`);
    },

    /**
     * Returns the path for nocturnal reflection memory.
     * This is the operator-facing summary written after each nocturnal run.
     */
    reflectionMemoryPath(workspaceDir: string): string {
        return path.join(
            resolveNocturnalDir(workspaceDir, 'MEMORY'),
            'reflection-memory.md'
        );
    },

    /**
     * Lists all sample files in the samples directory.
     * Returns absolute paths sorted by modification time (newest first).
     */
    listSamples(workspaceDir: string): string[] {
        const dir = resolveNocturnalDir(workspaceDir, 'SAMPLES');
        if (!fs.existsSync(dir)) {
            return [];
        }
        try {
            return fs.readdirSync(dir)
                .filter(f => f.endsWith('.json'))
                .map(f => path.join(dir, f))
                .sort((a, b) => fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime());
        } catch {
            return [];
        }
    },

    /**
     * Lists all approved sample files ready for export.
     * Filters to samples with status === 'approved'.
     */
    listApprovedSamples(workspaceDir: string): string[] {
        return this.listSamples(workspaceDir).filter(samplePath => {
            try {
                const content = fs.readFileSync(samplePath, 'utf-8');
                const sample = JSON.parse(content);
                return sample.status === 'approved';
            } catch {
                return false;
            }
        });
    },
} as const;

// ---------------------------------------------------------------------------
// Constants for documentation / external reference
// ---------------------------------------------------------------------------

/**
 * Complete path map for reference.
 * These mirror the keys in NOCTURNAL_DIRS and NOCTURNAL_FILES.
 */
export const NOCTURNAL_PATH_DESCRIPTIONS: Record<string, string> = {
    '.state/nocturnal/samples/':      'Structured decision-point JSON artifacts (not injected into prompts)',
    '.state/nocturnal/memory/':       'Short-term operator-facing reflection memory (not prompt-injected)',
    '.state/exports/orpo/':           'Approved training pairs, immutable after export',
    '.state/nocturnal/review-queue.json': 'Pending sample review queue',
    'memory/reflection-log.md':       'Operator-facing human-readable lessons (INJECTED into prompts)',
};

/**
 * IMPORTANT: memory/reflection-log.md is NOT a nocturnal artifact.
 * It is the pre-existing operator-facing reflection log, defined in paths.ts.
 * It is kept separate from nocturnal outputs by design.
 */
