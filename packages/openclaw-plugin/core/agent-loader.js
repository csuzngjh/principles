/**
 * Agent Definition Loader
 *
 * Parses agent definitions from agents/*.md files.
 * These definitions are used to construct extraSystemPrompt for subagent runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
// ESM-compatible __dirname with fallback for test environments
let __dirname;
try {
    const __filename = fileURLToPath(import.meta.url);
    __dirname = path.dirname(__filename);
}
catch {
    // Fallback for test environments where import.meta.url may not work
    __dirname = process.cwd();
}
/**
 * Parse markdown file with YAML frontmatter
 */
function parseMarkdown(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
        return { frontmatter: {}, body: content };
    }
    const frontmatter = {};
    const frontmatterText = match[1];
    const body = match[2];
    // Simple YAML-like parsing
    let currentKey = '';
    let currentArray = null;
    frontmatterText.split('\n').forEach(line => {
        // Array item
        if (line.match(/^\s*-\s+/)) {
            if (currentArray !== null) {
                const value = line.replace(/^\s*-\s+/, '').trim();
                currentArray.push(value);
            }
            return;
        }
        // Key-value pair
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
            const key = line.slice(0, colonIndex).trim();
            const value = line.slice(colonIndex + 1).trim();
            if (value === '') {
                // Start of array
                currentKey = key;
                currentArray = [];
                frontmatter[key] = currentArray;
            }
            else {
                // Simple value
                currentKey = '';
                currentArray = null;
                frontmatter[key] = value;
            }
        }
    });
    return { frontmatter, body };
}
/**
 * Resolve the agents directory path
 * Handles both development and installed scenarios
 */
function resolveAgentsDir() {
    // Try multiple locations
    const possiblePaths = [
        // Development: relative to dist/core/
        path.resolve(__dirname, '../../agents'),
        // Installed: relative to extension root
        path.resolve(__dirname, '../agents'),
        // Absolute fallback
        path.resolve(process.cwd(), 'agents'),
    ];
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    // Return default (may not exist)
    return possiblePaths[0];
}
/**
 * Load agent definition by name
 *
 * @param name - Agent name (e.g., 'explorer', 'diagnostician')
 * @returns Agent definition or null if not found
 */
export function loadAgentDefinition(name) {
    const agentsDir = resolveAgentsDir();
    const mdPath = path.join(agentsDir, `${name}.md`);
    if (!fs.existsSync(mdPath)) {
        return null;
    }
    try {
        const content = fs.readFileSync(mdPath, 'utf8');
        const { frontmatter, body } = parseMarkdown(content);
        // Extract tools as array (support both string and array formats)
        let tools;
        if (Array.isArray(frontmatter.tools)) {
            tools = frontmatter.tools;
        }
        else if (typeof frontmatter.tools === 'string') {
            tools = frontmatter.tools.split(',').map(s => s.trim()).filter(Boolean);
        }
        return {
            name: frontmatter.name || name,
            description: frontmatter.description || '',
            systemPrompt: body.trim(),
            tools,
            model: frontmatter.model,
            permissionMode: frontmatter.permissionMode,
            skills: frontmatter.skills,
        };
    }
    catch (err) {
        console.error(`[AgentLoader] Failed to load agent ${name}:`, err);
        return null;
    }
}
/**
 * List all available agents
 *
 * @returns Array of agent names
 */
export function listAvailableAgents() {
    const agentsDir = resolveAgentsDir();
    if (!fs.existsSync(agentsDir)) {
        return [];
    }
    try {
        const files = fs.readdirSync(agentsDir);
        return files
            .filter(f => f.endsWith('.md'))
            .map(f => path.basename(f, '.md'));
    }
    catch {
        return [];
    }
}
/**
 * Load all agent definitions
 *
 * @returns Map of agent name to definition
 */
export function loadAllAgents() {
    const agents = new Map();
    for (const name of listAvailableAgents()) {
        const def = loadAgentDefinition(name);
        if (def) {
            agents.set(name, def);
        }
    }
    return agents;
}
