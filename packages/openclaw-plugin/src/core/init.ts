import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { OpenClawPluginApi, PluginLogger } from '../openclaw-sdk.js';

/**
 * Ensures that the workspace has the necessary template files for Principles Disciple.
 * If a file is missing, it copies it from the plugin's internal templates directory.
 */
export function ensureWorkspaceTemplates(api: OpenClawPluginApi, workspaceDir: string, language: string = 'en') {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        
        // 1. Copy common workspace templates
        const commonTemplatesDir = path.resolve(__dirname, '..', '..', 'templates', 'workspace');
        if (fs.existsSync(commonTemplatesDir)) {
            api.logger.info(`[PD] Checking common workspace templates in ${workspaceDir}...`);
            copyMissingFiles(commonTemplatesDir, workspaceDir, api);
        }

        // 2. Copy language-specific templates (SOUL.md, HEARTBEAT.md, etc.)
        let langTemplatesDir = path.resolve(__dirname, '..', '..', 'templates', 'langs', language);
        if (!fs.existsSync(langTemplatesDir)) {
            api.logger.warn(`[PD] Language pack '${language}' not found. Falling back to 'en'.`);
            langTemplatesDir = path.resolve(__dirname, '..', '..', 'templates', 'langs', 'en');
        }
        
        if (fs.existsSync(langTemplatesDir)) {
            api.logger.info(`[PD] Initializing ${language} templates in ${workspaceDir}...`);
            copyMissingFiles(langTemplatesDir, workspaceDir, api);
        }
    } catch (err) {
        api.logger.error(`[PD] Failed to initialize workspace templates: ${String(err)}`);
    }
}

/**
 * Ensures that the state directory has the necessary files (like pain_dictionary.json).
 */
export function ensureStateTemplates(ctx: { logger: PluginLogger }, stateDir: string, language: string = 'en') {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        
        if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
        }

        // 1. Copy common state files
        const commonFiles = ['pain_settings.json'];
        for (const filename of commonFiles) {
            const templatePath = path.resolve(__dirname, '..', '..', 'templates', filename);
            const destPath = path.join(stateDir, filename);
            if (!fs.existsSync(destPath) && fs.existsSync(templatePath)) {
                fs.copyFileSync(templatePath, destPath);
                ctx.logger.info(`[PD] Initialized ${filename} in stateDir: ${destPath}`);
            }
        }

        // 2. Copy language-specific dictionary
        let dictTemplate = path.resolve(__dirname, '..', '..', 'templates', 'langs', language, 'pain_dictionary.json');
        if (!fs.existsSync(dictTemplate)) {
            dictTemplate = path.resolve(__dirname, '..', '..', 'templates', 'langs', 'en', 'pain_dictionary.json');
        }
        
        const dictDest = path.join(stateDir, 'pain_dictionary.json');
        if (!fs.existsSync(dictDest) && fs.existsSync(dictTemplate)) {
            fs.copyFileSync(dictTemplate, dictDest);
            ctx.logger.info(`[PD] Initialized pain dictionary in stateDir: ${dictDest} (Lang: ${language})`);
        }
    } catch (err) {
        ctx.logger.error(`[PD] Failed to initialize state templates: ${String(err)}`);
    }
}

function copyMissingFiles(srcDir: string, destDir: string, api: OpenClawPluginApi | { logger: PluginLogger }) {
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
                    if ('logger' in api) {
                        api.logger.info(`[PD] Initialized missing template: ${item}`);
                    }
                } catch (err) {
                    if ('logger' in api) {
                        api.logger.warn(`[PD] Failed to copy template ${item}: ${String(err)}`);
                    }
                }
            }
        }
    }
}
