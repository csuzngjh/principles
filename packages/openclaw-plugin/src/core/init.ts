import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { OpenClawPluginApi } from '../openclaw-sdk.js';

/**
 * Ensures that the workspace has the necessary template files for Principles Disciple.
 * If a file is missing, it copies it from the plugin's internal templates directory.
 */
export function ensureWorkspaceTemplates(api: OpenClawPluginApi, workspaceDir: string) {
    try {
        // Resolve the internal templates directory relative to this file
        // dist/core/init.js -> ../../templates/workspace
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const templatesDir = path.resolve(__dirname, '..', '..', 'templates', 'workspace');

        if (!fs.existsSync(templatesDir)) {
            api.logger.warn(`[PD] Internal templates directory not found at: ${templatesDir}. Skipping auto-initialization.`);
            return;
        }

        api.logger.info(`[PD] Checking workspace templates in ${workspaceDir}...`);
        
        // Safety check: Don't initialize in the raw home directory unless explicitly intended
        if (workspaceDir === process.env.HOME || workspaceDir === '/') {
            api.logger.warn(`[PD] Workspace resolved to ${workspaceDir}. Skipping auto-init to prevent polluting home dir.`);
            return;
        }

        copyMissingFiles(templatesDir, workspaceDir, api);
    } catch (err) {
        api.logger.error(`[PD] Failed to initialize workspace templates: ${String(err)}`);
    }
}

function copyMissingFiles(srcDir: string, destDir: string, api: OpenClawPluginApi) {
    const items = fs.readdirSync(srcDir);

    for (const item of items) {
        const srcPath = path.join(srcDir, item);
        const destPath = path.join(destDir, item);
        const stat = fs.statSync(srcPath);

        if (stat.isDirectory()) {
            if (!fs.existsSync(destPath)) {
                fs.mkdirSync(destPath, { recursive: true });
            }
            copyMissingFiles(srcPath, destPath, api);
        } else {
            // Only copy if the file doesn't exist
            if (!fs.existsSync(destPath)) {
                try {
                    fs.copyFileSync(srcPath, destPath);
                    api.logger.info(`[PD] Initialized missing template: ${item}`);
                } catch (err) {
                    api.logger.warn(`[PD] Failed to copy template ${item}: ${String(err)}`);
                }
            }
        }
    }
}
