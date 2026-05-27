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
      console.log(JSON.stringify({ success: false, reason: msg, nextAction: 'npx create-principles-disciple' }));
    } else {
      console.error(msg);
    }
    process.exit(1);
    return;
  }

  const serverEntry = path.join(consoleDir, 'dist', 'server.js');
  if (!fs.existsSync(serverEntry)) {
    const msg = `Console server entry not found at ${serverEntry}. Re-run installer.`;
    if (opts.json) {
      console.log(JSON.stringify({ success: false, reason: msg, nextAction: 'npx create-principles-disciple' }));
    } else {
      console.error(msg);
    }
    process.exit(1);
    return;
  }

  const port = opts.port || '3100';
  const host = '127.0.0.1';
  const args = [serverEntry, '--workspace', workspaceDir, '--port', port, '--host', host];
  if (opts.noAuth) args.push('--no-auth');

  const child = spawn(process.execPath, args, {
    stdio: opts.json ? 'pipe' : 'inherit',
    env: { ...process.env },
  });

  let startupConfirmed = false;

  child.on('error', (err) => {
    if (opts.json) {
      if (!startupConfirmed) {
        console.log(JSON.stringify({
          success: false,
          reason: `Console spawn failed: ${err.message}`,
          nextAction: 'Check Node.js installation and console server entry. Re-run: npx create-principles-disciple',
        }));
      }
    } else {
      console.error(`Console spawn failed: ${err.message}`);
    }
    process.exit(1);
    return;
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      if (opts.json) {
        if (!startupConfirmed) {
          console.log(JSON.stringify({
            success: false,
            reason: `Console exited with code ${code}`,
            nextAction: 'Check console logs above. Re-run: npx create-principles-disciple',
          }));
        }
      } else {
        console.error(`Console exited with code ${code}`);
      }
      process.exit(typeof code === 'number' ? code : 1);
      return;
    }
    process.exit(0);
  });

  setTimeout(() => {
    if (child.exitCode === null) {
      startupConfirmed = true;
      if (opts.json) {
        console.log(JSON.stringify({
          success: true,
          status: 'running',
          url: `http://${host}:${port}`,
          workspace: workspaceDir,
          nextAction: `Open http://${host}:${port} in your browser`,
        }));
      } else {
        console.log(`Starting pd-console on http://${host}:${port}`);
        console.log(`Workspace: ${workspaceDir}`);
        console.log('Press Ctrl+C to stop');
      }
    }
  }, 2000);

  const cleanup = () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
