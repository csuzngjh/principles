import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { atomicWriteFileSync, normalizeCommandArgs } from '../utils/io.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';

 
function scanEnvironment(wctx: WorkspaceContext): any {
  const tools: Record<string, { available: boolean; version?: string }> = {};

  // PRI-569: one literal-binary execFileSync probe per tool — the binary is a
  // compile-time literal and args are constant, so there is no shell and no
  // injection surface (Mimosa write-gate requirement).
  const recordVersion = (name: string, version?: string): void => {
    tools[name] = { available: true, version: version?.trim() };
  };

  try {
    const lines = execFileSync('rg', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n');
    recordVersion('rg', lines[0]);
  } catch {
    tools['rg'] = { available: false };
  }

  try {
    const lines = execFileSync('sg', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n');
    recordVersion('sg', lines[0]);
  } catch {
    tools['sg'] = { available: false };
  }

  try {
    const lines = execFileSync('fd', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n');
    recordVersion('fd', lines[0]);
  } catch {
    tools['fd'] = { available: false };
  }

  try {
    const lines = execFileSync('qmd', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n');
    recordVersion('qmd', lines[0]);
  } catch {
    tools['qmd'] = { available: false };
  }

  try {
    const lines = execFileSync('ast-grep', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n');
    recordVersion('ast-grep', lines[0]);
  } catch {
    tools['ast-grep'] = { available: false };
  }

  try {
    const lines = execFileSync('shellcheck', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n');
    recordVersion('shellcheck', lines[0]);
  } catch {
    tools['shellcheck'] = { available: false };
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
    return { text: `❌ pd-bootstrap failed: ${err instanceof Error ? err.message : String(err)}` };
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
