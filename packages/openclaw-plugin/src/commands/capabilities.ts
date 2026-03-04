import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { PluginCommandContext, PluginCommandResult } from '../types';

export function scanEnvironment(workspaceDir: string): Record<string, any> {
  const tools = [
    { name: 'rg', cmd: 'rg --version' },
    { name: 'sg', cmd: 'sg --version' },
    { name: 'fd', cmd: 'fd --version' },
    { name: 'npm', cmd: 'npm --version' },
    { name: 'python3', cmd: 'python3 --version' },
    { name: 'git', cmd: 'git --version' },
    { name: 'gh', cmd: 'gh --version' },
  ];

  const capabilities: Record<string, any> = {
    timestamp: new Date().toISOString(),
    tools: {} as Record<string, any>,
  };

  for (const tool of tools) {
    try {
      const output = execSync(tool.cmd, { stdio: 'pipe' }).toString().split('\n')[0];
      const pathStr = execSync(`command -v ${tool.name}`, { stdio: 'pipe' }).toString().trim();
      capabilities.tools[tool.name] = {
        available: true,
        version: output,
        path: pathStr,
      };
    } catch (e) {
      capabilities.tools[tool.name] = {
        available: false,
      };
    }
  }

  const capsPath = path.join(workspaceDir, 'docs', 'SYSTEM_CAPABILITIES.json');
  const dir = path.dirname(capsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(capsPath, JSON.stringify(capabilities, null, 2), 'utf8');

  return capabilities;
}

export function handleBootstrapTools(ctx: PluginCommandContext): PluginCommandResult {
  if (!ctx.workspaceDir) {
    return { text: "Error: No workspace directory provided." };
  }

  const caps = scanEnvironment(ctx.workspaceDir);
  const available = Object.entries(caps.tools)
    .filter(([_, data]: [any, any]) => data.available)
    .map(([name, _]) => `\`${name}\``)
    .join(', ');

  return {
    text: `Environment perception complete. Detected tools: ${available}. Capabilities saved to \`docs/SYSTEM_CAPABILITIES.json\`.`,
  };
}
