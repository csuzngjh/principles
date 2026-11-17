/**
 * `pd mcp probe` — active (liveness) probe of the installed PD MCP server.
 *
 * `pd health` is deliberately read-only (SPEC §7.8 / PRI-1130: "health never
 * spawns the server"); this command is its active complement for the ONE case
 * where spawning is the point: post-install acceptance. An agent that just
 * installed PD (or restarted a host) needs evidence that the installed bytes
 * actually complete the MCP handshake and expose the contract tool — static
 * checks cannot prove that.
 *
 * Reuses `assessMcpHealth` (health-mcp.ts) as the single layout/binding
 * resolution authority — no second resolution truth (P4). The probe refuses to
 * spawn unless the static layers are verified (status HEALTHY or
 * RESTART_REQUIRED — the restart tri-state describes the HOST process, not
 * spawnability), so it never "verifies" bytes whose install layer already
 * failed (cli-5: failed validation performs no side effect).
 *
 * Protocol: newline-delimited JSON-RPC over stdio — the same wire format the
 * pinned SDK transport (@modelcontextprotocol/*@2.4.0) uses. Kept dependency-
 * free by writing the three frames by hand: initialize → initialized →
 * tools/list. No tool is CALLED (read-only acceptance; recall needs a
 * principleId and would touch workspace business data).
 *
 * Runtime Contract Rules:
 * - rc-1/rc-4: responses parsed as unknown, every tool element validated.
 * - rc-8: stderr captured as a bounded tail, never echoed raw.
 * - rc-9/cli-6: every refusal carries a structured reason + nextAction.
 * - ERR-156: child/stream failures handled BOTH synchronously and via the
 *   async 'error' events.
 * - ERR-181: exit paths set `process.exitCode` and return.
 */
import { spawn, type ChildProcess } from 'child_process';
import { createRequire } from 'module';
import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { isSameMcpBindingPath } from '@principles/install-layout';
import {
  assessMcpHealth,
  resolveHealthHome,
  selectMcpHostForWorkspace,
} from './health-mcp.js';
import type { McpHealthHost, McpHealthSection, McpHealthStatus } from './health-mcp.js';

/** The tool contract every PD MCP server must expose (pd-mcp-server/src/server.ts). */
const EXPECTED_TOOL_NAME = 'pd_recall_principle_pains' as const;
/** The OG-4 host-gated submit tool; presence is REPORTED, never required. */
const SUBMIT_TOOL_NAME = 'pd_submit_pain' as const;

/**
 * The SDK's DEFAULT_NEGOTIATED_PROTOCOL_VERSION for the pinned family
 * (@modelcontextprotocol/*@2.4.0, see pd-mcp-server/src/version.ts MCP_SDK_PIN).
 * The server echoes its own negotiated version, which the probe reports.
 */
const PROTOCOL_VERSION = '2025-03-26' as const;
const CLIENT_NAME = 'pd-cli-mcp-probe' as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LIMIT = 2_000;
const STDOUT_BUFFER_LIMIT = 65_536;
const SHUTDOWN_GRACE_MS = 1_500;

/** Static statuses whose install/binding layers are verified enough to spawn. */
const SPAWNABLE_STATUSES: ReadonlySet<McpHealthStatus> = new Set(['HEALTHY', 'RESTART_REQUIRED']);

export interface McpProbeOptions {
  workspace?: string;
  host?: McpHealthHost;
  json?: boolean;
  timeoutMs?: number;
  /**
   * Test/hermetic override of the PD home (same seam as assessMcpHealth's
   * `homeDir`): production resolves via resolveHealthHome() and never sets it.
   */
  homeDir?: string;
}

export type McpProbePhase =
  | 'static'
  | 'spawn'
  | 'initialize'
  | 'tools_list'
  | 'validate'
  | 'shutdown';

