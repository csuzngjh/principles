import * as path from 'path';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import {
  planConsoleLaunch,
  openBrowser,
  isLoopbackHost,
  normalizeLoopbackHost,
  probeConsoleHealth,
  type ConsoleLaunchResult,
} from '../services/console-launcher.js';

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

interface ConsoleOpenOptions {
  workspace?: string;
  port?: string;
  host?: string;
  json?: boolean;
  noAuth?: boolean;
  /** Skip browser opening even in non-JSON mode. */
  noBrowser?: boolean;
}

// ─── Backward-compatible top-level launcher (pd console) ─────────────────────

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

// ─── Seed-friendly launcher (pd console open) — PRI-300 ─────────────────────

/**
 * Launch (or reuse) the PD Console with seed-friendly defaults:
 *   - Default port 3100; auto-falls back to next free port
 *   - Reuses an existing healthy Console if one is already running
 *   - Opens the system browser on success (skipped in --json)
 *   - Refuses non-loopback hosts
 *   - Emits structured reason+nextAction on every failure path
 */
export async function handleConsoleOpen(opts: ConsoleOpenOptions = {}): Promise<void> {
  // 1) Loopback safety (ERR-049: refuse non-loopback) — check FIRST so we
  //    never reveal runtime information about non-loopback hosts and refuse before workspace resolution.
  const rawHost = opts.host ?? '127.0.0.1';
  // Normalize IPv6 bracket notation: [::1] → ::1 (ERR-049)
  const host = normalizeLoopbackHost(rawHost);
  if (!isLoopbackHost(host)) {
    const result: ConsoleLaunchResult = {
      status: 'refused',
      url: '',
      port: 0,
      host,
      workspaceDir: '',
      reused: false,
      browserOpened: false,
      reason: `Non-loopback host refused: '${host}'. Console binds to loopback only.`,
      nextAction: 'Use the default (127.0.0.1) or "localhost". Do not pass --host 0.0.0.0 or a LAN address.',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`error: ${result.reason}`);
      console.error(`next:   ${result.nextAction}`);
    }
    process.exit(1);
    return;
  }

  // 2) Resolve workspace (ERR-040: fail loud if missing)
  let workspaceDir: string;
  try {
    workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: ConsoleLaunchResult = {
      status: 'failed',
      url: '',
      port: 0,
      host,
      workspaceDir: '',
      reused: false,
      browserOpened: false,
      reason: 'workspace_missing',
      nextAction: 'Pass --workspace <path>, set PD_WORKSPACE_DIR, or run from within an initialized workspace.',
    };
    if (opts.json) {
      console.log(JSON.stringify({ ...result, message }, null, 2));
    } else {
      console.error(`error: ${message}`);
      console.error(`next: ${result.nextAction}`);
    }
    process.exit(1);
    return;
  }

  // 3) Strict port parsing
  let preferredPort = 3100;
  if (opts.port !== undefined) {
    if (!/^\d+$/.test(opts.port)) {
      const result: ConsoleLaunchResult = {
        status: 'failed',
        url: '',
        port: 0,
        host,
        workspaceDir,
        reused: false,
        browserOpened: false,
        reason: `Invalid --port: '${opts.port}'. Must be an integer 1..65535.`,
        nextAction: 'Use --port 3100 (default) or another valid port number.',
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`error: ${result.reason}`);
        console.error(`next:   ${result.nextAction}`);
      }
      process.exit(1);
      return;
    }
    preferredPort = Number(opts.port);
    if (preferredPort < 1 || preferredPort > 65535) {
      const result: ConsoleLaunchResult = {
        status: 'failed',
        url: '',
        port: 0,
        host,
        workspaceDir,
        reused: false,
        browserOpened: false,
        reason: `Invalid --port: '${opts.port}'. Must be an integer 1..65535.`,
        nextAction: 'Use --port 3100 (default) or another valid port number.',
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`error: ${result.reason}`);
        console.error(`next:   ${result.nextAction}`);
      }
      process.exit(1);
      return;
    }
  }

  // 3) Check that the console runtime is installed (ERR-040: fail loud if missing)
  const consoleDir = getConsoleDir();
  if (!consoleDir) {
    const result: ConsoleLaunchResult = {
      status: 'failed',
      url: '',
      port: 0,
      host: '127.0.0.1',
      workspaceDir,
      reused: false,
      browserOpened: false,
      reason: 'console_runtime_not_installed',
      nextAction: 'Run: npx create-principles-disciple',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`error: ${result.reason}`);
      console.error(`next:   ${result.nextAction}`);
    }
    process.exit(1);
    return;
  }
  const serverEntry = path.join(consoleDir, 'dist', 'server.js');
  if (!fs.existsSync(serverEntry)) {
    const result: ConsoleLaunchResult = {
      status: 'failed',
      url: '',
      port: 0,
      host: '127.0.0.1',
      workspaceDir,
      reused: false,
      browserOpened: false,
      reason: 'console_server_entry_missing',
      nextAction: `Re-run installer: npx create-principles-disciple (expected ${serverEntry})`,
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`error: ${result.reason}`);
      console.error(`next:   ${result.nextAction}`);
    }
    process.exit(1);
    return;
  }

  // 4) Read auth token for health probes (PD_CONSOLE_TOKEN)
  const token = process.env.PD_CONSOLE_TOKEN;

  // 5) Plan the launch (reuse or fresh bind)
  let plan;
  try {
    plan = await planConsoleLaunch({ workspaceDir, preferredPort, host, token });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: ConsoleLaunchResult = {
      status: 'failed',
      url: '',
      port: preferredPort,
      host,
      workspaceDir,
      reused: false,
      browserOpened: false,
      reason: 'launch_plan_error',
      nextAction: 'Inspect logs and retry.',
    };
    if (opts.json) {
      console.log(JSON.stringify({ ...result, message }, null, 2));
    } else {
      console.error(`error: launch plan failed: ${message}`);
    }
    process.exit(1);
    return;
  }

  if (plan.status === 'refused') {
    const result: ConsoleLaunchResult = {
      status: 'refused',
      url: '',
      port: plan.port,
      host: plan.host,
      workspaceDir,
      reused: false,
      browserOpened: false,
      reason: plan.reason,
      nextAction: plan.nextAction,
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`error: ${result.reason}`);
      console.error(`next:   ${result.nextAction}`);
    }
    process.exit(1);
    return;
  }

  if (plan.status === 'reused') {
    // Existing console — verify health one more time (already healthy from plan, but be safe)
    const health = await probeConsoleHealth({ host: plan.host, port: plan.port, token });
    if (!health.healthy) {
      const result: ConsoleLaunchResult = {
        status: 'failed',
        url: '',
        port: plan.port,
        host: plan.host,
        workspaceDir,
        reused: false,
        browserOpened: false,
        reason: `port_in_use_by_non_console: ${health.reason ?? 'health probe failed'}`,
        nextAction: 'Stop the conflicting process, or use --port <free> to bind a different port.',
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`error: ${result.reason}`);
        console.error(`next:   ${result.nextAction}`);
      }
      process.exit(1);
      return;
    }
    // Reused path — do not spawn. Optionally open browser.
    let browserOpened = false;
    let browserWarning: string | undefined;
    if (!opts.json && !opts.noBrowser) {
      const result = await openBrowser(plan.url);
      browserOpened = result.opened;
      if (!result.opened) {
        browserWarning = result.reason;
      }
    }
    const out: ConsoleLaunchResult = {
      status: 'reused',
      url: plan.url,
      port: plan.port,
      host: plan.host,
      workspaceDir,
      reused: true,
      browserOpened,
      nextAction: browserOpened
        ? 'Browser opened to the running Console.'
        : `Open ${plan.url} in your browser to access the Console.`,
    };
    if (browserWarning) out.reason = `browser_open_failed: ${browserWarning}`;
    if (opts.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`Reusing existing Console at ${plan.url}`);
      if (browserOpened) {
        console.log('Browser opened.');
      } else if (browserWarning) {
        console.log(`Browser not opened: ${browserWarning}`);
        console.log(out.nextAction);
      } else {
        console.log(out.nextAction);
      }
    }
    return;
  }

  // 5) Fresh spawn path
  const args = [serverEntry, '--workspace', workspaceDir, '--port', String(plan.port), '--host', plan.host];
  if (opts.noAuth) args.push('--no-auth');

  const child: ChildProcess = spawn(process.execPath, args, {
    stdio: opts.json ? 'pipe' : 'inherit',
    env: { ...process.env },
  });

  let resolved = false;
  const resolveOnce = (fn: () => void) => {
    if (resolved) return;
    resolved = true;
    fn();
  };

  const cleanup = () => {
    resolveOnce(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      process.exit(0);
    });
  };

  child.on('error', (err) => {
    resolveOnce(() => {
      const result: ConsoleLaunchResult = {
        status: 'failed',
        url: '',
        port: plan.port,
        host: plan.host,
        workspaceDir,
        reused: false,
        browserOpened: false,
        reason: `console_spawn_failed: ${err.message}`,
        nextAction: 'Check Node.js and package path configuration.',
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`error: ${result.reason}`);
      }
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      process.exit(1);
    });
  });

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // 7) Wait for console ready (bounded poll)
  const readyDeadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    if (child.exitCode !== null) break;
    const h = await probeConsoleHealth({ host: plan.host, port: plan.port, timeoutMs: 1000, token });
    if (h.healthy) { ready = true; break; }
    await sleep(250);
  }

  if (child.exitCode !== null && child.exitCode !== 0) {
    const result: ConsoleLaunchResult = {
      status: 'failed',
      url: '',
      port: plan.port,
      host: plan.host,
      workspaceDir,
      reused: false,
      browserOpened: false,
      reason: `console_exited_with_code_${child.exitCode}`,
      nextAction: 'Check console logs above. Re-run: npx create-principles-disciple',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`error: ${result.reason}`);
    }
    process.exit(typeof child.exitCode === 'number' ? child.exitCode : 1);
    return;
  }

  if (!ready) {
    // Clean up: kill the orphan child
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    const result: ConsoleLaunchResult = {
      status: 'failed',
      url: '',
      port: plan.port,
      host: plan.host,
      workspaceDir,
      reused: false,
      browserOpened: false,
      reason: 'console_health_check_timeout',
      nextAction: 'Increase timeout, free system resources, or re-run: npx create-principles-disciple',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`error: ${result.reason}`);
      console.error(`next:   ${result.nextAction}`);
    }
    process.exit(1);
    return;
  }

  // 7) Console is ready → optionally open browser, emit result, then keep child running
  let browserOpened = false;
  let browserWarning: string | undefined;
  if (!opts.json && !opts.noBrowser) {
    const r = await openBrowser(plan.url);
    browserOpened = r.opened;
    if (!r.opened) browserWarning = r.reason;
  }

  const out: ConsoleLaunchResult = {
    status: 'started',
    url: plan.url,
    port: plan.port,
    host: plan.host,
    workspaceDir,
    reused: false,
    browserOpened,
    nextAction: browserOpened
      ? 'Browser opened to the Console. Press Ctrl+C to stop.'
      : `Open ${plan.url} in your browser. Press Ctrl+C to stop.`,
  };
  if (plan.reason) out.reason = plan.reason;
  if (browserWarning) {
    out.reason = out.reason ? `${out.reason}; browser_open_failed: ${browserWarning}` : `browser_open_failed: ${browserWarning}`;
  }

  if (opts.json) {
    // Single JSON object on stdout, then keep child attached.
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`\nConsole ready: ${plan.url}`);
    console.log(`Workspace:    ${workspaceDir}`);
    if (plan.reason) console.log(`Note:         ${plan.reason}`);
    if (browserOpened) {
      console.log('Browser opened. Press Ctrl+C to stop.');
    } else {
      console.log(`Open ${plan.url} in your browser. Press Ctrl+C to stop.`);
    }
  }


}
