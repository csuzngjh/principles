import { describe, it, expect } from 'vitest';
import { recordExecution } from '../../src/core/pd-task-reconciler.js';
import { BUILTIN_PD_TASKS } from '../../src/core/pd-task-types.js';

describe('PDTaskReconciler', () => {
  describe('recordExecution', () => {
    it('should add execution record with startedAt', () => {
      const task = { ...BUILTIN_PD_TASKS[0], meta: {} };
      const result = recordExecution(task, 'run-1', 'succeeded', 1000);

      expect(result.meta!.executionHistory).toHaveLength(1);
      expect(result.meta!.executionHistory![0].runId).toBe('run-1');
      expect(result.meta!.executionHistory![0].startedAt).toBe(1000);
      expect(result.meta!.executionHistory![0].endedAt!).toBeGreaterThanOrEqual(1000);
    });

    it('should record error for failed execution', () => {
      const task = { ...BUILTIN_PD_TASKS[0], meta: {} };
      const result = recordExecution(task, 'run-2', 'failed', 1000, 'Timeout');

      expect(result.meta!.executionHistory![0].error).toBe('Timeout');
    });

    it('should limit history to 100 records', () => {
      const task = {
        ...BUILTIN_PD_TASKS[0],
        meta: {
          executionHistory: Array.from({ length: 100 }, (_, i) => ({
            runId: `run-${i}`,
            status: 'succeeded' as const,
            startedAt: i,
            endedAt: i,
          })),
        },
      };

      const result = recordExecution(task, 'run-new', 'succeeded', 99999);

      expect(result.meta!.executionHistory!).toHaveLength(100);
      expect(result.meta!.executionHistory![99].runId).toBe('run-new');
    });
  });
});