export interface McpProbeResult {
  ok: boolean;
  host: McpHealthHost;
  /**
   * The workspace the probe ACTUALLY served: the binding's `workspaceDir` when
   * a binding exists, otherwise the requested workspace (PRI-1247 — a probe
   * must never report the requested path while the launcher serves another).
   */
  workspace: string;
  /** The workspace the caller asked to probe (--workspace or resolved default). */
  requestedWorkspace: string;
  /** The binding's workspaceDir, or null when the binding/workspace is unavailable. */
  boundWorkspace: string | null;
  /** true/false when both are known; null when no binding workspace is available. */
  workspaceMatchesRequest: boolean | null;
  serverEntry: string | null;
  /** How far the probe got — the failure phase for degraded results. */
  phase: McpProbePhase;
  /** Tool names from tools/list, in server order (empty before tools_list). */
  tools: string[];
  /** null before tools_list; false is a probe FAILURE (contract violation). */
  expectedToolPresent: boolean | null;
  /** Informational (OG-4 host gate): null before tools_list. */
  submitToolPresent: boolean | null;
  /** The protocolVersion the SERVER negotiated (null before initialize). */
  protocolVersion: string | null;
  serverInfo: { name: string | null; version: string | null };
  durationMs: number;
  /** Server process exit code (null when it never exited / was killed). */
  exitCode: number | null;
  staticStatus: McpHealthStatus;
  reason?: string;
  nextAction?: string;
  stderrTail?: string;
  /**
   * PRI-1249: set when the handshake completed despite an unverifiable
   * same-name host registration — observable, not fatal (the installer takes
   * the same posture; a PROVEN foreign entry still fails the static gate).
   */
  registrationWarning?: string;
}

const requireFromMeta = createRequire(import.meta.url);

function readCliVersion(): string {
  // Same pattern as runtime-canary.ts: read the package version without a
  // registry hit; 'unknown' never blocks the probe.
  try {
    const meta: unknown = requireFromMeta('../../package.json');
    if (typeof meta === 'object' && meta !== null && Object.hasOwn(meta, 'version')) {
      const version: unknown = Reflect.get(meta, 'version');
      if (typeof version === 'string' && version.length > 0) return version;
    }
  } catch {
    // fall through
  }
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clamp the operator-supplied timeout into the API's supported domain (ERR-191). */
function clampTimeoutMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(raw), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function parseJsonRpcResponse(line: string): JsonRpcResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const id: unknown = Reflect.get(parsed, 'id');
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  const record: JsonRpcResponse = { id };
  const result: unknown = Reflect.get(parsed, 'result');
  if (result !== undefined) record.result = result;
  const error: unknown = Reflect.get(parsed, 'error');
  if (isRecord(error)) {
    record.error = {
      ...(Object.hasOwn(error, 'code') ? { code: Reflect.get(error, 'code') } : {}),
      ...(Object.hasOwn(error, 'message') ? { message: Reflect.get(error, 'message') } : {}),
    };
  }
  return record;
}

/** Extract validated tool names from a tools/list result (rc-1/rc-4). */
function parseToolNames(result: unknown): { ok: true; tools: string[] } | { ok: false; reason: string } {
  if (!isRecord(result)) return { ok: false, reason: 'tools/list result is not an object' };
  const tools: unknown = Reflect.get(result, 'tools');
  if (!Array.isArray(tools)) return { ok: false, reason: 'tools/list result has no tools array' };
  const names: string[] = [];
  for (const [index, entry] of tools.entries()) {
    // rc-2: the validated value flows onward as a string — no `as` cast.
    const name: unknown = isRecord(entry) ? Reflect.get(entry, 'name') : undefined;
    if (typeof name !== 'string') {
      return { ok: false, reason: `tools[${index}] is not a tool object with a string name` };
    }
    names.push(name);
  }
  return { ok: true, tools: names };
}

