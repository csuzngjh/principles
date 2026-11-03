/**
 * Call deadline — SPEC-PD-MCP-GATE4-001 §4.7 (Gate 4 Adapter responsibility).
 *
 * Every tool call gets at most `deadlineMs` (production: 10 s) counted from
 * handler entry, covering input validation, capability call, projection and
 * JSON serialization. The Gate 3 Capability exposes no AbortSignal, so this
 * is HONEST non-cancellation: on expiry we stop waiting, suppress the late
 * result (a timeout must never later be reported as success), and track the
 * still-running operation in a bounded orphan set whose eventual settlement
 * is observed — proving resources are released (§4.7). `Promise.race` here is
 * explicitly NOT claimed as underlying cancellation.
 */

export const DEFAULT_DEADLINE_MS = 10_000 as const;

/** Upper bound on concurrently EXECUTING capability calls (§4.7). Admission
 * is reserved synchronously before the capability is called, so the bound is
 * real even when every in-flight call later outlives its deadline. Small by
 * design: a read-only recall that takes >10 s is already pathological; four
 * concurrent ones is a stuck host, not load. */
export const MAX_CONCURRENT_CALLS = 4 as const;

/** Upper bound on still-running timed-out operations. Orphans are a subset of
 * admitted calls; this registry keeps their settlement observable even after
 * the caller stopped waiting (§4.7 “限制仍在运行的超时任务数量”). */
export const MAX_TRACKED_ORPHANS = 4 as const;

export type DeadlineOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly timedOut: true };

/**
 * Run `fn` under a deadline. On timeout the returned promise settles
 * `{ timedOut }` immediately while `fn`'s promise keeps running; it is handed
 * to `onOrphan` (the caller registers it in the orphan limiter). If
 * `onOrphan` returns false (limiter saturated), the caller must refuse new
 * work — the operation is still tracked for settlement by the race itself.
 */
export async function runWithDeadline<T>(
  fn: () => Promise<T>,
  deadlineMs: number,
  onOrphan?: (orphaned: Promise<T>) => boolean
): Promise<DeadlineOutcome<T>> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timerPromise = new Promise<void>((resolveTimer) => {
    timer = setTimeout(() => resolveTimer(), deadlineMs);
    // Never hold the event loop open for the deadline alone.
    (timer as { unref?: () => void }).unref?.();
  });
  const work = fn();
  const winner = await Promise.race([
    work.then((value) => ({ kind: 'value' as const, value })),
    timerPromise.then(() => ({ kind: 'timeout' as const })),
  ]);
  if (winner.kind === 'value') {
    if (timer !== undefined) clearTimeout(timer);
    // The timer cannot fire while synchronous work blocks the loop, so a value
    // that raced in just before the deadline but finished assembling after it
    // would otherwise be reported as an in-time success. The window covers
    // validation → capability → projection → serialization (§4.7): past the
    // deadline, this is a miss. The underlying promise already settled, so no
    // orphan exists and no capacity is left reserved.
    if (Date.now() - startedAt < deadlineMs) return { ok: true, value: winner.value };
    return { ok: false, timedOut: true };
  }
  if (onOrphan) onOrphan(work);
  // Observe settlement so a rejected orphan never becomes an unhandled
  // rejection long after the caller stopped caring (resource hygiene).
  void work.catch(() => undefined);
  return { ok: false, timedOut: true };
}

/**
 * Bounded registry of still-running timed-out operations. `register` refuses
 * (returns false) once `max` orphans are unsettled; settled promises remove
 * themselves, so the limit reflects *currently running* stragglers only.
 */
export class OrphanLimiter {
  readonly #max: number;
  readonly #orphans = new Set<Promise<unknown>>();

  constructor(max: number = MAX_TRACKED_ORPHANS) {
    this.#max = max;
  }

  get size(): number {
    return this.#orphans.size;
  }

  get saturated(): boolean {
    return this.#orphans.size >= this.#max;
  }

  register(orphaned: Promise<unknown>): boolean {
    if (this.saturated) return false;
    const observed = orphaned.then(
      () => undefined,
      () => undefined
    );
    this.#orphans.add(observed);
    void observed.then(() => {
      this.#orphans.delete(observed);
    });
    return true;
  }
}

/**
 * Synchronous admission semaphore for executing capability calls (§4.7).
 *
 * The previous design only counted already-timed-out stragglers, so N requests
 * could all pass the saturation check before any of them timed out and then
 * start N > limit capability calls. Admission is now reserved at handler entry
 * — BEFORE the capability is invoked — and released only when the underlying
 * work actually settles (normal completion, exception, or an orphaned call
 * that outlived its deadline). A timeout therefore stops the WAIT, never the
 * capacity reservation.
 */
export class AdmissionLimiter {
  readonly #max: number;
  #active = 0;

  constructor(max: number = MAX_CONCURRENT_CALLS) {
    if (!Number.isInteger(max) || max < 1) throw new Error('admission limit must be a positive integer');
    this.#max = max;
  }

  get max(): number {
    return this.#max;
  }

  /** Number of admitted calls whose underlying work has not settled yet. */
  get active(): number {
    return this.#active;
  }

  get saturated(): boolean {
    return this.#active >= this.#max;
  }

  /** Reserve one execution slot. Never awaits — the check and the reservation
   * are one synchronous step, so concurrent handlers cannot both pass. */
  tryAcquire(): boolean {
    if (this.saturated) return false;
    this.#active += 1;
    return true;
  }

  /** Release a previously reserved slot. Exactly one release per successful
   * acquire; underflow is a programming error and fails loud. */
  release(): void {
    if (this.#active <= 0) throw new Error('admission release without a matching acquire');
    this.#active -= 1;
  }
}
