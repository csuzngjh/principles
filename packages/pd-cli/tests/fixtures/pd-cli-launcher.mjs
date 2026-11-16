/**
 * Phase 7.2 E2E — pd CLI launcher child.
 *
 * The parent test spawns THIS fixture with a fully literal argv (script path
 * only; dynamic values travel in PD_CLI_* environment variables), and the
 * launcher drives the REAL pd-cli production entry (packages/pd-cli/dist/
 * index.js — the same module the `pd` bin executes) by setting process.argv
 * and importing it. The child therefore exercises the actual command
 * handlers, real exit codes and real crash semantics (SIGKILL by the parent).
 *
 * Launch-safety (rc-1): the argument vector arrives as JSON in PD_CLI_ARGS;
 * every element is validated against a strict allowlist here — known flags
 * verbatim, values by charset + length — before anything runs. No shell is
 * involved anywhere (spawn with an argv array only, shell defaults to false).
 *
 * Env contract:
 *   PD_CLI_DIST_INDEX — absolute path to packages/pd-cli/dist/index.js
 *   PD_CLI_ARGS       — JSON array of CLI arguments (allowlist-validated)
 * Prints the CLI stdout/stderr passthrough; exits with the CLI's code
 * (handlers set process.exitCode / call process.exit themselves).
 */
import { pathToFileURL } from 'node:url';

const distIndex = process.env.PD_CLI_DIST_INDEX ?? '';
const rawArgs = process.env.PD_CLI_ARGS ?? '[]';

const FLAG_ALLOWLIST = new Set([
  'candidate', 'intake', 'review',
  '--candidate-id', '--workspace', '--decide', '--principle-id', '--reason', '--json',
  'reuse', 'create',
]);
const VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9:._\-~\\/ ]{0,240}$/;

let parsed;
try {
  parsed = JSON.parse(rawArgs);
} catch {
  console.error('pd-cli-launcher: PD_CLI_ARGS is not valid JSON');
  process.exit(2);
}
if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
  console.error('pd-cli-launcher: PD_CLI_ARGS must be a non-empty array (<=32)');
  process.exit(2);
}
for (const arg of parsed) {
  if (typeof arg !== 'string') {
    console.error('pd-cli-launcher: non-string CLI argument');
    process.exit(2);
  }
  if (!FLAG_ALLOWLIST.has(arg) && !VALUE_RE.test(arg)) {
    console.error(`pd-cli-launcher: refusing non-allowlisted CLI argument: ${JSON.stringify(arg)}`);
    process.exit(2);
  }
}
if (distIndex === '' || !VALUE_RE.test(distIndex)) {
  console.error('pd-cli-launcher: PD_CLI_DIST_INDEX missing or malformed');
  process.exit(2);
}

// Commander's program.parse() skips argv[0..1], so the vector must be
// [node, pd, ...args] for the first real argument to land at argv[2].
process.argv = ['node', 'pd', ...parsed];
await import(pathToFileURL(distIndex).href);
