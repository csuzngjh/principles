import * as fs from 'fs';
import * as path from 'path';
import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { migrateWorkspaceGuidance, containsStalePlanMdGuidance } from '@principles/core/runtime-v2';

const WORKSPACE_GUIDANCE_FILES = [
    'AGENTS.md',
    'MEMORY.md',
] as const;

const PRINCIPLES_SUBDIR_FILES = [
    'THINKING_OS.md',
] as const;

const SKILLS_DIR = path.join('.principles', 'skills');
const PRINCIPLES_DIR = '.principles';
const BACKUP_SUFFIX = '.pre-pri286.bak';

interface MigrationError {
    file: string;
    error: string;
}

export interface MigrationResult {
    migratedFiles: string[];
    skippedFiles: string[];
    errors: Array<MigrationError>;
}

function readFileContent(filePath: string): string | null {
    try {
        const raw: unknown = fs.readFileSync(filePath, 'utf-8');
        if (typeof raw !== 'string') {
            return null;
        }
        return raw;
    } catch {
        return null;
    }
}

function writeBackup(filePath: string, content: string): boolean {
    const backupPath = filePath + BACKUP_SUFFIX;
    try {
        fs.writeFileSync(backupPath, content, 'utf-8');
        return true;
    } catch {
        return false;
    }
}

function discoverSkillFiles(workspaceDir: string): string[] {
    const skillsDir = path.join(workspaceDir, SKILLS_DIR);
    if (!fs.existsSync(skillsDir)) {
        return [];
    }
    try {
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        const skillFiles: string[] = [];
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
                if (fs.existsSync(skillMd)) {
                    skillFiles.push(skillMd);
                }
            }
        }
        return skillFiles;
    } catch {
        return [];
    }
}

function collectCandidateFiles(workspaceDir: string): string[] {
    const candidates: string[] = [];

    for (const filename of WORKSPACE_GUIDANCE_FILES) {
        candidates.push(path.join(workspaceDir, filename));
    }

    for (const filename of PRINCIPLES_SUBDIR_FILES) {
        candidates.push(path.join(workspaceDir, PRINCIPLES_DIR, filename));
    }

    const skillFiles = discoverSkillFiles(workspaceDir);
    candidates.push(...skillFiles);

    return candidates;
}

export function migrateStaleWorkspaceGuidance(
    api: OpenClawPluginApi,
    workspaceDir: string,
): MigrationResult {
    const result: MigrationResult = {
        migratedFiles: [],
        skippedFiles: [],
        errors: [],
    };

    const candidates = collectCandidateFiles(workspaceDir);

    for (const filePath of candidates) {
        const relativePath = path.relative(workspaceDir, filePath);

        if (!fs.existsSync(filePath)) {
            continue;
        }

        const content = readFileContent(filePath);
        if (content === null) {
            result.errors.push({
                file: relativePath,
                error: 'Failed to read file content',
            });
            continue;
        }

        if (!containsStalePlanMdGuidance(content, relativePath)) {
            result.skippedFiles.push(relativePath);
            continue;
        }

        const migrationResult = migrateWorkspaceGuidance(content, relativePath);
        if (!migrationResult.changed) {
            result.skippedFiles.push(relativePath);
            continue;
        }

        const migrated = migrationResult.migrated;

        const backupOk = writeBackup(filePath, content);
        if (!backupOk) {
            result.errors.push({
                file: relativePath,
                error: 'Failed to create backup file before migration',
            });
            continue;
        }

        try {
            fs.writeFileSync(filePath, migrated, 'utf-8');
            result.migratedFiles.push(relativePath);
            api.logger.info(`[PD:GuidanceMigration] Migrated ${relativePath} (backup at ${relativePath}${BACKUP_SUFFIX})`);
        } catch (writeErr: unknown) {
            const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
            result.errors.push({
                file: relativePath,
                error: `Failed to write migrated content: ${errMsg}`,
            });
            try {
                fs.writeFileSync(filePath, content, 'utf-8');
            } catch {
                api.logger.error(`[PD:GuidanceMigration] CRITICAL: Failed to restore original content for ${relativePath} after write failure`);
            }
        }
    }

    if (result.migratedFiles.length > 0) {
        api.logger.info(`[PD:GuidanceMigration] Migration complete: ${result.migratedFiles.length} migrated, ${result.skippedFiles.length} skipped, ${result.errors.length} errors`);
    }

    return result;
}
