import * as fs from 'fs';
import * as path from 'path';
import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { PD_DIRS, PD_FILES, resolvePdPath } from './paths.js';

/**
 * Handles migration of Principles Disciple files from legacy directories
 * (docs/ and memory/.state/) to the new hidden directory structure (.principles/ and .state/).
 */
export function migrateDirectoryStructure(api: OpenClawPluginApi, workspaceDir: string): void {
    try {
        const legacyDocsDir = path.join(workspaceDir, 'docs');
        const legacyStateDir = path.join(workspaceDir, 'memory', '.state');
        
        // Comprehensive migration map covering ALL legacy locations
        const migrationMap: Array<{ legacy: string; newKey: keyof typeof PD_FILES }> = [
            // From docs/
            { legacy: path.join(legacyDocsDir, 'PROFILE.json'), newKey: 'PROFILE' },
            { legacy: path.join(legacyDocsDir, 'PRINCIPLES.md'), newKey: 'PRINCIPLES' },
            { legacy: path.join(legacyDocsDir, 'THINKING_OS.md'), newKey: 'THINKING_OS' },
            { legacy: path.join(legacyDocsDir, '00-kernel.md'), newKey: 'KERNEL' },
            { legacy: path.join(legacyDocsDir, 'DECISION_POLICY.json'), newKey: 'DECISION_POLICY' },
            { legacy: path.join(legacyDocsDir, 'PLAN.md'), newKey: 'PLAN' },
            { legacy: path.join(legacyDocsDir, 'evolution_queue.json'), newKey: 'EVOLUTION_QUEUE' },
            { legacy: path.join(legacyDocsDir, 'AGENT_SCORECARD.json'), newKey: 'AGENT_SCORECARD' },
            { legacy: path.join(legacyDocsDir, '.pain_flag'), newKey: 'PAIN_FLAG' },
            { legacy: path.join(legacyDocsDir, 'SYSTEM_CAPABILITIES.json'), newKey: 'SYSTEM_CAPABILITIES' },

            // From memory/.state/ (The hidden legacy state)
            { legacy: path.join(legacyStateDir, 'pain_dictionary.json'), newKey: 'DICTIONARY' },
            { legacy: path.join(legacyStateDir, 'pain_settings.json'), newKey: 'PAIN_SETTINGS' },
            { legacy: path.join(legacyStateDir, 'thinking_os_usage.json'), newKey: 'THINKING_OS_USAGE' },
            { legacy: path.join(legacyStateDir, 'pain_candidates.json'), newKey: 'PAIN_CANDIDATES' },
            { legacy: path.join(legacyStateDir, 'evolution_directive.json'), newKey: 'EVOLUTION_QUEUE' }, // Note: was occasionally there
            { legacy: path.join(legacyStateDir, 'sessions'), newKey: 'SESSION_DIR' },
        ];

        let migratedCount = 0;

        for (const entry of migrationMap) {
            if (fs.existsSync(entry.legacy)) {
                const newPath = resolvePdPath(workspaceDir, entry.newKey);
                const newDir = path.dirname(newPath);

                if (!fs.existsSync(newDir)) {
                    fs.mkdirSync(newDir, { recursive: true });
                }

                // If it's a file, rename it. If it's a directory (sessions), handle carefully.
                if (!fs.existsSync(newPath)) {
                    try {
                        fs.renameSync(entry.legacy, newPath);
                        api.logger.info(`[PD:Migration] Migrated ${path.basename(entry.legacy)} to ${newPath.replace(workspaceDir, '')}`);
                        migratedCount++;
                    } catch (renameErr) {
                        api.logger.error(`[PD:Migration] Failed to rename ${entry.legacy}: ${String(renameErr)}`);
                    }
                } else {
                    api.logger.warn(`[PD:Migration] Skipping ${path.basename(entry.legacy)}: already exists at destination.`);
                }
            }
        }

        if (migratedCount > 0) {
            api.logger.info(`[PD:Migration] Successfully migrated ${migratedCount} files/folders to new architecture.`);
        }

        // Final cleanup: Try to remove legacy state dir if empty
        if (fs.existsSync(legacyStateDir)) {
            try {
                const items = fs.readdirSync(legacyStateDir);
                if (items.length === 0) {
                    fs.rmdirSync(legacyStateDir);
                    api.logger.info(`[PD:Migration] Cleaned up empty legacy state directory: ${legacyStateDir.replace(workspaceDir, '')}`);
                }
            } catch (_e) {}
        }

    } catch (err) {
        api.logger.error(`[PD:Migration] Directory refactor migration failed: ${String(err)}`);
    }
}
