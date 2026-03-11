import * as fs from 'fs';
import * as path from 'path';
import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { PD_DIRS, PD_FILES, resolvePdPath } from './paths.js';

/**
 * Handles migration of Principles Disciple files from legacy docs/ directory
 * to the new hidden directory structure (.principles/ and .state/).
 */
export function migrateDirectoryStructure(api: OpenClawPluginApi, workspaceDir: string): void {
    try {
        const legacyDocsDir = path.join(workspaceDir, 'docs');
        if (!fs.existsSync(legacyDocsDir)) return;

        // Map of legacy paths to new paths
        const migrationMap: Array<{ legacy: string; newKey: keyof typeof PD_FILES }> = [
            { legacy: path.join(legacyDocsDir, 'PROFILE.json'), newKey: 'PROFILE' },
            { legacy: path.join(legacyDocsDir, 'PRINCIPLES.md'), newKey: 'PRINCIPLES' },
            { legacy: path.join(legacyDocsDir, 'THINKING_OS.md'), newKey: 'THINKING_OS' },
            { legacy: path.join(legacyDocsDir, '00-kernel.md'), newKey: 'KERNEL' },
            { legacy: path.join(legacyDocsDir, 'DECISION_POLICY.json'), newKey: 'DECISION_POLICY' },
            { legacy: path.join(legacyDocsDir, 'evolution_queue.json'), newKey: 'EVOLUTION_QUEUE' },
            { legacy: path.join(legacyDocsDir, 'WORKBOARD.json'), newKey: 'WORKBOARD' },
            { legacy: path.join(legacyDocsDir, 'AGENT_SCORECARD.json'), newKey: 'AGENT_SCORECARD' },
            { legacy: path.join(legacyDocsDir, 'PLAN.md'), newKey: 'PLAN' },
        ];

        let migratedCount = 0;

        for (const entry of migrationMap) {
            if (fs.existsSync(entry.legacy)) {
                const newPath = resolvePdPath(workspaceDir, entry.newKey);
                const newDir = path.dirname(newPath);

                // Create destination directory if missing
                if (!fs.existsSync(newDir)) {
                    fs.mkdirSync(newDir, { recursive: true });
                }

                // Only move if destination doesn't exist yet (don't overwrite)
                if (!fs.existsSync(newPath)) {
                    fs.renameSync(entry.legacy, newPath);
                    api.logger.info(`[PD:Migration] Migrated ${path.basename(entry.legacy)} to ${newPath.replace(workspaceDir, '')}`);
                    migratedCount++;
                } else {
                    // If destination exists, we might want to backup or just delete the legacy one
                    // To be safe, we leave it alone but log a warning
                    api.logger.warn(`[PD:Migration] Skipping ${path.basename(entry.legacy)}: already exists at destination.`);
                }
            }
        }

        if (migratedCount > 0) {
            api.logger.info(`[PD:Migration] Successfully migrated ${migratedCount} files to new architecture.`);
        }

        // Cleanup empty legacy models directory if it was moved to templates but exists in docs
        const legacyModelsDir = path.join(legacyDocsDir, 'models');
        if (fs.existsSync(legacyModelsDir)) {
             api.logger.info(`[PD:Migration] Note: Legacy docs/models still exists. You may want to move custom models to .principles/models/ if applicable.`);
        }

    } catch (err) {
        api.logger.error(`[PD:Migration] Directory refactor migration failed: ${String(err)}`);
    }
}
