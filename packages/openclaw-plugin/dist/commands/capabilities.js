import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
const TOOLS_TO_SCAN = [
    { name: 'rg', cmd: ['rg', '--version'] },
    { name: 'sg', cmd: ['sg', '--version'] },
    { name: 'fd', cmd: ['fd', '--version'] },
    { name: 'qmd', cmd: ['qmd', '--version'] },
    { name: 'claude', cmd: ['claude', '--version'] },
    { name: 'gemini', cmd: ['gemini', '--version'] },
    { name: 'agent-browser', cmd: ['agent-browser', '--version'] },
    { name: 'npm', cmd: ['npm', '--version'] },
    { name: 'python3', cmd: ['python3', '--version'] },
    { name: 'git', cmd: ['git', '--version'] },
    { name: 'gh', cmd: ['gh', '--version'] },
];
/** Cross-platform: `where` on Windows, `command -v` on POSIX */
function whichCmd(toolName) {
    if (process.platform === 'win32') {
        return `where ${toolName}`;
    }
    return `command -v ${toolName}`;
}
export function scanEnvironment(workspaceDir) {
    const capabilities = {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        tools: {},
    };
    const tools = capabilities.tools;
    for (const tool of TOOLS_TO_SCAN) {
        try {
            const versionOut = execSync(tool.cmd.join(' '), { stdio: 'pipe' })
                .toString()
                .split('\n')[0]
                .trim();
            const toolPath = execSync(whichCmd(tool.name), { stdio: 'pipe' })
                .toString()
                .trim()
                .split('\n')[0]; // `where` may return multiple lines
            tools[tool.name] = { available: true, version: versionOut, path: toolPath };
        }
        catch (_e) {
            tools[tool.name] = { available: false };
        }
    }
    const capsPath = path.join(workspaceDir, 'docs', 'SYSTEM_CAPABILITIES.json');
    const docsDir = path.dirname(capsPath);
    if (!fs.existsSync(docsDir)) {
        fs.mkdirSync(docsDir, { recursive: true });
    }
    fs.writeFileSync(capsPath, JSON.stringify(capabilities, null, 2), 'utf8');
    return capabilities;
}
export function handleBootstrapTools(ctx) {
    // workspaceDir is not in PluginCommandContext — we use the CWD as a fallback.
    // Ideally this is run from the project root. If OpenClaw ever exposes workspaceDir
    // in command context, switch to ctx.workspaceDir.
    const workspaceDir = process.cwd();
    try {
        const caps = scanEnvironment(workspaceDir);
        const toolsMap = caps.tools;
        const available = Object.entries(toolsMap)
            .filter(([, data]) => data.available)
            .map(([name]) => `\`${name}\``)
            .join(', ');
        return {
            text: `🔍 Environment perception complete.\n` +
                `**Detected tools:** ${available || '(none)'}\n` +
                `**Platform:** ${process.platform}\n` +
                `Capabilities saved to \`docs/SYSTEM_CAPABILITIES.json\`.`,
        };
    }
    catch (err) {
        return { text: `❌ bootstrap-tools failed: ${err instanceof Error ? err.message : String(err)}` };
    }
}
export function handleResearchTools(ctx) {
    const category = ctx.args?.trim() || "modern high-performance CLI tools for coding and architecture";
    return {
        text: `🚀 **Tool Evolution Research Initiated**\n\n` +
            `**Instructions for Agent:**\n` +
            `1. Use \`google_web_search\` or \`web_search_exa\` to find the latest tools in the category: "${category}".\n` +
            `2. Compare findings with current capabilities in \`docs/SYSTEM_CAPABILITIES.json\`.\n` +
            `3. Focus on tools that improve speed (like \`rg\`, \`sg\`), documentation (like \`qmd\`), or automation.\n` +
            `4. Output a "Tool Upgrade Proposal" with installation commands and justification.`,
    };
}