function parseInitializeResult(result: unknown): {
  protocolVersion: string | null;
  serverName: string | null;
  serverVersion: string | null;
} {
  if (!isRecord(result)) return { protocolVersion: null, serverName: null, serverVersion: null };
  const readString = (key: string): string | null => {
    const value: unknown = Reflect.get(result, key);
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  const serverInfo: unknown = Reflect.get(result, 'serverInfo');
  let serverName: string | null = null;
  let serverVersion: string | null = null;
  if (isRecord(serverInfo)) {
    const name: unknown = Reflect.get(serverInfo, 'name');
    const version: unknown = Reflect.get(serverInfo, 'version');
    if (typeof name === 'string' && name.length > 0) serverName = name;
    if (typeof version === 'string' && version.length > 0) serverVersion = version;
  }
  return { protocolVersion: readString('protocolVersion'), serverName, serverVersion };
}

function describeJsonRpcError(error: { code?: unknown; message?: unknown }): string {
  const message = typeof error.message === 'string' ? error.message : '';
  const code = typeof error.code === 'number' || typeof error.code === 'string' ? String(error.code) : 'unknown';
  return message.length > 0 ? `${message} (code ${code})` : `code ${code}`;
}

interface SpawnAndHandshakeInput {
  base: McpProbeResult;
  startedAt: number;
  timeoutMs: number;
  serverEntry: string;
  boundHost: string | null;
  boundWorkspace: string;
}

/**
 * Spawn the installed entry with the SAME two env vars the plugin launcher
 * injects (PD_MCP_WORKSPACE_DIR / PD_MCP_HOST — pd-mcp-server/src/workspace.ts),
 * complete the handshake, validate the tool contract, and shut down cleanly.
 */
async function spawnAndHandshake(input: SpawnAndHandshakeInput): Promise<McpProbeResult> {
  const { base, startedAt, timeoutMs, serverEntry, boundHost, boundWorkspace } = input;

  const env: Record<string, string | undefined> = { ...process.env, PD_MCP_WORKSPACE_DIR: boundWorkspace };
  // A MISSING host marker keeps the server recall-only; a host string that is
  // not one of the three known hosts fails its startup — only inject knowns.
  if (boundHost === 'codex' || boundHost === 'openclaw' || boundHost === 'workbuddy') {
    env.PD_MCP_HOST = boundHost;
  }

  return new Promise<McpProbeResult>((resolve) => {
    // Declared before `finish` so every closure below only references
    // already-defined bindings (no-use-before-define).
    let child: ChildProcess;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let phase: McpProbePhase = 'spawn';
    let exitCode: number | null = null;
    let stderrTail = '';
    let stdoutBuffer = '';
    let initializeResult: { protocolVersion: string | null; serverName: string | null; serverVersion: string | null } | null = null;
    let toolNames: string[] | null = null;

    const finish = (result: Partial<McpProbeResult> & { ok?: boolean; reason?: string; nextAction?: string }): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // Best-effort shutdown: close stdin (the server's clean-shutdown
      // trigger), then SIGKILL after a grace period. Failures here never
      // change the verdict.
      try { child.stdin?.end(); } catch { /* already closed */ }
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, SHUTDOWN_GRACE_MS);
      child.once('exit', () => clearTimeout(killTimer));
      const finalize = (): void => {
        clearTimeout(killTimer);
        const ok = result.ok === true;
        const tools = toolNames ?? [];
        const expectedToolPresent = toolNames === null ? null : tools.includes(EXPECTED_TOOL_NAME);
        const submitToolPresent = toolNames === null ? null : tools.includes(SUBMIT_TOOL_NAME);
        const handshakeInfo = initializeResult ?? { protocolVersion: null, serverName: null, serverVersion: null };
        resolve({
          ...base,
          ...result,
          ok,
          phase,
          tools,
          expectedToolPresent,
          submitToolPresent,
          protocolVersion: handshakeInfo.protocolVersion,
          serverInfo: { name: handshakeInfo.serverName, version: handshakeInfo.serverVersion },
          durationMs: Date.now() - startedAt,
          exitCode,
          ...(stderrTail.length > 0 ? { stderrTail } : {}),
        });
      };
      // Give the child a moment to exit on its own so exitCode is truthful;
      // resolve regardless — the verdict never depends on waiting longer.
      const graceTimer = setTimeout(finalize, SHUTDOWN_GRACE_MS);
      child.once('exit', () => { clearTimeout(graceTimer); finalize(); });
    };

    try {
      child = spawn(process.execPath, [serverEntry], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      // Synchronous spawn failure (ERR-156: lexical catch cannot reach the
      // async 'error' event, which is handled separately below).
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        ...base,
        phase: 'spawn',
        durationMs: Date.now() - startedAt,
        reason: `failed to spawn the MCP server: ${message}`,
        nextAction: `Check Node.js and the server entry (${serverEntry}); re-run the PD host setup if it persists.`,
      });
      return;
    }

    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      finish({
        reason: `probe timed out after ${timeoutMs}ms in phase "${phase}"`,
        nextAction: 'The server did not complete the MCP handshake in time. Re-run the PD host setup; if it persists, collect diagnostics with: pd mcp logs export',
      });
    }, timeoutMs);

    // ERR-156: async failure surfaces — spawn errors (ENOENT etc.) and stream
    // errors must both resolve the probe, never leave it hanging.
    child.on('error', (err: Error) => {
      finish({
        reason: `MCP server process error: ${err.message}`,
        nextAction: 'Check Node.js and the installed runtime; re-run the PD host setup for this host.',
      });
    });
    child.on('exit', (code) => {
      exitCode = code;
      if (!settled) {
        finish({
          reason: `MCP server exited early with code ${code ?? 'null'} in phase "${phase}"`,
          nextAction: 'The server failed before completing the handshake. Check the stderr tail in this result and re-run the PD host setup.',
        });
      }
    });
    child.stdout?.on('error', () => {
      finish({
        reason: `MCP server stdout stream failed in phase "${phase}"`,
        nextAction: 'Re-run the probe; if it persists, collect diagnostics with: pd mcp logs export',
      });
    });
    child.stderr?.on('error', () => {
      // stderr is diagnostic-only (rc-8): losing it never fails the probe.
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
    });

    const send = (message: Record<string, unknown>): boolean => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch {
        return false;
      }
    };

    const dispatch = (line: string): void => {
      const response = parseJsonRpcResponse(line);
      if (response === null) return; // notification or noise — only responses carry ids we sent
      if (response.error !== undefined) {
        finish({
          reason: `JSON-RPC error in phase "${phase}": ${describeJsonRpcError(response.error)}`,
          nextAction: 'The server rejected the handshake. Check the stderr tail in this result and re-run the PD host setup.',
        });
        return;
      }
      if (response.id === 1) {
        phase = 'initialize';
        initializeResult = parseInitializeResult(response.result);
        // Notification: no id, no response expected.
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        phase = 'tools_list';
        if (!send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })) {
          finish({
            reason: 'failed to write the tools/list request (stdin closed)',
            nextAction: 'The server closed stdin after initialize. Check the stderr tail and re-run the PD host setup.',
          });
        }
        return;
      }
      if (response.id === 2) {
        phase = 'validate';
        const parsed = parseToolNames(response.result);
        if (!parsed.ok) {
          finish({ reason: parsed.reason, nextAction: 'The installed server violates the tool contract. Re-run the PD host setup for this host.' });
          return;
        }
        toolNames = parsed.tools;
        if (!parsed.tools.includes(EXPECTED_TOOL_NAME)) {
          finish({
            reason: `tools/list does not expose the contract tool "${EXPECTED_TOOL_NAME}" (got: ${parsed.tools.join(', ') || '(none)'})`,
            nextAction: 'The installed server violates the tool contract. Re-run the PD host setup for this host.',
          });
          return;
        }
        phase = 'shutdown';
        finish({ ok: true });
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      // Newline-delimited framing: process every complete line, keep the tail.
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length > 0) dispatch(line);
        if (settled) return;
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
      // Bounded buffer: a server that streams garbage without newlines must
      // not grow this unbounded (rc-8).
      if (stdoutBuffer.length > STDOUT_BUFFER_LIMIT) stdoutBuffer = stdoutBuffer.slice(-4_096);
    });

    phase = 'initialize';
    if (!send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: readCliVersion() },
      },
    })) {
      finish({
        reason: 'failed to write the initialize request (stdin closed)',
        nextAction: 'The server exited before accepting the handshake. Check the stderr tail in this result.',
      });
    }
  });
}

