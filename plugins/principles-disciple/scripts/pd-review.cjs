#!/usr/bin/env node
/**
 * $pd-review — open the existing owner review console for this workspace.
 *
 * Reuses `pd console open --workspace <root>` — the same approval UI the
 * OpenClaw host uses. No new approval channel is added (PRI-523 acceptance 6).
 * Read-only towards PD state: starting the console is the only side effect.
 */
'use strict';

const { spawn } = require('child_process');
const { locateWorkspace, pdCliCommand, requireFlagValue } = require('./pd-locate.cjs');

function fail(reason, nextAction) {
  console.error(`[PD:review] status=failed reason=${reason}`);
  console.error(`[PD:review] nextAction=${nextAction}`);
  process.exitCode = 1;
}

function main() {
  const argv = process.argv.slice(2);
  let workspaceArg;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace') {
      const value = requireFlagValue(argv, i, '--workspace');
      if (!value.ok) { fail(value.reason, value.nextAction); return; }
      workspaceArg = value.value; i += 1;
    } else { fail(`unknown_argument:${argv[i]}`, 'Supported: --workspace <dir>'); return; }
  }

  const ws = locateWorkspace(workspaceArg ?? process.cwd());
  if (!ws.ok) { fail(ws.reason, `${ws.nextAction} Review needs an initialized workspace.`); return; }

  const pd = pdCliCommand();
  if (!pd) {
    fail('pd_cli_unavailable', 'Install the PD CLI globally first: npm install -g @principles/pd-cli — then re-run $pd-review.');
    return;
  }
  const child = spawn(pd.command, [...pd.prefix, 'console', 'open', '--workspace', ws.workspaceDir], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (error) => {
    fail(`pd_console_failed:${error.message.slice(0, 160)}`, 'Reinstall the PD CLI (npm install -g @principles/pd-cli) and re-run $pd-review.');
  });
  child.unref();

  console.log('[PD:review] console launching');
  console.log(`  workspace : ${ws.workspaceDir}`);
  console.log('  next      : the console opens in your browser (default http://127.0.0.1:3100). Approve or reject pending principles/activations there; `pd activation list/approve/deactivate` remains the CLI fallback.');
}

main();
