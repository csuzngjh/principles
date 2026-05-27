import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface ConsoleOptions {
  workspace?: string;
  port?: string;
  noAuth?: boolean;
  json?: boolean;
}

function getConsoleDir(): string | null {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) return null;
  const consoleDir = path.join(homeDir, '.openclaw', 'extensions', 'principles-disciple', 'console');
  return fs.existsSync(consoleDir) ? consoleDir : null;
}

export async function handleConsole(opts: ConsoleOptions = {}): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const consoleDir = getConsoleDir();
  if (!consoleDir) {
    const msg = 'pd-console is not installed. Run: npx create-principles-disciple to install.';
    if (opts.json) {
      console.log(JSON.stringify({ error: msg, nextAction: 'npx create-principles-disciple' }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  const serverEntry = path.join(consoleDir, 'dist', 'server.js');
  if (!fs.existsSync(serverEntry)) {
    const msg = `Console server entry not found at ${serverEntry}. Re-run installer.`;
    if (opts.json) {
      console.log(JSON.stringify({ error: msg, nextAction: 'npx create-principles-disciple' }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  const port = opts.port || '3100';
  const args = [serverEntry, '--workspace', workspaceDir, '--port', port];
  if (opts.noAuth) args.push('--no-auth');

  if (opts.json) {
    console.log(JSON.stringify({
      status: 'starting',
      url: `http://localhost:${port}`,
      workspace: workspaceDir,
      nextAction: `Open http://localhost:${port} in your browser`,
    }));
  } else {
    console.log(`Starting pd-console on http://localhost:${port}`);
    console.log(`Workspace: ${workspaceDir}`);
    console.log('Press Ctrl+C to stop');
  }

  const child = spawn(process.execPath, args, {
    stdio: opts.json ? 'pipe' : 'inherit',
    env: { ...process.env },
  });

  const cleanup = () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      if (!opts.json) {
        console.error(`Console exited with code ${code}`);
      }
      process.exit(code);
    }
    process.exit(0);
  });
}
