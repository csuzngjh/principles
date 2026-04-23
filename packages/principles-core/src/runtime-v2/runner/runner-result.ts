import type { PDErrorCategory } from '../error-categories.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';

export type RunnerResultStatus = 'succeeded' | 'failed' | 'retried';

export interface RunnerResult {
  /** Final status of the run attempt. */
  readonly status: RunnerResultStatus;
  /** The task this result pertains to. */
  readonly taskId: string;
  /** SHA-256 hash of the assembled context (set if context was built). */
  readonly contextHash?: string;
  /** The validated diagnostician output (set only when status=succeeded). */
  readonly output?: DiagnosticianOutputV1;
  /** Error category for the failure (set when status=failed or status=retried). */
  readonly errorCategory?: PDErrorCategory;
  /** Human-readable failure explanation. */
  readonly failureReason?: string;
  /** Number of attempts made on this task so far. */
  readonly attemptCount: number;
}
