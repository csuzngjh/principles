import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { OpenClawPluginApi, PluginLogger } from '../openclaw-sdk.js';
import { PD_DIRS } from './paths.js';
import { defaultContextConfig } from '../types.js';

/**
 * Default PROFILE.json content
 */
const DEFAULT_PROFILE = {
  name: "Principles Disciple Agent",
  version: "1.0.0",
  contextInjection: defaultContextConfig
};

const CORE_GUIDANCE_VERSION = 'pd-core-guidance-v2';
const CORE_GUIDANCE_FILES = new Set(['AGENTS.md', 'TOOLS.md']);

function getCoreGuidanceVersionMarker(): string {
    return `pd-core-guidance-version: ${CORE_GUIDANCE_VERSION}`;
}

function hasOutdatedCoreGuidance(file: string, content: string): boolean {
    if (!CORE_GUIDANCE_FILES.has(file)) return false;
    if (content.includes(getCoreGuidanceVersionMarker())) return false;
    if (content.includes('pd_spawn_agent')) return true;
    if (!content.includes('subagents')) return true;
    if (!content.includes('sessions_spawn')) return true;
    return false;
}

/**
 * Ensures that the workspace has the necessary template files for Principles Disciple.
 * This function flattens 'core' templates to the root so OpenClaw can find them.
 */
     
export function ensureWorkspaceTemplates(api: OpenClawPluginApi, workspaceDir: string, language = 'en') {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        
        // 1. Copy common workspace templates (e.g., docs/*)
        const commonTemplatesDir = path.resolve(__dirname, '..', '..', 'templates', 'workspace');
        if (fs.existsSync(commonTemplatesDir)) {
            api.logger.info(`[PD] Syncing workspace templates: ${workspaceDir}...`);
             
             
            copyRecursiveSync(commonTemplatesDir, workspaceDir, api);
        }

        // 2. Copy language-specific core templates (AGENTS.md, SOUL.md, etc.)
        // CRITICAL: These MUST be at the root of the workspace for OpenClaw to recognize them.
        let coreTemplatesDir = path.resolve(__dirname, '..', '..', 'templates', 'langs', language, 'core');
        if (!fs.existsSync(coreTemplatesDir)) {
            coreTemplatesDir = path.resolve(__dirname, '..', '..', 'templates', 'langs', 'zh', 'core');
        }
        
        if (fs.existsSync(coreTemplatesDir)) {
            api.logger.info(`[PD] Flattening ${language} core templates to workspace root...`);
            // We copy contents of 'core' directory directly to workspaceDir root
            const coreFiles = fs.readdirSync(coreTemplatesDir);
            for (const file of coreFiles) {
                const srcPath = path.join(coreTemplatesDir, file);
                const destPath = path.join(workspaceDir, file);
                
                // If it's a core file and we want to ensure latest templates are used
                // but don't want to destroy user custom data, we check if we should overwrite.
                // For now, we only copy if missing to be safe, but log it.
                if (!fs.existsSync(destPath)) {
                    fs.copyFileSync(srcPath, destPath);
                    api.logger.info(`[PD] Initialized core file: ${file}`);
                } else if (CORE_GUIDANCE_FILES.has(file)) {
                    const existingContent = fs.readFileSync(destPath, 'utf8');
                    if (hasOutdatedCoreGuidance(file, existingContent)) {
                        api.logger.warn(`[PD] Outdated core guidance detected in ${file}. Review the latest template guidance for peer sessions, subagents, and sessions_spawn routing.`);
                    }
                }
            }
        }

        // 3. Copy pain memory seed files
        const painTemplatesDir = path.resolve(__dirname, '..', '..', 'templates', 'langs', language, 'pain');
        const painDestDir = path.join(workspaceDir, PD_DIRS.PAIN_SAMPLES);
        
        if (fs.existsSync(painTemplatesDir)) {
            if (!fs.existsSync(painDestDir)) {
                fs.mkdirSync(painDestDir, { recursive: true });
            }
             
             
            copyRecursiveSync(painTemplatesDir, painDestDir, api);
        }

        // 4. Initialize PROFILE.json with default contextInjection config
        const principlesDir = path.join(workspaceDir, PD_DIRS.IDENTITY);
        const profilePath = path.join(principlesDir, 'PROFILE.json');
        
        if (!fs.existsSync(profilePath)) {
            // Ensure .principles directory exists
            if (!fs.existsSync(principlesDir)) {
                fs.mkdirSync(principlesDir, { recursive: true });
            }
            fs.writeFileSync(profilePath, JSON.stringify(DEFAULT_PROFILE, null, 2), 'utf-8');
            api.logger.info(`[PD] Initialized PROFILE.json with default contextInjection config`);
        }
    } catch (err) {
        api.logger.error(`[PD] Failed to initialize workspace templates: ${String(err)}`);
    }
}

/**
 * Standard recursive copy that preserves directory structure.
 * Special handling: maps 'okr' directory to 'memory/okr' for runtime compatibility.
 */
 
function copyRecursiveSync(srcDir: string, destDir: string, api: OpenClawPluginApi | { logger: PluginLogger }) {
    const items = fs.readdirSync(srcDir);

    for (const item of items) {
        const srcPath = path.join(srcDir, item);
        // Special mapping: okr -> memory/okr (runtime path expects memory/okr/)
        const destItemName = item === 'okr' ? path.join('memory', 'okr') : item;
        const destPath = path.join(destDir, destItemName);
        const stat = fs.statSync(srcPath);

        if (stat.isDirectory()) {
            if (!fs.existsSync(destPath)) {
                fs.mkdirSync(destPath, { recursive: true });
            }
            copyRecursiveSync(srcPath, destPath, api);
        } else {
            if (!fs.existsSync(destPath)) {
                // Ensure parent directory exists
                const destParent = path.dirname(destPath);
                if (!fs.existsSync(destParent)) {
                    fs.mkdirSync(destParent, { recursive: true });
                }
                fs.copyFileSync(srcPath, destPath);
                api.logger.info(`[PD] Copied: ${destItemName}`);
            }
        }
    }
}

/**
 * Ensures that the state directory has the necessary files (like pain_dictionary.json).
 */
export function ensureStateTemplates(ctx: { logger: PluginLogger }, stateDir: string, language = 'en') {
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
