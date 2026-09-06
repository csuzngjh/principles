#!/usr/bin/env node
/**
 * $pd-setup — per-workspace PD initialization for the Codex plugin.
 *
 * Steps (ADR-0020 §10.4; SPEC rev 2 §17 + G2A frozen disclosure, Slice D):
 *   1. Fail loud when Node < 20 or npm is unavailable (the plugin does not
 *      install a system runtime).
 *   2. Install the PINNED runtime (runtime-version.json) into the
 *      plugin-private PLUGIN_DATA/runtime — never into the project, never
 *      into ~/.codex global config.
 *   3. Initialize the workspace through the existing production command:
 *      `pd runtime init --confirm` (reuses the OpenClaw-grade path; no new
 *      bootstrap logic). Requires the pd CLI (npm i -g @principles/pd-cli).
 *   4. Codex conversation-ingestion consent (PRI-625): present the G2A
 *      frozen disclosure via `pd codex setup --show-disclosure` (the text
 *      always comes from the installed CLI — this script embeds no copy),
 *      then record the explicit decision through the same CLI. Declining
 *      leaves every governance surface unchanged; nothing here can enable
 *      ingestion without an explicit accept. --ingest accept|decline|skip
 *      forces non-interactive behavior; without a TTY the default is skip.
 *   5. Report flag + hook-trust state. Never silently modify unknown config.
 *
 * rc-9: every refusal prints a structured reason and next action.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('node:readline/promises');
const { ensurePluginData, locatePluginRoot, pdCliCommand, requireFlagValue } = require('./pd-locate.cjs');

function fail(reason, nextAction) {
  console.error(`[PD:setup] status=failed reason=${reason}`);
  console.error(`[PD:setup] nextAction=${nextAction}`);
  process.exitCode = 1;
}

function npmCliPath() {
  // Prefer invoking npm through the same Node binary (no shell, spaces-safe).
  const bundled = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(bundled)) return { node: process.execPath, args: [bundled] };
  // Fallback: the platform launcher. On Windows .cmd shims need a shell
  // (EINVAL otherwise); no user-controlled data appears in these args.
  return process.platform === 'win32'
    ? { node: 'npm.cmd', args: [], shell: true }
    : { node: 'npm', args: [] };
}

function runNpm(args, options) {
  const cli = npmCliPath();
  return spawnSync(cli.node, [...cli.args, ...args], { encoding: 'utf8', ...options, ...(cli.shell ? { shell: true } : {}) });
}

function parseArgs(argv) {
  const out = { pluginRoot: undefined, pluginData: undefined, workspace: undefined, skipInit: false, json: false, ingest: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--plugin-root') {
      const value = requireFlagValue(argv, i, '--plugin-root');
      if (!value.ok) return { error: value.reason, nextAction: value.nextAction };
      out.pluginRoot = value.value; i += 1;
    } else if (argv[i] === '--plugin-data') {
      const value = requireFlagValue(argv, i, '--plugin-data');
      if (!value.ok) return { error: value.reason, nextAction: value.nextAction };
      out.pluginData = value.value; i += 1;
    } else if (argv[i] === '--workspace') {
      const value = requireFlagValue(argv, i, '--workspace');
      if (!value.ok) return { error: value.reason, nextAction: value.nextAction };
      out.workspace = value.value; i += 1;
    } else if (argv[i] === '--skip-init') out.skipInit = true;
    else if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--ingest') {
      const value = requireFlagValue(argv, i, '--ingest');
      if (!value.ok) return { error: value.reason, nextAction: value.nextAction };
      if (value.value !== 'accept' && value.value !== 'decline' && value.value !== 'skip') {
        return { error: 'invalid_ingest_value', nextAction: 'Supported --ingest values: accept | decline | skip (default: interactive prompt; skip when no TTY).' };
      }
      out.ingest = value.value; i += 1;
    }
    else return { error: `unknown_argument:${argv[i]}`, nextAction: 'Supported: --plugin-root <dir> --plugin-data <dir> --workspace <dir> --skip-init --ingest accept|decline|skip --json' };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { fail(args.error, args.nextAction ?? 'Check the argument list.'); return; }
  const workspaceDir = path.resolve(args.workspace ?? process.cwd());

  // 1. Environment gate.
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(major) || major < 20) {
    fail(`node_version_unsupported:${process.versions.node}`, 'Install Node.js >= 20 (https://nodejs.org), restart Codex, and re-run $pd-setup.');
    return;
  }
  const npmProbe = runNpm(['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  if (npmProbe.status !== 0) {
    fail('npm_not_available', 'npm must be on PATH (it ships with Node.js). Verify with `npm --version` in a terminal, then re-run $pd-setup.');
    return;
  }

  // 2. Locate plugin + data dir, read pinned versions. ensurePluginData OWNS
  //    first-run creation of the data dir — Codex sets PLUGIN_DATA for hooks
  //    but never creates the directory (verified on-device, 0.147.0).
  const root = locatePluginRoot(args.pluginRoot);
  if (!root.ok) { fail(root.reason, root.nextAction); return; }
  const data = ensurePluginData(args.pluginData, root);
  if (!data.ok) { fail(data.reason, data.nextAction); return; }

  let pins;
  try {
    pins = JSON.parse(fs.readFileSync(path.join(root.pluginRoot, 'runtime-version.json'), 'utf8'));
  } catch (error) {
    fail(`runtime_version_file_invalid:${error.message.slice(0, 160)}`, 'Reinstall the plugin (codex plugin remove principles-disciple@principles && codex plugin add principles-disciple@principles).');
    return;
  }
  const desired = { codexAdapter: pins.codexAdapter, hostRuntime: pins.hostRuntime, core: pins.core };
  const missingPins = Object.entries(desired)
    .filter(([, value]) => typeof value !== 'string' || value.length === 0)
    .map(([key]) => key);
  if (missingPins.length > 0) {
    fail(`runtime_version_file_invalid:missing_pins:${missingPins.join(',')}`, 'Reinstall the plugin — its runtime-version.json is incomplete.');
    return;
  }
  const runtimeDir = path.join(data.pluginData, 'runtime');
  const markerPath = path.join(runtimeDir, '.pd-runtime.json');
  let installNeeded = true;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker.codexAdapter === desired.codexAdapter
      && marker.hostRuntime === desired.hostRuntime
      && marker.core === desired.core) installNeeded = false;
  } catch { /* no/broken marker → install */ }

  if (installNeeded) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'pd-plugin-runtime', private: true }, null, 2));
    const install = runNpm(
      [
        'install', '--no-audit', '--no-fund', '--loglevel=error', '--omit=dev',
        `@principles/codex-adapter@${desired.codexAdapter}`,
        `@principles/host-runtime@${desired.hostRuntime}`,
        `@principles/core@${desired.core}`,
      ],
      { cwd: runtimeDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 },
    );
    if (install.status !== 0) {
      fail(
        `runtime_install_failed:${String(install.stderr).slice(0, 300).replace(/\s+/g, ' ')}`,
        'Check network/npm access. If the @principles packages are not yet published, wait for the release announcement, then re-run $pd-setup.',
      );
      return;
    }
    fs.writeFileSync(markerPath, JSON.stringify({ ...desired, installedAt: new Date().toISOString() }, null, 2));
  }

  // Verify the runtime resolves from the installed location.
  const adapterEntry = path.join(runtimeDir, 'node_modules', '@principles', 'codex-adapter', 'dist', 'pd-hook.js');
  if (!fs.existsSync(adapterEntry)) {
    fail('runtime_install_incomplete', 'The adapter entry is missing after install. Re-run $pd-setup; if it repeats, remove the plugin data dir and retry.');
    return;
  }

  // 3. Workspace init through the existing production command.
  let initResult = 'skipped';
  if (!args.skipInit) {
    const pd = pdCliCommand();
    if (!pd) {
      fail('pd_cli_unavailable', 'Install the PD CLI globally first: npm install -g @principles/pd-cli — then re-run $pd-setup. (--skip-init skips this check.)');
      return;
    }
    const init = spawnSync(pd.command, [...pd.prefix, 'runtime', 'init', '--workspace', workspaceDir, '--confirm'], { encoding: 'utf8', timeout: 120_000 });
    if (init.error || init.status !== 0) {
      fail(
        `pd_runtime_init_failed:${(init.error ? init.error.message : String(init.stderr)).slice(0, 200).replace(/\s+/g, ' ')}`,
        'Reinstall the PD CLI (npm install -g @principles/pd-cli) and re-run $pd-setup. (--skip-init skips this check.)',
      );
      return;
    }
    initResult = 'initialized';
  }

  // 4. Codex conversation-ingestion consent (PRI-625, G2A frozen disclosure).
  //    The disclosure text ALWAYS comes from the installed pd CLI
  //    (`pd codex setup --show-disclosure`) — this script embeds no copy, so
  //    the CLI's guard-tested frozen text is the only source. The decision is
  //    applied by the same CLI (--accept/--decline), which records consent
  //    BEFORE the flag moves; declining leaves all governance unchanged.
  const pd = pdCliCommand();
  const consent = await runIngestionConsentStep(pd, workspaceDir, args);

  // 5. Report (never mutates unknown config).
  const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
  const report = {
    ok: true,
    pluginRoot: root.pluginRoot,
    pluginData: data.pluginData,
    runtime: desired,
    runtimeInstalled: !installNeeded ? 'already-present' : 'installed',
    workspace: workspaceDir,
    workspaceConfig: fs.existsSync(configPath) ? 'present' : 'absent (run pd runtime init without --skip-init, or create .pd/config.yaml)',
    workspaceInit: initResult,
    ingestionConsent: consent.outcome,
    ...(consent.note ? { ingestionConsentNote: consent.note } : {}),
    hookTrustNextAction: 'In Codex, run /hooks and trust the Principles Disciple hooks — hooks never execute until trusted.',
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('[PD:setup] ok');
    console.log(`  runtime   : @principles/codex-adapter@${desired.codexAdapter} + host-runtime@${desired.hostRuntime} + core@${desired.core} (${report.runtimeInstalled})`);
    console.log(`  workspace : ${workspaceDir} — config ${report.workspaceConfig}`);
    console.log(`  ingestion : ${report.ingestionConsent}${consent.note ? ` (${consent.note})` : ''}`);
    console.log(`  next      : ${report.hookTrustNextAction}`);
  }
}

