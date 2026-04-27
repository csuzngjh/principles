import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { atomicWriteFileSync, normalizeCommandArgs } from '../utils/io.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';

const TOOLS_TO_SCAN = [
  { name: 'rg', cmd: ['rg', '--version'] },
  { name: 'sg', cmd: ['sg', '--version'] },
  { name: 'fd', cmd: ['fd', '--version'] },
  { name: 'qmd', cmd: ['qmd', '--version'] },
  { name: 'ast-grep', cmd: ['ast-grep', '--version'] },
  { name: 'shellcheck', cmd: ['shellcheck', '--version'] },
];

 
function scanEnvironment(wctx: WorkspaceContext): any {
  const tools: Record<string, { available: boolean; version?: string }> = {};

  for (const tool of TOOLS_TO_SCAN) {
    try {
      const [versionLine] = execSync(tool.cmd.join(' '), { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n');
      tools[tool.name] = {
        available: true,
        version: versionLine.trim(),
      };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reason: catch parameter intentionally unused - we only care that the command failed
    } catch (_e) {
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
  atomicWriteFileSync(capsPath, JSON.stringify(capabilities, null, 2));

  return capabilities;
}

export function handleBootstrapTools(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'capabilities');
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });

  try {
    const caps = scanEnvironment(wctx);
    const toolsMap = caps.tools as Record<string, { available: boolean }>;
    const available = Object.entries(toolsMap)
      .filter(([, data]) => data.available)
      .map(([name]) => `\`${name}\``)
      .join(', ');

    return {
      text:
        `🔍 Environment perception complete.\n` +
        `**Detected tools:** ${available || '(none)'}\n` +
        `**Platform:** ${process.platform}\n` +
        `Capabilities saved to \`.state/SYSTEM_CAPABILITIES.json\`.`,
    };
  } catch (err) {
    return { text: `❌ bootstrap-tools failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function handleResearchTools(ctx: PluginCommandContext): PluginCommandResult {
  const category = normalizeCommandArgs(ctx.args).trim() || "modern high-performance CLI tools for coding and architecture";
  
  return {
    text:
      `🚀 **Tool Evolution Research Initiated**\n\n` +
      `**Instructions for Agent:**\n` +
      `1. Use \`google_web_search\` or \`web_search_exa\` to find the latest tools in the category: "${category}".\n` +
      `2. Compare findings with current capabilities in \`.state/SYSTEM_CAPABILITIES.json\`.\n` +
      `3. Focus on tools that improve speed (like \`rg\`, \`sg\`), documentation (like \`qmd\`), or automation.\n` +
      `4. Output a "Tool Upgrade Proposal" with installation commands and justification.`,
  };
}
