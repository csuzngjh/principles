#!/usr/bin/env node
/**
 * Process entry for the `pd` command.
 *
 * The command tree lives in `./program.js` so that tests and other library
 * consumers can import it WITHOUT executing the CLI. This file is the only
 * place that parses argv, and it does so unconditionally.
 *
 * Why unconditional (regression introduced by #2555): every real entry reaches
 * the CLI through this file — `package.json#bin`, the installer's
 * `pd` / `pd.cmd` / `pd.ps1` shims, and any loader shim that wraps it
 * (`import 'file://…/dist/index.js'`). An `argv[1] === import.meta.url` guard
 * cannot see the loader-shim shape, because argv[1] is then the wrapper: the
 * process exits 0 having done nothing. Import safety is guaranteed by the
 * module boundary instead — import `./program.js` for the tree, never this
 * file.
 *
 * Usage recording lives here — the one place that owns the process lifecycle —
 * so every entry shape above is instrumented by construction. It records one
 * line per process and never changes the exit code (see cli-invocation-log.ts).
 */
import type { Command } from 'commander';
import { handleVersionFlag, program } from './program.js';
import {
  INVOCATION_SOURCE_ENV,
  recordCliInvocation,
  resolveRecordedWorkspace,
} from './services/cli-invocation-log.js';

export { buildPdProgram } from './program.js';

/** Full command path of the command whose action is about to run. */
function commandPath(action: Command): string {
  const parts: string[] = [];
  let current: Command | null = action;
  while (current !== null && current.parent !== null) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(' ');
}

let invokedCommand: string | null = null;
let recordedWorkspace: string | null = null;

program.hook('preAction', (_thisCommand, actionCommand) => {
  try {
    invokedCommand = commandPath(actionCommand);
    const rawOpts: unknown = actionCommand.opts();
    let workspace: string | undefined;
    if (typeof rawOpts === 'object' && rawOpts !== null) {
      const value: unknown = Reflect.get(rawOpts, 'workspace');
      if (typeof value === 'string') workspace = value;
    }
    recordedWorkspace = resolveRecordedWorkspace(workspace);
  } catch {
    // Recording must never break dispatch; unresolved fields stay UNKNOWN.
  }
});

const argv = process.argv.slice(2);
const versionFlagOnly = argv.includes('--version') || argv.includes('-V');

process.on('exit', (code: number) => {
  try {
    recordCliInvocation({
      workspaceDir: recordedWorkspace ?? resolveRecordedWorkspace(undefined),
      command: invokedCommand ?? (versionFlagOnly ? 'version' : null),
      exitCode: typeof code === 'number' ? code : null,
      rawSource: process.env[INVOCATION_SOURCE_ENV],
    });
  } catch {
    // Never let usage recording alter the process result.
  }
});

if (!handleVersionFlag(argv)) {
  program.parse();
}
