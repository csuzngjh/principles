/**
 * Gateway quiesce acknowledgment — the AUDITABLE "the old consumer has
 * stopped" evidence for SPEC-PD-SERVICE-HOST-001 §8.4 handovers
 * (PRI-1282 Phase 4).
 *
 * clearTimeout, PID absence, gateway exit, fixed delays and stop()
 * returning are NOT proof that consumption stopped. The only acceptable
 * evidence is this persisted record, written by the Gateway process when it
 * observes a blocking ownership state for a workspace it was consuming (or
 * was about to consume): the tick gate and the service-start gate both
 * route through here. The record binds the marker's operationId +
 * generation, so a stale or replayed ack is detectable by the handover
 * command.
 *
 * Location: `<workspace>/.pd/gateway-quiesce-ack.json` — workspace-scoped
 * evidence, not an ownership authority (the install manifest stays the only
 * authority; this file proves a transition fact about one operation).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SystemLogger } from '../core/system-logger.js';

export const GATEWAY_QUIESCE_ACK_SCHEMA_VERSION = 'pd.gateway-quiesce.v1';
export const GATEWAY_QUIESCE_ACK_FILE = 'gateway-quiesce-ack.json';

export type GatewayQuiesceOutcome = 'quiesced' | 'in_flight_timeout';

export interface GatewayQuiesceAck {
  schemaVersion: typeof GATEWAY_QUIESCE_ACK_SCHEMA_VERSION;
  workspaceDir: string;
  /** The blocking marker state the Gateway observed. */
  state: 'handover_preparing' | 'service_host_owned' | 'rollback_pending';
  /** Bound to the marker record — a stale ack is detectable, never trusted. */
  operationId: string | null;
  generation: number;
  /** Must be 0 for a `quiesced` outcome. */
  inFlightCycles: number;
  outcome: GatewayQuiesceOutcome;
  completedAt: string;
  writer: { hostKind: 'openclaw'; pid: number; startedVia: 'timer_tick' | 'service_start' };
}

export interface WriteGatewayQuiesceAckInput {
  workspaceDir: string;
  state: GatewayQuiesceAck['state'];
  operationId: string | null;
  generation: number;
  inFlightCycles: number;
  outcome: GatewayQuiesceOutcome;
  startedVia: GatewayQuiesceAck['writer']['startedVia'];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ackPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), '.pd', GATEWAY_QUIESCE_ACK_FILE);
}

/** Write the ack atomically (O_EXCL temp + rename). Containment-checked. */
export function writeGatewayQuiesceAck(input: WriteGatewayQuiesceAckInput): { ok: boolean; reason?: string } {
  const root = path.resolve(input.workspaceDir);
  const pdDir = path.join(root, '.pd');
  const file = path.join(pdDir, GATEWAY_QUIESCE_ACK_FILE);
  if (!file.startsWith(root + path.sep)) return { ok: false, reason: 'path_containment' };
  const ack: GatewayQuiesceAck = {
    schemaVersion: GATEWAY_QUIESCE_ACK_SCHEMA_VERSION,
    workspaceDir: root,
    state: input.state,
    operationId: input.operationId,
    generation: input.generation,
    inFlightCycles: input.inFlightCycles,
    outcome: input.outcome,
    completedAt: new Date().toISOString(),
    writer: { hostKind: 'openclaw', pid: process.pid, startedVia: input.startedVia },
  };
  try {
    if (!fs.existsSync(pdDir)) fs.mkdirSync(pdDir, { recursive: true });
    const tmp = path.join(
      pdDir,
      `${GATEWAY_QUIESCE_ACK_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`,
    );
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(ack, null, 2) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // rc-9: an ack that cannot land must be observable — the handover will
    // fail closed on its absence, so the reason belongs in the SystemLogger.
    SystemLogger.log(input.workspaceDir, 'GATEWAY_QUIESCE_ACK_FAILED', JSON.stringify({ message: message.slice(0, 200) }));
    return { ok: false, reason: message };
  }
}

/**
 * Read + validate the ack (rc-1/rc-2/rc-3: untrusted JSON until proven).
 * `null` when absent/malformed — the handover treats null as "no evidence".
 */
export function readGatewayQuiesceAck(workspaceDir: string): GatewayQuiesceAck | null {
  let text: string;
  try {
    text = fs.readFileSync(ackPath(workspaceDir), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  if (parsed.schemaVersion !== GATEWAY_QUIESCE_ACK_SCHEMA_VERSION) return null;
  const states = ['handover_preparing', 'service_host_owned', 'rollback_pending'];
  if (typeof parsed.state !== 'string' || !states.includes(parsed.state)) return null;
  if (typeof parsed.generation !== 'number' || !Number.isInteger(parsed.generation) || parsed.generation < 0) return null;
  if (parsed.operationId !== null && typeof parsed.operationId !== 'string') return null;
  if (typeof parsed.inFlightCycles !== 'number' || !Number.isInteger(parsed.inFlightCycles) || parsed.inFlightCycles < 0) return null;
  if (parsed.outcome !== 'quiesced' && parsed.outcome !== 'in_flight_timeout') return null;
  if (typeof parsed.completedAt !== 'string' || parsed.completedAt.length === 0) return null;
  if (parsed.outcome === 'quiesced' && parsed.inFlightCycles !== 0) return null;
  return {
    schemaVersion: GATEWAY_QUIESCE_ACK_SCHEMA_VERSION,
    workspaceDir: typeof parsed.workspaceDir === 'string' ? parsed.workspaceDir : path.resolve(workspaceDir),
    state: parsed.state as GatewayQuiesceAck['state'],
    operationId: parsed.operationId as string | null,
    generation: parsed.generation,
    inFlightCycles: parsed.inFlightCycles,
    outcome: parsed.outcome,
    completedAt: parsed.completedAt,
    writer: isPlainRecord(parsed.writer)
      ? { hostKind: 'openclaw', pid: typeof parsed.writer.pid === 'number' ? parsed.writer.pid : -1, startedVia: parsed.writer.startedVia === 'service_start' ? 'service_start' : 'timer_tick' }
      : { hostKind: 'openclaw', pid: -1, startedVia: 'timer_tick' },
  };
}
