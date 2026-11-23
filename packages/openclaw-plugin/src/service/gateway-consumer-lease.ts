/**
 * Gateway internalization consumer lease — the workspace-scoped attribution
 * record that makes "is a Gateway consumer alive for this workspace?"
 * decidable across a Gateway restart (PRI-1282 Phase 4 review, P1-3).
 *
 * Why it exists: the ownership manifest gates the STATE transition, but the
 * manifest alone cannot distinguish "a Gateway consumer is alive and was
 * blocked by a handover marker" from "no consumer is running". Without a
 * liveness record, a fresh Gateway process seeing a blocking marker would
 * write a quiesce ACK that only proves IT has no in-flight cycle — while a
 * legacy consumer from the same (unrestarted) process could still be
 * running. The lease is the service-run-lock pattern reused at file scope:
 * PID liveness is the sole takeover authority; anything unverifiable fails
 * closed (treated as alive-ish → do NOT ack, keep watching).
 *
 * Location: <workspaceDir>/.pd/gateway-consumer-lease.json — inside the
 * workspace's PD state area, per-workspace by construction.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const GATEWAY_CONSUMER_LEASE_SCHEMA_VERSION = 'pd.gateway-consumer-lease.v1';
export const GATEWAY_CONSUMER_LEASE_FILE = 'gateway-consumer-lease.json';

export interface GatewayConsumerLease {
  schemaVersion: string;
  /** Identity of THIS consumer instance — one per process lifetime. */
  token: string;
  pid: number;
  host: string;
  workspaceDir: string;
  /** 'consuming' while cycles may be scheduled; 'quiesced' after a clean drain. */
  state: 'consuming' | 'quiesced';
  startedAt: string;
  updatedAt: string;
}

function leasePath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pd', GATEWAY_CONSUMER_LEASE_FILE);
}

/** Fresh identity for this process's consumer instance. */
export function gatewayConsumerLeaseToken(): string {
  return crypto.randomUUID();
}

function errnoOf(error: unknown): string {
  return typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
    ? String(Reflect.get(error, 'code'))
    : '';
}

/**
 * PID liveness with the same contract as service-run-lock: EPERM means the
 * process exists (we just cannot signal it) → alive; ESRCH → dead; anything
 * else is a platform answer we cannot classify → 'unknown' (fail-closed).
 */
export function processAliveProbe(pid: number): 'alive' | 'dead' | 'unknown' {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

export function parseGatewayConsumerLease(raw: unknown): GatewayConsumerLease | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const schemaVersion = record.schemaVersion;
  const token = record.token;
  const pid = record.pid;
  const host = record.host;
  const workspaceDir = record.workspaceDir;
  const state = record.state;
  const startedAt = record.startedAt;
  const updatedAt = record.updatedAt;
  if (
    typeof schemaVersion !== 'string' || schemaVersion !== GATEWAY_CONSUMER_LEASE_SCHEMA_VERSION
    || typeof token !== 'string' || token.length === 0
    || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0
    || typeof host !== 'string' || host.length === 0
    || typeof workspaceDir !== 'string' || workspaceDir.length === 0
    || (state !== 'consuming' && state !== 'quiesced')
    || typeof startedAt !== 'string' || startedAt.length === 0
    || typeof updatedAt !== 'string' || updatedAt.length === 0
  ) {
    return null;
  }
  return { schemaVersion, token, pid, host, workspaceDir, state, startedAt, updatedAt };
}

/** Read the lease; null on missing or unreadable/malformed content. */
export function readGatewayConsumerLease(workspaceDir: string): GatewayConsumerLease | null {
  try {
    return parseGatewayConsumerLease(JSON.parse(fs.readFileSync(leasePath(workspaceDir), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Publish the lease atomically (tmp file + rename). Always writes, keyed by
 * OUR token — the lease is a liveness record, not a lock: whoever holds the
 * consuming role rewrites it each cycle.
 */
export function writeGatewayConsumerLease(input: {
  workspaceDir: string;
  token: string;
  state: 'consuming' | 'quiesced';
  now?: () => Date;
}): { ok: true } | { ok: false; reason: string } {
  const now = input.now ?? (() => new Date());
  const lease: GatewayConsumerLease = {
    schemaVersion: GATEWAY_CONSUMER_LEASE_SCHEMA_VERSION,
    token: input.token,
    pid: process.pid,
    host: os.hostname(),
    workspaceDir: input.workspaceDir,
    state: input.state,
    startedAt: readGatewayConsumerLease(input.workspaceDir)?.token === input.token
      ? (readGatewayConsumerLease(input.workspaceDir)?.startedAt ?? now().toISOString())
      : now().toISOString(),
    updatedAt: now().toISOString(),
  };
  const dir = path.join(input.workspaceDir, '.pd');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `cannot create .pd directory: ${errnoOf(error) || 'io error'}` };
  }
  const tmpPath = `${leasePath(input.workspaceDir)}.tmp-${process.pid}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(lease, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    return { ok: false, reason: `cannot write lease temp file: ${errnoOf(error) || 'io error'}` };
  }
  try {
    fs.renameSync(tmpPath, leasePath(input.workspaceDir));
    return { ok: true };
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    return { ok: false, reason: `cannot land lease atomically: ${errnoOf(error) || 'io error'}` };
  }
}

/**
 * Remove OUR lease on consumer stop. Token-gated: a lease file that no
 * longer carries our token belongs to a successor instance — never delete
 * another consumer's liveness record.
 */
export function clearGatewayConsumerLease(workspaceDir: string, token: string): void {
  const current = readGatewayConsumerLease(workspaceDir);
  if (current === null || current.token !== token) return;
  try {
    fs.unlinkSync(leasePath(workspaceDir));
  } catch {
    // Missing already or removal failed — a dead-holder lease is a stale
    // record the next reader detects via PID liveness; harmless either way.
  }
}

export type ForeignConsumerLeaseStatus = 'alive' | 'none' | 'unknown';

/**
 * Whether a DIFFERENT live process holds a consumer lease for this
 * workspace — the arbitration input for quiesce-ACK honesty and restart
 * resume (PRI-1282 P1-3):
 *  - 'alive':   a lease exists, its owner is on this host, and its PID is
 *               provably alive — a foreign consumer may still be running;
 *               a fresh process MUST NOT claim the consumer stopped.
 *  - 'none':    no lease, or its holder's PID is provably dead — the foreign
 *               consumer cannot be running.
 *  - 'unknown': lease unreadable/malformed, foreign host, or PID liveness
 *               undecidable — fail-closed: never ack "quiesced" on it.
 *
 * A lease carrying THIS process's PID is not foreign (same process → 'none'
 * unless a stale different-token file exists, which is still not foreign).
 */
export function foreignConsumerLeaseStatus(
  workspaceDir: string,
  opts?: { processAlive?: (pid: number) => 'alive' | 'dead' | 'unknown' },
): ForeignConsumerLeaseStatus {
  let raw: string;
  try {
    raw = fs.readFileSync(leasePath(workspaceDir), 'utf8');
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return 'none';
    return 'unknown';
  }
  let parsed: GatewayConsumerLease | null;
  try {
    parsed = parseGatewayConsumerLease(JSON.parse(raw));
  } catch {
    return 'unknown';
  }
  if (parsed === null) return 'unknown';
  if (parsed.pid === process.pid) return 'none';
  if (parsed.host !== os.hostname()) {
    // Remote-holder liveness is undecidable locally — fail closed.
    return 'unknown';
  }
  const alive = (opts?.processAlive ?? processAliveProbe)(parsed.pid);
  return alive === 'dead' ? 'none' : 'alive';
}
