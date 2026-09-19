/**
 * Deployed bootstrap entry point (SPEC v0.3 §6.1).
 *
 * The installer copies this compiled file plus the update-executor dist into
 * `~/.pd/bootstrap/executor/` and registers it in `bootstrap.json`. It is the
 * only supported way to run update operations detached from the Console.
 */
import { main } from './update/bootstrap-executor.js';

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
