/**
 * PD MCP Server process entry — SPEC-PD-MCP-GATE4-001 §5.5.
 *
 * Startup: resolve the fixed workspace binding (fail-closed: a missing or
 * invalid binding logs ONE sanitized reason to stderr and exits 1 BEFORE the
 * MCP initialize — the server never serves with an unconfirmed workspace) →
 * build the server → connect the stdio transport → wait for requests.
 *
 * Shutdown (host closes stdin / terminates): stop accepting new calls
 * (in-flight ones drain bounded by the 10 s deadline; late results are
 * suppressed), release resources, exit 0.
 *
 * stdout carries MCP protocol messages ONLY (§5.3). This module never
 * console.log's; logs go through the sanitized stderr logger.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPdMcpServer } from './server.js';
import { resolveWorkspaceBinding } from './workspace.js';
import { stderrLog } from './logging.js';

export { createPdMcpServer, TOOL_NAME, toolInputSchema } from './server.js';
export { resolveWorkspaceBinding, WORKSPACE_DIR_ENV, HOST_ENV } from './workspace.js';
export { RESPONSE_BUDGET_BYTES, withinBudget, measureTextBytes } from './budget.js';
export { DEFAULT_DEADLINE_MS, MAX_TRACKED_ORPHANS, runWithDeadline, OrphanLimiter } from './deadline.js';
export { SERVER_NAME, SERVER_VERSION, MCP_SDK_PIN } from './version.js';

/**
 * Run the stdio server against the real process env. Returns the intended
 * process exit code: 0 after a clean shutdown, 1 for a fail-closed startup.
 */
export async function main(env: Record<string, unknown> = process.env): Promise<number> {
  const binding = resolveWorkspaceBinding(env);
  if (!binding.ok) {
    // Fail-closed BEFORE initialize: one sanitized stderr line with the
    // reason and the next action; nothing about values or paths.
    stderrLog('error', 'startup_binding_failed', {
      envVar: binding.envVar,
      reasonCategory: 'invalid_binding',
      reason: binding.reason,
      nextAction: binding.nextAction,
    });
    return 1;
  }

  // Workspace fingerprint (NOT the path): lets operators and acceptance runs
  // prove WHICH workspace this process bound without leaking a directory
  // (§10 forbids logging full paths). Multi-agent hosts must never see two
  // different fingerprints for the same binding.
  const workspaceFingerprint = createHash('sha256')
    .update(path.resolve(binding.binding.workspaceDir))
    .digest('hex')
    .slice(0, 16);
  stderrLog('info', 'startup', { host: binding.binding.host ?? 'unspecified', workspaceFingerprint });

  const handle = createPdMcpServer({ workspaceDir: binding.binding.workspaceDir, host: binding.binding.host });
  const transport = new StdioServerTransport();
  await handle.mcpServer.connect(transport);

  // Host-driven shutdown: stdin close → SDK closes the transport → we stop
  // accepting new work, let in-flight calls drain (bounded by the deadline)
  // and exit cleanly. The transport close callback is the single trigger.
  transport.onclose = () => {
    handle.beginShutdown();
    stderrLog('info', 'transport_closed', { orphans: handle.orphans.size });
  };

  return 0;
}

// Process-mode guard: only run when executed directly (not when the launcher
// or tests import this module). Windows-safe via pathToFileURL.
const { 1: invokedPath } = process.argv;
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  void main().then((code) => {
    if (code !== 0) process.exit(code);
    // code 0: exit naturally once the event loop drains (timers unref'd).
  });
}