/**
 * Slice D consent step. Never throws; every path returns a structured
 * outcome. `accepted`/`declined` are recorded decisions (the disclosure was
 * presented first); `skipped` mutates nothing.
 */
async function runIngestionConsentStep(pd, workspaceDir, args) {
  const skip = (note) => ({ outcome: 'skipped', ...(note ? { note } : {}) });
  if (!pd) return skip('pd_cli_unavailable — run `pd codex setup --workspace <dir>` after installing @principles/pd-cli');

  // Present the frozen disclosure (SSoT lives in the CLI). R1-1: the text is
  // presented on EVERY path that can record a decision — interactive prints
  // to stdout before the prompt; non-interactive prints to stderr (visible,
  // never pollutes the machine-readable stdout) so `--ingest accept` can
  // never record an unseen disclosure.
  const show = spawnSync(pd.command, [...pd.prefix, 'codex', 'setup', '--show-disclosure', '--workspace', workspaceDir], { encoding: 'utf8', timeout: 60_000 });
  if (show.error || show.status !== 0 || !show.stdout) {
    return skip('disclosure_unavailable — run `pd codex setup --show-disclosure` manually');
  }

  let decision;
  if (args.ingest === 'accept' || args.ingest === 'decline') decision = args.ingest;
  else if (args.ingest === 'skip') return skip();
  else if (process.stdin.isTTY) {
    process.stdout.write(show.stdout + '\n');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('是否开启 Codex 对话观察？ y = 开启（已读上述说明） / n = 保持关闭: ')).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') decision = 'accept';
      else if (answer === 'n' || answer === 'no') decision = 'decline';
      else return skip('no_explicit_decision — nothing was changed; re-run $pd-setup or `pd codex setup`');
    } finally {
      rl.close();
    }
  } else {
    process.stderr.write(show.stdout + '\n');
    return skip('no_tty — review the disclosure above, then pass --ingest accept|decline for non-interactive consent');
  }

  const apply = spawnSync(
    pd.command,
    [...pd.prefix, 'codex', 'setup', '--workspace', workspaceDir, decision === 'accept' ? '--accept' : '--decline', '--json'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  const stdout = typeof apply.stdout === 'string' ? apply.stdout.trim() : '';
  const lastLine = stdout.split('\n').findLast((line) => line.startsWith('{'));
  if (apply.error || apply.status !== 0 || !lastLine) {
    return { outcome: 'skipped', note: `consent_apply_failed:${String(apply.error ? apply.error.message : apply.status).slice(0, 80)} — run \`pd codex setup --workspace <dir>\` manually` };
  }
  try {
    const parsed = JSON.parse(lastLine);
    if (parsed.decision === 'granted' && parsed.status === 'ok') return { outcome: 'accepted' };
    if (parsed.decision === 'declined' && parsed.status === 'ok') return { outcome: 'declined' };
    return { outcome: 'skipped', note: `consent_apply_degraded:${String(parsed.reason ?? 'unknown').slice(0, 80)}` };
  } catch {
    return { outcome: 'skipped', note: 'consent_apply_output_invalid — run `pd codex setup` manually' };
  }
}

main().catch((error) => {
  fail(`setup_crashed:${error instanceof Error ? error.message.slice(0, 160) : String(error)}`, 'Re-run $pd-setup; if it repeats, report the reason above.');
});