/**
 * Run the active probe. Resolves with the full result (never throws — every
 * failure is a structured result so --json callers get one parseable doc).
 */
export async function runMcpProbe(opts: McpProbeOptions): Promise<McpProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = clampTimeoutMs(opts.timeoutMs);

  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const healthHome = opts.homeDir !== undefined
    ? { homeDir: path.resolve(opts.homeDir), unresolvedReason: null as string | null }
    : resolveHealthHome();
  const hostSelection = opts.host !== undefined
    ? { host: opts.host, selectedBy: 'explicit-flag' as const, matchedHosts: [] as McpHealthHost[] }
    : selectMcpHostForWorkspace(workspaceDir, { homeDir: healthHome.homeDir });
  const { host } = hostSelection;

  const staticSection: McpHealthSection = assessMcpHealth({ host, homeDir: healthHome.homeDir });
  const boundWorkspace = staticSection.workspace.dir;
  const workspaceMatchesRequest = boundWorkspace === null
    ? null
    : isSameMcpBindingPath(boundWorkspace, workspaceDir, process.platform);

  const base: McpProbeResult = {
    ok: false,
    host,
    // Report the ACTUAL binding target, never the request (PRI-1247).
    workspace: boundWorkspace ?? workspaceDir,
    requestedWorkspace: workspaceDir,
    boundWorkspace,
    workspaceMatchesRequest,
    serverEntry: staticSection.server.entry,
    phase: 'static',
    tools: [],
    expectedToolPresent: null,
    submitToolPresent: null,
    protocolVersion: null,
    serverInfo: { name: null, version: null },
    durationMs: 0,
    exitCode: null,
    staticStatus: staticSection.status,
  };

  // "Home unresolved" and "MCP not installed" are different facts (same split
  // as pd health): surface the resolver's own reason over the section's.
  if (healthHome.unresolvedReason) {
    return {
      ...base,
      durationMs: Date.now() - startedAt,
      reason: healthHome.unresolvedReason,
      nextAction: 'Fix the PD home inputs (PD_EXPERIMENT_ROOT / PD_WORKSPACE_DIR or OPENCLAW_STATE_DIR), then rerun pd mcp probe.',
    };
  }

  // PRI-1247: an EXPLICIT probe target that the installed binding does not
  // serve is a refusal, not a success. Spawning would prove something about a
  // different workspace and hide the cross-host misbinding behind a green probe.
  if (opts.workspace !== undefined && workspaceMatchesRequest === false && boundWorkspace !== null) {
    return {
      ...base,
      durationMs: Date.now() - startedAt,
      reason: `workspace_mismatch: requested ${workspaceDir} but the ${host} binding serves ${boundWorkspace}`,
      nextAction: `Re-run the PD host setup for ${host} with --workspace "${workspaceDir}", or probe the bound workspace instead.`,
    };
  }

  // Static gate (cli-5): never spawn on top of a broken install layer.
  // PRI-1249 alignment with PR#2697: an UNVERIFIABLE same-name registration
  // (typically a dead launcher path a stale entry left behind) no longer blocks
  // the handshake — the installer proceeds past it too, and the probe spawns
  // THIS payload's own launcher, which is the direct evidence the install
  // layer works. A PROVEN foreign entry (mcp_same_name_conflict) still blocks.
  const registrationUnverifiable = staticSection.status === 'CONFIG_DRIFT'
    && staticSection.reason === 'mcp_registration_unverifiable';
  if (!SPAWNABLE_STATUSES.has(staticSection.status) && !registrationUnverifiable) {
    return {
      ...base,
      durationMs: Date.now() - startedAt,
      reason: staticSection.reason ?? `static install health is ${staticSection.status}`,
      nextAction: staticSection.nextAction ?? 'Re-run the PD host setup for this host, then rerun pd mcp probe.',
    };
  }
  if (!staticSection.server.entryExists) {
    return {
      ...base,
      durationMs: Date.now() - startedAt,
      reason: 'installed MCP server entry is missing',
      nextAction: 'Re-run the PD host setup for this host so the pinned MCP server is reinstalled, then rerun pd mcp probe.',
    };
  }
  if (boundWorkspace === null || staticSection.workspace.exists !== true) {
    return {
      ...base,
      durationMs: Date.now() - startedAt,
      reason: boundWorkspace === null
        ? 'mcp-binding.json records no workspaceDir'
        : 'the workspace recorded in mcp-binding.json does not exist',
      nextAction: 'Re-run the PD host setup for this host so mcp-binding.json points at the governance workspace, then rerun pd mcp probe.',
    };
  }

  const probed = await spawnAndHandshake({
    base,
    startedAt,
    timeoutMs,
    serverEntry: staticSection.server.entry,
    boundHost: staticSection.binding.host,
    boundWorkspace,
  });
  // PRI-1249: the handshake ran DESPITE the unverifiable registration — keep
  // the fact visible instead of a bare green (rc-9), but do not fail the probe
  // for something the installer also only warns about.
  if (registrationUnverifiable && probed.ok) {
    return {
      ...probed,
      registrationWarning: 'mcp_registration_unverifiable: the same-name host registration could not be proven; it did not block this handshake. Inspect the host mcp.json manually or re-run the PD host setup.',
    };
  }
  return probed;
}

