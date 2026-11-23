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
import Database from 'better-sqlite3';

export const GATEWAY_CONSUMER_LEASE_SCHEMA_VERSION = 'pd.gateway-consumer-lease.v1';
export const GATEWAY_CONSUMER_LEASE_FILE = 'gateway-consumer-lease.json';

export interface GatewayConsumerLeaseWriter {
  token: string;
  instanceId: string;
  pid: number;
  host: string;
  state: 'consuming' | 'quiesced';
  startedAt: string;
  updatedAt: string;
}

export interface GatewayConsumerLease {
  schemaVersion: string;
  /** Identity of THIS consumer instance — one per process lifetime. */
  token: string;
  /**
   * PRI-1282 review r4: per-INSTANCE identity. A Gateway restart (or a
   * stop()/start() inside one process) mints a new instanceId — PID alone
   * cannot distinguish two lifecycles of the same process, and a new
   * instance must never be mistaken for (or allowed to clear) the old one.
   */
  instanceId: string;
  pid: number;
  host: string;
  workspaceDir: string;
  /** 'consuming' while cycles may be scheduled; 'quiesced' after a clean drain. */
  state: 'consuming' | 'quiesced';
  startedAt: string;
  updatedAt: string;
  /**
   * PRI-1282 review r5: EVERY writer that has published to this lease,
   * keyed by instanceId (upserted per publish). A single top-level record
   * can only name the last writer — a quiesce confirmation that only
   * consults it is blind to an earlier writer still running a cycle.
   * Liveness is judged per writer.
   */
  writers?: GatewayConsumerLeaseWriter[];
}

function leasePath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pd', GATEWAY_CONSUMER_LEASE_FILE);
}

/** Fresh identity for ONE consumer instance — minted per start(). */
export function gatewayConsumerLeaseToken(): string {
  return crypto.randomUUID();
}

/** Fresh per-instance identity (PRI-1282 r4: PID is not an instance id). */
export function gatewayConsumerInstanceId(): string {
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
    || typeof (record.instanceId) !== 'string' || (record.instanceId as string).length === 0
    || (state !== 'consuming' && state !== 'quiesced')
    || typeof startedAt !== 'string' || startedAt.length === 0
    || typeof updatedAt !== 'string' || updatedAt.length === 0
  ) {
    return null;
  }
  const writers = Array.isArray(record.writers)
    ? record.writers.filter((w): w is GatewayConsumerLeaseWriter => parseWriter(w) !== null)
    : undefined;
  return { schemaVersion, token, instanceId: record.instanceId as string, pid, host, workspaceDir, state, startedAt, updatedAt, writers };
}

function parseWriter(raw: unknown): GatewayConsumerLeaseWriter | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const w = raw as Record<string, unknown>;
  if (
    typeof w.token !== 'string' || w.token.length === 0
    || typeof w.instanceId !== 'string' || w.instanceId.length === 0
    || typeof w.pid !== 'number' || !Number.isInteger(w.pid) || w.pid <= 0
    || typeof w.host !== 'string' || w.host.length === 0
    || (w.state !== 'consuming' && w.state !== 'quiesced')
    || typeof w.startedAt !== 'string' || w.startedAt.length === 0
    || typeof w.updatedAt !== 'string' || w.updatedAt.length === 0
  ) return null;
  return { token: w.token, instanceId: w.instanceId, pid: w.pid, host: w.host, state: w.state, startedAt: w.startedAt, updatedAt: w.updatedAt };
}

/**
 * Every writer recorded on the lease — the writers[] entries, or the
 * top-level record for pre-r5 single-writer leases.
 */
