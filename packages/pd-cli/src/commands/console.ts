import * as path from 'path';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import {
  getConsoleServerEntry,
  getConsoleWebIndex,
  getInstallLayoutPaths,
  resolveInstallLayout,
  type InstallLayoutMode,
} from '@principles/install-layout';
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
  /** Auth token for the Console. */
  token?: string;
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

function getConsoleDir(): { dir: string; mode: InstallLayoutMode } | null {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) return null;
  const paths = getInstallLayoutPaths(homeDir);
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8')) as unknown;
  } catch {
    manifest = undefined;
  }
  const resolved = resolveInstallLayout({
    homeDir,
    manifest,
    canonicalRuntimeExists: fs.existsSync(paths.runtimeDir),
    legacyExtensionExists: fs.existsSync(paths.openClawExtensionDir),
  });
  if (resolved.mode === 'missing') return null;
  const dir = resolved.mode === 'canonical' ? paths.consoleDir : path.join(paths.openClawExtensionDir, 'console');
  return { dir, mode: resolved.mode };
}

/**
 * Verify the console server's runtime dependency slots are resolvable.
 *
 * The console's dist statically imports `@principles/core/runtime-v2` and
 * `@principles/host-runtime`, and reads plugin governance exports from
 * `principles-disciple`. Each slot must be a real package (package.json present
 * AND dist/index.js present) — a dangling junction or an empty shell (package.json
 * without dist) makes the server crash with ERR_MODULE_NOT_FOUND at startup.
 *
 * Returns a human-readable description of the first broken slot, or undefined
 * when everything is resolvable.
 */
export function checkConsoleRuntimeDependencies(consoleDir: string): string | undefined {
  // These are the exact entry files the console server resolves at startup,
  // derived from each package's real `exports` map (not assumed dist/index.js):
  //   @principles/core/principle-tree-ledger → dist/principle-tree-ledger.js
  //   @principles/core/runtime-v2            → dist/runtime-v2/index.js
  //   @principles/host-runtime               → dist/index.js
  //   @principles/install-layout             → dist/index.js
  //   principles-disciple/governance-audit   → dist/governance-audit.js
  // Checking the real resolved entries (not just dist/index.js) catches broken
  // shells where package.json exists but the actual import target is missing.
  // One package can have multiple required entries (@principles/core).
  const slots: { pkg: string; entries: string[] }[] = [
    {
      pkg: '@principles/core',
      entries: [
        path.join('dist', 'principle-tree-ledger.js'),
        path.join('dist', 'runtime-v2', 'index.js'),
      ],
    },
    { pkg: '@principles/host-runtime', entries: [path.join('dist', 'index.js')] },
    { pkg: '@principles/install-layout', entries: [path.join('dist', 'index.js')] },
    { pkg: 'principles-disciple', entries: [path.join('dist', 'governance-audit.js')] },
  ];
  for (const slot of slots) {
    const base = path.join(consoleDir, 'node_modules', slot.pkg);
    const pkgJson = path.join(base, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      return `console/node_modules/${slot.pkg}/package.json is missing`;
    }
    for (const entry of slot.entries) {
      const entryFile = path.join(base, entry);
      if (!fs.existsSync(entryFile)) {
        return `console/node_modules/${slot.pkg}/${entry.replaceAll('\\', '/')} is missing (incomplete package)`;
      }
    }
  }
  return undefined;
}