/** `pd mcp probe` handler: run the probe, print, set exit code (cli-1/cli-2/cli-6). */
export async function handleMcpProbe(opts: McpProbeOptions = {}): Promise<void> {
  const result = await runMcpProbe(opts);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`host:            ${result.host}`);
    console.log(`workspace:       ${result.workspace}`);
    if (result.requestedWorkspace !== result.workspace) {
      console.log(`requested:       ${result.requestedWorkspace} (binding serves a different workspace)`);
    }
    console.log(`serverEntry:     ${result.serverEntry}`);
    console.log(`staticStatus:    ${result.staticStatus}`);
    console.log(`phase:           ${result.phase}`);
    console.log(`protocolVersion: ${result.protocolVersion ?? '(not reached)'}`);
    console.log(`server:          ${result.serverInfo.name ?? '?'} ${result.serverInfo.version ?? ''}`.trimEnd());
    console.log(`tools:           ${result.tools.length > 0 ? result.tools.join(', ') : '(none listed)'}`);
    console.log(`expectedTool:    ${result.expectedToolPresent === null ? '(not reached)' : result.expectedToolPresent ? `present (${EXPECTED_TOOL_NAME})` : 'MISSING'}`);
    console.log(`submitTool:      ${result.submitToolPresent === null ? '(not reached)' : result.submitToolPresent ? 'present (host-gated)' : 'absent (recall-only)'}`);
    console.log(`durationMs:      ${result.durationMs}`);
    console.log(`exitCode:        ${result.exitCode ?? '(killed or not exited)'}`);
    if (result.reason) console.log(`reason:          ${result.reason}`);
    if (result.nextAction) console.log(`nextAction:      ${result.nextAction}`);
    if (result.registrationWarning) console.log(`reg-warning:     ${result.registrationWarning}`);
    if (result.stderrTail) console.log(`stderrTail:      ${result.stderrTail.replace(/\n/g, ' | ')}`);
  }
  if (!result.ok) {
    process.exitCode = 1;
    return;
  }
}