export function leaseWriters(lease: GatewayConsumerLease): GatewayConsumerLeaseWriter[] {
  if (Array.isArray(lease.writers) && lease.writers.length > 0) return lease.writers;
  return [{
    token: lease.token, instanceId: lease.instanceId, pid: lease.pid, host: lease.host,
    state: lease.state, startedAt: lease.startedAt, updatedAt: lease.updatedAt,
  }];
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
 *
 * PRI-1282 r7: the read→merge→replace MUST run inside the arbitration gate.
 * An unguarded write lets a concurrent Gateway's just-written 'quiesced'
 * record be clobbered back to 'consuming' (lost update) — afterwards the
 * revived 'consuming' record blinds every resume check forever.
 */
export function writeGatewayConsumerLease(input: {
  workspaceDir: string;
  token: string;
  instanceId: string;
  state: 'consuming' | 'quiesced';
  now?: () => Date;
  openGate?: (path: string) => ConsumerLeaseGateLike;
}): { ok: true } | { ok: false; reason: string } {
  const gated = withConsumerLeaseGate(input.workspaceDir, () => writeGatewayConsumerLeaseUngated(input), input.openGate);
  return gated.ok ? gated.value : { ok: false, reason: gated.reason };
}

function writeGatewayConsumerLeaseUngated(input: {
  workspaceDir: string;
  token: string;
  instanceId: string;
  state: 'consuming' | 'quiesced';
  now?: () => Date;
}): { ok: true } | { ok: false; reason: string } {
  const now = input.now ?? (() => new Date());
  // A lease file that exists but does not parse is an UNVERIFIABLE foreign
  // record (e.g. an older schema without instanceId) — overwriting it would
  // delete a live consumer's liveness evidence. Fail closed instead (r6).
  let rawExisting: string | null = null;
  try {
    rawExisting = fs.readFileSync(leasePath(input.workspaceDir), 'utf8');
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') {
      return { ok: false, reason: `cannot read the existing consumer lease: ${errnoOf(error) || 'io error'}` };
    }
  }
  let existing: GatewayConsumerLease | null = null;
  if (rawExisting !== null) {
    try {
      existing = parseGatewayConsumerLease(JSON.parse(rawExisting));
    } catch { /* malformed JSON → treated as unparseable */ }
    if (existing === null) {
      return { ok: false, reason: 'consumer lease exists but is unparseable; refusing to overwrite an unverifiable foreign liveness record (fail-closed)' };
    }
  }
  const ours: GatewayConsumerLeaseWriter = {
    token: input.token,
    instanceId: input.instanceId,
    pid: process.pid,
    host: os.hostname(),
    state: input.state,
    startedAt: existing?.writers?.find((w) => w.instanceId === input.instanceId)?.startedAt
      ?? (existing?.instanceId === input.instanceId ? existing.startedAt : now().toISOString()),
    updatedAt: now().toISOString(),
  };
  // Upsert OUR writer; every other recorded writer stays visible so quiesce
  // confirmation and restart arbitration see the full liveness set (r5).
  const writers = existing === null ? [ours] : [...leaseWriters(existing).filter((w) => w.instanceId !== input.instanceId), ours];
  const lease: GatewayConsumerLease = {
    schemaVersion: GATEWAY_CONSUMER_LEASE_SCHEMA_VERSION,
    token: ours.token,
    instanceId: ours.instanceId,
    pid: ours.pid,
    host: ours.host,
    workspaceDir: input.workspaceDir,
    state: ours.state,
    startedAt: ours.startedAt,
    updatedAt: ours.updatedAt,
    writers: writers.slice(-16),
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
export function clearGatewayConsumerLease(workspaceDir: string, token: string, instanceId?: string): void {
  // r7: release is also a read→filter→replace — same lost-update class as a
  // write, so it runs inside the arbitration gate.
  void withConsumerLeaseGate(workspaceDir, () => { clearGatewayConsumerLeaseUngated(workspaceDir, token, instanceId); });
}

function clearGatewayConsumerLeaseUngated(workspaceDir: string, token: string, instanceId?: string): void {
  const current = readGatewayConsumerLease(workspaceDir);
  if (current === null) return;
  const writers = leaseWriters(current);
  // Release is gated on BOTH token and instance identity (PRI-1282 r4/r5):
  // a successor instance's writer entry is never deleted by a retiring
  // instance, and other consumers' liveness records survive our release.
  const remaining = writers.filter((w) => {
    if (instanceId !== undefined) return w.instanceId !== instanceId;
    return w.token !== token;
  });
  if (remaining.length === writers.length) return; // nothing of ours recorded
  if (remaining.length === 0) {
    try {
      fs.unlinkSync(leasePath(workspaceDir));
    } catch {
      // Missing already or removal failed — a dead-holder lease is a stale
      // record the next reader detects via PID liveness; harmless either way.
    }
    return;
  }
  const latest = remaining[remaining.length - 1]!; // remaining.length > 0 here
  const next: GatewayConsumerLease = {
    ...current,
    token: latest.token,
    instanceId: latest.instanceId,
    pid: latest.pid,
    host: latest.host,
    state: latest.state,
    startedAt: latest.startedAt,
    updatedAt: latest.updatedAt,
    writers: remaining,
  };
  const tmpPath = `${leasePath(workspaceDir)}.tmp-${process.pid}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmpPath, leasePath(workspaceDir));
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
  }
}

/**
 * Cross-process arbitration gate for lease mutations: a SQLite
 * `BEGIN IMMEDIATE` transaction on `<lease>.gate.db` (better-sqlite3 —
 * same mechanism as the install-manifest CAS lock, dependency already
 * shipped with the plugin). Every check-and-register / mark-and-observe
 * decision runs inside the serialized section, so two Gateways can never
 * interleave "I checked no other consumer" with "I registered myself".
 */
export interface ConsumerLeaseGateLike {
  exec(sql: string): void;
  close(): void;
}

const LEASE_GATE_BUSY_TIMEOUT_MS = 250;

function defaultOpenLeaseGate(gatePath: string): ConsumerLeaseGateLike {
  const db = new Database(gatePath);
  db.exec(`PRAGMA busy_timeout = ${LEASE_GATE_BUSY_TIMEOUT_MS}`);
  return db;
}

export function withConsumerLeaseGate<T>(
  workspaceDir: string,
  fn: () => T,
  openGate?: (path: string) => ConsumerLeaseGateLike,
): { ok: true; value: T } | { ok: false; reason: string } {
  const dir = path.join(workspaceDir, '.pd');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `cannot create .pd directory for the consumer lease gate: ${errnoOf(error) || 'io error'}` };
  }
  let db: ConsumerLeaseGateLike;
  try {
    db = (openGate ?? defaultOpenLeaseGate)(`${leasePath(workspaceDir)}.gate.db`);
  } catch (error) {
    return { ok: false, reason: `consumer lease gate unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    let value: T | undefined;
    let completed = false;
    try {
      value = fn();
      completed = true;
    } finally {
      try {
        db.exec(completed ? 'COMMIT' : 'ROLLBACK');
      } catch {
        // best effort — a failed COMMIT surfaces below as a gate error path
      }
    }
    return { ok: true, value: value as T };
  } catch (error) {
    return { ok: false, reason: `consumer lease gate transaction failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

export type ConsumerLeaseRegistration =
  | { ok: true; status: 'registered' }
  | { ok: true; status: 'refused_foreign_alive' | 'refused_foreign_unknown' }
  | { ok: false; reason: string };

/**
 * Serialized "check foreign consumer → register ourselves" for consumer
 * start (PRI-1282 review r6): without the gate, two Gateways can each pass
 * the foreign check before either writes, land two 'consuming' records,
 * and then wait on each other at quiesce forever.
 */
export function registerGatewayConsumerLease(input: {
  workspaceDir: string;
  token: string;
  instanceId: string;
  processAlive?: (pid: number) => 'alive' | 'dead' | 'unknown';
  openGate?: (path: string) => ConsumerLeaseGateLike;
}): ConsumerLeaseRegistration {
  const gated = withConsumerLeaseGate(
    input.workspaceDir,
    () => {
      const foreign = foreignConsumerLeaseStatus(input.workspaceDir, {
        selfToken: input.token,
        selfInstanceId: input.instanceId,
        processAlive: input.processAlive,
      });
      if (foreign !== 'none') {
        return { refused: foreign } as const;
      }
      // Already inside the arbitration gate — call the ungated write
      // directly (better-sqlite3 rejects nested BEGIN IMMEDIATE).
      return writeGatewayConsumerLeaseUngated({
        workspaceDir: input.workspaceDir,
        token: input.token,
        instanceId: input.instanceId,
        state: 'consuming',
      });
    },
    input.openGate,
  );
  if (!gated.ok) return { ok: false, reason: gated.reason };
  const result = gated.value;
  if ('refused' in result) {
    return { ok: true, status: result.refused === 'alive' ? 'refused_foreign_alive' : 'refused_foreign_unknown' };
  }
  return result.ok ? { ok: true, status: 'registered' } : { ok: false, reason: result.reason };
}

/**
 * Remove every writer entry belonging to a given PID (this process). Used
 * when a workspace has no live consumer state — retired instances whose
 * async release is still pending, or leftovers of a crashed drain (r5).
 */
export function clearGatewayConsumerLeaseByPid(workspaceDir: string, pid: number): void {
  void withConsumerLeaseGate(workspaceDir, () => { clearGatewayConsumerLeaseByPidUngated(workspaceDir, pid); });
}

function clearGatewayConsumerLeaseByPidUngated(workspaceDir: string, pid: number): void {
  const current = readGatewayConsumerLease(workspaceDir);
  if (current === null) return;
  const writers = leaseWriters(current);
  const remaining = writers.filter((w) => w.pid !== pid);
  if (remaining.length === writers.length) return;
  if (remaining.length === 0) {
    try { fs.unlinkSync(leasePath(workspaceDir)); } catch { /* best effort */ }
    return;
  }
  const latest = remaining[remaining.length - 1]!;
  const next: GatewayConsumerLease = {
    ...current,
    token: latest.token, instanceId: latest.instanceId, pid: latest.pid, host: latest.host,
    state: latest.state, startedAt: latest.startedAt, updatedAt: latest.updatedAt,
    writers: remaining,
  };
  const tmpPath = `${leasePath(workspaceDir)}.tmp-${process.pid}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmpPath, leasePath(workspaceDir));
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
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
 * Process liveness and INSTANCE identity are judged separately (PRI-1282
 * r4): a lease carrying THIS process's PID but a different instanceId/token
 * is a DIFFERENT consumer (an older lifecycle of this process that may still
 * have in-flight work) — it is 'alive', never 'none'. Only our own
 * token/instanceId yields 'none' on a same-PID lease.
 */
export function foreignConsumerLeaseStatus(
  workspaceDir: string,
  opts?: {
    processAlive?: (pid: number) => 'alive' | 'dead' | 'unknown';
    selfToken?: string;
    selfInstanceId?: string;
  },
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
  // Judge EVERY recorded writer, not just the last one (PRI-1282 r5): the
  // top-level record only names the most recent publisher — a quiesced
  // Gateway followed by a still-consuming Gateway must surface as 'alive'.
  let sawUnknown = false;
  let sawAlive = false;
  for (const w of leaseWriters(parsed)) {
    // A 'quiesced' writer's lifecycle provably ended — take-over-able
    // evidence that consumer drained, not a live consumer.
    if (w.state === 'quiesced') continue;
    if (w.token === opts?.selfToken || w.instanceId === opts?.selfInstanceId) continue;
    if (w.pid === process.pid) {
      sawAlive = true; // different instance of this process
      continue;
    }
    if (w.host !== os.hostname()) {
      sawUnknown = true; // remote-holder liveness undecidable — fail closed
      continue;
    }
    const alive = (opts?.processAlive ?? processAliveProbe)(w.pid);
    if (alive === 'dead') continue;
    if (alive === 'alive') sawAlive = true;
    else sawUnknown = true;
  }
  if (sawAlive) return 'alive';
  if (sawUnknown) return 'unknown';
  return 'none';
}
