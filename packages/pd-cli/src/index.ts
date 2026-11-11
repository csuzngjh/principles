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
 */
import { handleVersionFlag, program } from './program.js';

export { buildPdProgram } from './program.js';

if (!handleVersionFlag(process.argv.slice(2))) {
  program.parse();
}
