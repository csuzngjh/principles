import * as path from 'node:path';
import type { InstallLayoutPaths } from '@principles/install-layout';

/**
 * Temporary twin of install-layout's MCP component path API.
 *
 * The registry only publishes install-layout 0.4.0, which predates
 * `mcpServerDir` / `getMcpServerEntry`. The npx-parity gate installs the
 * packed installer ALONE and resolves that published dependency, so a static
 * import of the new exports crashes at module load (PRI-669 defect class:
 * the installer dist must never import an interface the registry lacks).
 *
 * Retirement condition: the registry serves the install-layout version whose
 * d.ts declares `mcpServerDir` (this PR adds the changeset that publishes
 * it). Then switch both call sites back to the shared exports and delete
 * this file — the same two-step as the #2047 → #2058 manifest-host twin.
 */
export function resolveMcpServerDir(layout: InstallLayoutPaths): string {
  return path.join(layout.runtimeDir, 'pd-mcp-server');
}

export function resolveMcpServerEntry(layout: InstallLayoutPaths): string {
  return path.join(resolveMcpServerDir(layout), 'dist', 'index.js');
}
