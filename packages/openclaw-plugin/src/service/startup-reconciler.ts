/**
 * Startup Reconciler — One-time validation and cleanup at pipeline startup
 * ===========================================================
 *
 * Runs before the first heartbeat cycle to ensure the nocturnal pipeline
 * enters a clean state. Three operations:
 * 1. Validate nocturnal-runtime.json integrity (reset if corrupted)
 * 2. Clear expired cooldown entries from taskFailureState
 * 3. Remove orphan .tmp files from the state directory
 *
 * All operations are non-destructive and idempotent.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readState, writeState, readStateSync } from './nocturnal-runtime.js';

export interface ReconciliationResult {
    /** Number of expired cooldown entries cleared */
    cooldownsCleared: number;
    /** List of orphan .tmp files removed */
    orphansRemoved: string[];
    /** Whether the state file was reset due to corruption */
    stateReset: boolean;
}

/**
 * Run startup reconciliation on the nocturnal pipeline state.
 *
 * 1. Validate state file — reset to defaults if corrupted
 * 2. Clear expired cooldowns from taskFailureState
 * 3. Remove orphan .tmp files from state directory
 *
 * @param stateDir - State directory containing nocturnal-runtime.json
 * @returns ReconciliationResult summary
 */
export async function reconcileStartup(stateDir: string): Promise<ReconciliationResult> {
    const result: ReconciliationResult = {
        cooldownsCleared: 0,
        orphansRemoved: [],
        stateReset: false,
    };

    // Step 1: Validate state file integrity
    // Check if the raw file is parseable; readStateSync silently returns defaults on corruption
    let state;
    const stateFilePath = path.join(stateDir, 'nocturnal-runtime.json');
    if (fs.existsSync(stateFilePath)) {
        try {
            const raw = fs.readFileSync(stateFilePath, 'utf8');
            JSON.parse(raw); // Validate JSON
            state = readStateSync(stateDir);
        } catch {
            // Corrupted JSON — readStateSync would return defaults, but we detect it here
            state = { principleCooldowns: {}, recentRunTimestamps: [] };
            await writeState(stateDir, state);
            result.stateReset = true;
        }
    } else {
        state = readStateSync(stateDir);
    }

    // Step 2: Clear expired cooldowns from taskFailureState
    if (state.taskFailureState) {
        let changed = false;
        for (const taskKind of Object.keys(state.taskFailureState)) {
            const entry = state.taskFailureState[taskKind];
            if (entry.cooldownUntil) {
                const cooldownEnd = new Date(entry.cooldownUntil).getTime();
                if (cooldownEnd < Date.now()) {
                    // Remove cooldownUntil but preserve escalation history
                    delete entry.cooldownUntil;
                    result.cooldownsCleared++;
                    changed = true;
                }
            }
        }
        if (changed) {
            await writeState(stateDir, state);
        }
    }

    // Step 3: Remove orphan .tmp files
    try {
        const files = fs.readdirSync(stateDir);
        for (const file of files) {
            if (file.endsWith('.tmp')) {
                const targetFile = file.slice(0, -4); // Remove .tmp suffix
                const targetPath = path.join(stateDir, targetFile);
                // Orphan = .tmp file whose target doesn't exist
                if (!fs.existsSync(targetPath)) {
                    fs.unlinkSync(path.join(stateDir, file));
                    result.orphansRemoved.push(file);
                }
            }
        }
    } catch {
        // Directory read failure — non-blocking
    }

    return result;
}
