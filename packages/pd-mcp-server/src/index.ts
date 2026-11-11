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
 * console.log's; logs go through the sanitized stderr logger and, when
 * enabled, the durable JSONL file sink (`~/.pd/logs/mcp`). File logging is
 * strictly observational: every failure is swallowed and can never change a
 * result, the protocol stream, the 32 KiB budget or the 10 s deadline.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPdMcpServer } from './server.js';
import { resolveWorkspaceBinding } from './workspace.js';
import { combineSinks, createMcpFileLog } from './log-file.js';
import { createLogger, stderrSink, type LogFn } from './logging.js';

export { createPdMcpServer, TOOL_NAME, toolInputSchema } from './server.js';
// `pd_submit_pain` contract surface. Exporting it registers NOTHING: the tool
// still only exists when `createPdMcpServer({ enableSubmitTool: true })` is
// passed in code, which is the OG-4 production gate (§6). Process entry
// (`main` below) never enables it.
export {
  SUBMIT_TOOL_NAME,
  SUBMIT_TOOL_DESCRIPTION,
  submitToolInputJsonSchema,
  submitToolInputSchema,
  submitToolProtocolSchema,
  createMcpPainId,
  SUBMIT_RECHECK_DEADLINE_MS,
} from './server.js';
export { assembleSubmitResult } from './envelope.js';
export { resolveWorkspaceBinding, WORKSPACE_DIR_ENV, HOST_ENV } from './workspace.js';
export { RESPONSE_BUDGET_BYTES, withinBudget, measureTextBytes } from './budget.js';
export { DEFAULT_DEADLINE_MS, MAX_TRACKED_ORPHANS, runWithDeadline, OrphanLimiter } from './deadline.js';
export { SERVER_NAME, SERVER_VERSION, MCP_SDK_PIN } from './version.js';
export {
  LOG_ENV,
  LOG_DIR_ENV,
  LOG_FILE_ENV,
  LOG_MAX_FILE_BYTES,
  LOG_MAX_DIR_BYTES,
  LOG_RETENTION_MS,
  createMcpFileLog,
  combineSinks,
} from './log-file.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Bounded, path-free label for client names / versions / protocol ids. */
function safeLabel(value: unknown, max = 48): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[^\x20-\x7e]/g, '').replace(/[^\w.#/+:@-]/g, '').slice(0, max);
  return cleaned.length > 0 ? cleaned : undefined;
}

function safeId(value: unknown): string | undefined {
  if (typeof value === 'string') return safeLabel(value, 40);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

interface PendingRequest {
  readonly method: 'initialize' | 'tools/list';
  readonly startedAt: number;
}

const OBSERVED_METHODS = ['initialize', 'tools/list'] as const;

/**
 * Stdio transport that observes — never alters — the JSON-RPC stream.
 * `initialize` / `tools/list` are otherwise invisible to the server layer:
 * MCP only exposes tool callbacks, so a handshake failure would leave no
 * evidence at all. Observation is wrapped in try/catch and always forwards
 * the untouched message to the SDK.
 */
class ObservingStdioTransport extends StdioServerTransport {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly observeLog: LogFn) {
    super();
  }

  override async start(): Promise<void> {
    const inner = this.onmessage;
    this.onmessage = (message) => {
      try {
        this.observeInbound(message);
      } catch {
        // Observation must never break the protocol.
      }
      inner?.(message);
    };
    return super.start();
  }

  override async send(message: Parameters<StdioServerTransport['send']>[0]): Promise<void> {
    try {
      this.observeOutbound(message);
    } catch {
      // Observation must never break the protocol.
    }
    return super.send(message);
  }

  private observeInbound(message: unknown): void {
    if (!isRecord(message) || typeof message.method !== 'string') return;
    const { method } = message;
    if (!(OBSERVED_METHODS as readonly string[]).includes(method)) return;
    const id = safeId(message.id);
    if (id === undefined) return;
    const params = isRecord(message.params) ? message.params : {};
    const clientInfo = isRecord(params.clientInfo) ? params.clientInfo : {};
    const capabilities = isRecord(params.capabilities) ? params.capabilities : {};
    this.pending.set(id, {
      method: method === 'initialize' ? 'initialize' : 'tools/list',
      startedAt: Date.now(),
    });
    if (method === 'initialize') {
      this.observeLog('info', 'initialize', {
        phase: 'request',
        requestId: id,
        clientName: safeLabel(clientInfo.name) ?? 'unknown',
        clientVersion: safeLabel(clientInfo.version) ?? 'unknown',
        protocolVersion: safeLabel(params.protocolVersion) ?? 'unknown',
        capabilityKeysCount: Object.keys(capabilities).length,
      });
    } else {
      this.observeLog('info', 'tools_list', { phase: 'request', requestId: id });
    }
  }

  private observeOutbound(message: unknown): void {
    if (!isRecord(message)) return;
    const id = safeId(message.id);
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    const error = isRecord(message.error) ? message.error : undefined;
    const result = isRecord(message.result) ? message.result : undefined;
    const ok = error === undefined;
    const baseFields = {
      phase: 'response' as const,
      requestId: id,
      ok,
      durationMs: Date.now() - pending.startedAt,
      responseBytes: byteLength(message),
    };
    if (pending.method === 'initialize') {
      const fields: Record<string, string | number | boolean> = { ...baseFields };
      if (!ok) fields.errorCode = safeId(error.code) ?? 'unknown_error';
      this.observeLog(ok ? 'info' : 'error', 'initialize', fields);
    } else {
      const tools = Array.isArray(result?.tools) ? result?.tools : undefined;
      const fields: Record<string, string | number | boolean> = {
        ...baseFields,
        toolCount: tools?.length ?? 0,
      };
      if (!ok) fields.errorCode = safeId(error.code) ?? 'unknown_error';
      this.observeLog(ok ? 'info' : 'error', 'tools_list', fields);
    }
  }
}

/**
 * Run the stdio server against the real process env. Returns the intended
 * process exit code: 0 after a clean shutdown, 1 for a fail-closed startup.
 */
export async function main(env: Record<string, unknown> = process.env): Promise<number> {
  const fileLog = createMcpFileLog(env);
  const sink = fileLog.enabled ? combineSinks(stderrSink, fileLog.sink) : stderrSink;
  const log = createLogger(sink);

  const binding = resolveWorkspaceBinding(env);
  if (!binding.ok) {
    // Fail-closed BEFORE initialize: one sanitized stderr line with the
    // reason and the next action; nothing about values or paths. The same
    // fact lands on disk as `startup_failure` so a host that cannot even
    // reach `initialize` still leaves PD-side evidence.
    log('error', 'startup_failure', {
      stage: 'server',
      reasonCategory: 'invalid_binding',
      reasonCode: binding.reasonCode,
      envVar: binding.envVar,
      nextAction: binding.nextAction,
    });
    fileLog.flushSync();
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
  log('info', 'startup', {
    host: binding.binding.host ?? 'unspecified',
    workspaceFingerprint,
    nodeVersion: process.version,
    platform: process.platform,
  });

  const handle = createPdMcpServer({
    workspaceDir: binding.binding.workspaceDir,
    host: binding.binding.host,
    logSink: sink,
  });
  const transport = new ObservingStdioTransport(log);
  await handle.mcpServer.connect(transport);

  // Host-driven shutdown: stdin close → SDK closes the transport → we stop
  // accepting new work, let in-flight calls drain (bounded by the deadline)
  // and exit cleanly. The transport close callback is the single trigger.
  transport.onclose = () => {
    handle.beginShutdown();
    log('info', 'shutdown', {
      reason: 'stdin_closed',
      orphans: handle.orphans.size,
      active: handle.admissions.active,
      uptimeMs: Math.round(process.uptime() * 1000),
    });
    fileLog.flushSync();
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
