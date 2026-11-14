/**
 * Lease Heartbeat — SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.2.
 *
 * Before this module the pipeline had no production lease renewal at all:
 * `BasePeerRunner` acquired a 300 s lease and ran a 300 s stage, and the
 * consumer cycle reclaims expired leases every cycle. Any stage that crossed
 * its lease was therefore recovered *while still executing*, and the reclaimed
 * worker could still write a terminal state.
 *
 * The heartbeat keeps a lease alive for as long as the worker is genuinely
 * working, and — more importantly — records a *lost* verdict when renewal
 * cannot prove ownership. Callers MUST consult `assertOwned()` before any
 * terminal write, so a worker that lost the lease cannot "come back" and
 * commit a stale result.
 *
 * Design constraints:
 *   - same `owner` identity as acquisition (renewal is owner-checked in SQL);
 *   - a recursive timeout, never `setInterval`: renewals cannot overlap;
 *   - failures are loud (event + `lastError`), never swallowed;
 *   - timers and clock are injectable so tests never wait on wall-clock time.
 */

export type LeaseHeartbeatState = 'idle' | 'running' | 'stopped' | 'lost';

export interface LeaseOwnershipSnapshot {
  readonly status: string;
  readonly leaseOwner?: string | null;
}

export interface LeaseHeartbeatEvent {
  readonly type: 'renewed' | 'renewal_failed' | 'ownership_lost';
  readonly taskId: string;
  readonly owner: string;
  readonly renewalCount: number;
  readonly occurredAt: string;
  readonly detail?: string;
}

export interface LeaseHeartbeatOptions {
  readonly taskId: string;
  readonly owner: string;
  /** Lease validity window that each renewal must re-establish. */
  readonly leaseTtlMs: number;
  /** Renewal cadence; must be strictly below `leaseTtlMs`. */
  readonly intervalMs: number;
  readonly renewLease: (taskId: string, owner: string, durationMs: number) => Promise<unknown>;
  /**
   * Ownership probe used at commit time. Without it `assertOwned()` can only
   * report the local heartbeat verdict (a failed renewal), not a takeover that
   * happened between two renewals.
   */
  readonly readOwnership?: (taskId: string) => Promise<LeaseOwnershipSnapshot | null>;
  readonly emit?: (event: LeaseHeartbeatEvent) => void;
  readonly setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  readonly now?: () => Date;
}

function defaultSetTimeout(handler: () => void, ms: number): unknown {
  // A heartbeat must never keep a short-lived CLI process alive on its own.
  const timer = setTimeout(handler, ms) as ReturnType<typeof setTimeout> & { unref?: () => void };
  timer.unref?.();
  return timer;
}

function defaultClearTimeout(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

export class LeaseHeartbeat {
  private state: LeaseHeartbeatState = 'idle';
  private timerHandle: unknown = null;
  private inFlight: Promise<void> | null = null;
  private renewalCountValue = 0;
  private lastRenewedAtValue: string | null = null;
  private lastErrorValue: string | null = null;
  private readonly setTimeoutFn: (handler: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly now: () => Date;

  public constructor(private readonly options: LeaseHeartbeatOptions) {
    this.setTimeoutFn = options.setTimeoutFn ?? defaultSetTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? defaultClearTimeout;
    this.now = options.now ?? (() => new Date());
  }

  public get status(): LeaseHeartbeatState {
    return this.state;
  }

  /** True once a renewal (or ownership probe) proved the worker lost the lease. */
  public get lost(): boolean {
    return this.state === 'lost';
  }

  public get renewalCount(): number {
    return this.renewalCountValue;
  }

  public get lastRenewedAt(): string | null {
    return this.lastRenewedAtValue;
  }

  public get lastError(): string | null {
    return this.lastErrorValue;
  }

  /** Begin periodic renewal. Idempotent while running. */
  public start(): void {
    if (this.state === 'running') return;
    if (this.state === 'lost') return; // a lost lease can never be re-acquired here
    this.state = 'running';
    this.scheduleNext();
  }

  /**
   * Stop renewing and wait for an in-flight renewal to settle.
   *
   * Awaiting matters: a renewal racing with `stop()` must not update the row
   * after the caller believes the lease is released.
   */
  public async stop(): Promise<void> {
    if (this.state !== 'lost') {
      this.state = 'stopped';
    }
    this.clearTimer();
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // tick() already recorded the failure; stop() must not rethrow it.
      }
    }
  }

  /**
   * Commit-time ownership verdict.
   *
   * A local `lost` state is already disqualifying. When an ownership probe is
   * configured, the persisted row is the final authority: status must still be
   * `leased` and `lease_owner` must still be this worker. A probe error fails
   * closed (not owned) and is recorded, because an unprovable ownership claim
   * must never be treated as proof (P1 — evidence over assumption).
   *
   * A MISSING row is different from a contradictory row: the absence of
   * evidence cannot distinguish "concurrently deleted" from a harness that
   * never persisted the row, so it does not fabricate a takeover verdict. The
   * heartbeat's own renewal failures remain the takeover detector in that
   * case, and a terminal write against a deleted task fails loudly in the
   * store (`storage_unavailable`) anyway.
   */
  public async assertOwned(): Promise<boolean> {
    if (this.state === 'lost') return false;
    if (!this.options.readOwnership) return true;
    let snapshot: LeaseOwnershipSnapshot | null;
    try {
      snapshot = await this.options.readOwnership(this.options.taskId);
    } catch (error) {
      this.markLost('ownership_probe_failed', error instanceof Error ? error.message : String(error));
      return false;
    }
    if (!snapshot) return true;
    if (snapshot.status !== 'leased' || snapshot.leaseOwner !== this.options.owner) {
      this.markLost(
        'ownership_probe_mismatch',
        `expected leased/${this.options.owner}, observed ${snapshot.status}/${snapshot.leaseOwner ?? 'none'}`,
      );
      return false;
    }
    return true;
  }

  private scheduleNext(): void {
    if (this.state !== 'running') return;
    this.timerHandle = this.setTimeoutFn(() => {
      this.inFlight = this.tick().finally(() => {
        this.inFlight = null;
      });
    }, this.options.intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.state !== 'running') return;
    try {
      await this.options.renewLease(this.options.taskId, this.options.owner, this.options.leaseTtlMs);
      this.renewalCountValue += 1;
      this.lastRenewedAtValue = this.now().toISOString();
      this.options.emit?.({
        type: 'renewed',
        taskId: this.options.taskId,
        owner: this.options.owner,
        renewalCount: this.renewalCountValue,
        occurredAt: this.lastRenewedAtValue,
      });
      this.scheduleNext();
    } catch (error) {
      this.markLost('renewal_failed', error instanceof Error ? error.message : String(error));
    }
  }

  private markLost(type: 'renewal_failed' | 'ownership_probe_failed' | 'ownership_probe_mismatch', detail: string): void {
    if (this.state === 'lost') return;
    this.state = 'lost';
    this.lastErrorValue = `${type}: ${detail}`;
    this.clearTimer();
    this.options.emit?.({
      type: type === 'renewal_failed' ? 'renewal_failed' : 'ownership_lost',
      taskId: this.options.taskId,
      owner: this.options.owner,
      renewalCount: this.renewalCountValue,
      occurredAt: this.now().toISOString(),
      detail: this.lastErrorValue,
    });
  }

  private clearTimer(): void {
    if (this.timerHandle !== null) {
      this.clearTimeoutFn(this.timerHandle);
      this.timerHandle = null;
    }
  }
}
