import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceContext } from '../core/workspace-context.js';
const TOOLS_TO_SCAN = [
    { name: 'rg', cmd: ['rg', '--version'] },
    { name: 'sg', cmd: ['sg', '--version'] },
    { name: 'fd', cmd: ['fd', '--version'] },
    { name: 'qmd', cmd: ['qmd', '--version'] },
    { name: 'ast-grep', cmd: ['ast-grep', '--version'] },
    { name: 'shellcheck', cmd: ['shellcheck', '--version'] },
];
function scanEnvironment(wctx) {
    const tools = {};
    for (const tool of TOOLS_TO_SCAN) {
        try {
            const output = execSync(tool.cmd.join(' '), { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
            tools[tool.name] = {
                available: true,
                version: output.split('\n')[0].trim(),
            };
        }
        catch (_e) {
            tools[tool.name] = { available: false };
        }
    }
    const capabilities = {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        tools,
        timestamp: new Date().toISOString(),
    };
    const capsPath = wctx.resolve('SYSTEM_CAPABILITIES');
    const capsDir = path.dirname(capsPath);
    if (!fs.existsSync(capsDir)) {
        fs.mkdirSync(capsDir, { recursive: true });
    }
    fs.writeFileSync(capsPath, JSON.stringify(capabilities, null, 2), 'utf8');
    return capabilities;
}
export function handleBootstrapTools(ctx) {
    const workspaceDir = ctx.config?.workspaceDir || process.cwd();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
    try {
        const caps = scanEnvironment(wctx);
        const toolsMap = caps.tools;
        const available = Object.entries(toolsMap)
            .filter(([, data]) => data.available)
            .map(([name]) => `\`${name}\``)
            .join(', ');
        return {
            text: `🔍 Environment perception complete.\n` +
                `**Detected tools:** ${available || '(none)'}\n` +
                `**Platform:** ${process.platform}\n` +
                `Capabilities saved to \`.state/SYSTEM_CAPABILITIES.json\`.`,
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
            `2. Compare findings with current capabilities in \`.state/SYSTEM_CAPABILITIES.json\`.\n` +
            `3. Focus on tools that improve speed (like \`rg\`, \`sg\`), documentation (like \`qmd\`), or automation.\n` +
            `4. Output a "Tool Upgrade Proposal" with installation commands and justification.`,
    };
}
