/**
 * Command registration helpers (PRI-397 / C5 follow-up).
 *
 * These helpers are the single source of truth for which options a command
 * supports. They are called by BOTH:
 *   - `packages/pd-cli/src/index.ts` (production registration)
 *   - parser-level tests (mvp-smoke.test.ts)
 *
 * Tests reuse the same registration functions so a typo in production
 * (e.g., a flag mismatch between registration and handler) shows up at
 * `program.parseAsync(...)` time, not just at handler dispatch (EP-04).
 */

import type { Command } from 'commander';

/**
 * Add the standard `--workspace <path>` / `--json` flag pair to a command.
 * Returns the same command for chaining.
 */
export function withWorkspaceAndJson(cmd: Command): Command {
  return cmd
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON');
}
