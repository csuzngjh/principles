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
        copyMissingFiles(templatesDir, workspaceDir, api);
    } catch (err) {
        api.logger.error(`[PD] Failed to initialize workspace templates: ${String(err)}`);
    }
}

/**
 * Ensures that the state directory has the necessary files (like pain_dictionary.json).
 */
export function ensureStateTemplates(api: OpenClawPluginApi, stateDir: string) {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        
        // Templates to initialize
        const templates = ['pain_dictionary.json', 'pain_settings.json'];

        if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
        }

        for (const filename of templates) {
            const templatePath = path.resolve(__dirname, '..', '..', 'templates', filename);
            const destPath = path.join(stateDir, filename);

            if (!fs.existsSync(destPath)) {
                if (fs.existsSync(templatePath)) {
                    fs.copyFileSync(templatePath, destPath);
                    api.logger.info(`[PD] Initialized ${filename} in stateDir: ${destPath}`);
                } else {
                    api.logger.warn(`[PD] Template not found at: ${templatePath}`);
                }
            }
        }
    } catch (err) {
        api.logger.error(`[PD] Failed to initialize state templates: ${String(err)}`);
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