export async function handleConsole(opts: ConsoleOptions = {}): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const consoleLocation = getConsoleDir();
  if (!consoleLocation) {
    const msg = 'pd-console is not installed. Run: npx create-principles-disciple to install.';
    if (opts.json) {
      console.log(JSON.stringify({ success: false, reason: msg, nextAction: 'npx create-principles-disciple' }));
    } else {
      console.error(msg);
    }
    process.exit(1);
    return;
  }

  const paths = getInstallLayoutPaths(process.env.HOME || process.env.USERPROFILE || '.');
  const serverEntry = getConsoleServerEntry(paths, consoleLocation.mode);
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

  // EP-06 regression guard (PR #1169): verify web UI bundle exists before launch.
  // Without dist/web/index.html the server returns 404 "Run npm run build:ui first".
  const webIndex = getConsoleWebIndex(paths, consoleLocation.mode);
  if (!fs.existsSync(webIndex)) {
    const msg = `Console web UI not found at ${webIndex}. The console bundle is corrupted. Re-run installer.`;
    if (opts.json) {
      console.log(JSON.stringify({ success: false, reason: msg, nextAction: 'npx create-principles-disciple' }));
    } else {
      console.error(msg);
    }
    process.exit(1);
    return;
  }

  // Runtime dependency integrity check: the console server statically imports
  // @principles/core/runtime-v2 and @principles/host-runtime, and the console
  // reads plugin governance exports from principles-disciple. When the OpenClaw
  // upgrade path refreshes the plugin bundle without re-running the PD installer
  // (2026-09: console_cli_exited_before_result), these node_modules slots can be
  // left as an empty shell (package.json without dist) or a dangling junction.
  // The server then crashes with ERR_MODULE_NOT_FOUND at startup, which the
  // Companion reports as the opaque console_cli_exited_before_result. Fail loud
  // here with the actionable repair command instead.
  const integrityError = checkConsoleRuntimeDependencies(consoleLocation.dir);
  if (integrityError) {
    const msg = `Console runtime dependency broken: ${integrityError}. Re-run installer to repair.`;
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
  const consoleLocation = getConsoleDir();
  if (!consoleLocation) {
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
  const paths = getInstallLayoutPaths(process.env.HOME || process.env.USERPROFILE || '.');
  const serverEntry = getConsoleServerEntry(paths, consoleLocation.mode);
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

  // EP-06 regression guard (PR #1169): verify web UI bundle exists before launch.
  // Without dist/web/index.html the server returns 404 "Run npm run build:ui first"
  // — a fatal first-impression bug for new users.
  const webIndex = getConsoleWebIndex(paths, consoleLocation.mode);
  if (!fs.existsSync(webIndex)) {
    const result: ConsoleLaunchResult = {
      status: 'failed',
      url: '',
      port: 0,
      host: '127.0.0.1',
      workspaceDir,
      reused: false,
      browserOpened: false,
      reason: 'console_web_ui_missing',
      nextAction: `Re-run installer: npx create-principles-disciple (expected ${webIndex})`,
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
  const rawToken = opts.token ?? process.env.PD_CONSOLE_TOKEN;
  const token = !opts.noAuth && rawToken?.trim() ? rawToken.trim() : undefined;

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
      ...(health.authenticationMode ? { authenticationMode: health.authenticationMode } : {}),
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
  // Runtime dependency integrity check — only here, NOT before the reuse
  // probe above. A healthy console already running (reused) has its modules
  // loaded in memory; broken disk slots (dangling junction / empty shell left
  // by an interrupted update) must not prevent reusing it. Only when we are
  // about to execute the local console bytes do the local bytes need to be
  // resolvable. The server statically imports @principles/core/runtime-v2 and
  // @principles/host-runtime, and reads plugin governance exports from
  // principles-disciple; without this check a broken install crashes with
  // ERR_MODULE_NOT_FOUND which the Companion reports as the opaque
  // console_cli_exited_before_result.
  const integrityError = checkConsoleRuntimeDependencies(consoleLocation.dir);
  if (integrityError) {
    const result: ConsoleLaunchResult = {
      status: 'failed',
      url: '',
      port: plan.port,
      host: plan.host,
      workspaceDir,
      reused: false,
      browserOpened: false,
      reason: 'console_runtime_dependency_broken',
      nextAction: `Re-run installer: npx create-principles-disciple (${integrityError})`,
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

  const args = [serverEntry, '--workspace', workspaceDir, '--port', String(plan.port), '--host', plan.host];
  if (opts.noAuth) args.push('--no-auth');
  if (opts.token) args.push('--token', opts.token);

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
  let readyAuthenticationMode: 'authenticated' | 'no_auth' | undefined;
  while (Date.now() < readyDeadline) {
    if (child.exitCode !== null) break;
    const h = await probeConsoleHealth({ host: plan.host, port: plan.port, timeoutMs: 1000, token });
    if (h.healthy) {
      ready = true;
      readyAuthenticationMode = h.authenticationMode;
      break;
    }
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

  // PRI-695: the caller's token presence decides the REQUIRED mode, but a
  // tokenless caller must not refuse a no_auth console — that combination is
  // the default post-install state (the installer auto-launches with
  // --no-auth) and the documented reopen command has no flags. Refusal is
  // reserved for the genuinely incompatible combination: a caller that
  // expects authenticated access against a no_auth server (governance writes
  // would be unauthenticated without the user realizing it).
  const expectedAuthenticationMode = token?.trim() ? 'authenticated' : 'no_auth';
  const authMismatch = readyAuthenticationMode !== expectedAuthenticationMode;
  const tokenlessCallerOnNoAuthServer = !token?.trim() && readyAuthenticationMode === 'no_auth';
  if (authMismatch && !tokenlessCallerOnNoAuthServer) {
    try { child.kill('SIGTERM'); } catch { /* child may already have exited */ }
    const result: ConsoleLaunchResult = {
      status: 'refused',
      url: '',
      port: plan.port,
      host: plan.host,
      workspaceDir,
      reused: false,
      browserOpened: false,
      authenticationMode: readyAuthenticationMode,
      reason: 'console_authentication_mode_mismatch',
      nextAction:
        'The Console is running without authentication (auto-launched default). ' +
        'Reopen it without a token to reuse it, or stop it and start with --token for authenticated access.',
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
    ...(readyAuthenticationMode ? { authenticationMode: readyAuthenticationMode } : {}),
    nextAction: browserOpened
      ? 'Browser opened to the Console. Press Ctrl+C to stop.'
      : `Open ${plan.url} in your browser. Press Ctrl+C to stop.`,
  };
  if (typeof child.pid === 'number') out.serverPid = child.pid;
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
      if (browserWarning) {
        console.log(`Browser not opened: ${browserWarning}`);
      }
      console.log(`Open ${plan.url} in your browser. Press Ctrl+C to stop.`);
    }
  }


}
