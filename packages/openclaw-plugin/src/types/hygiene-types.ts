/**
 * Hygiene Tracking Types
 */

export interface PersistenceAction {
  ts: string;
  tool: string;
  path: string;
  type: 'memory' | 'plan' | 'other';
  contentLength: number;
}

export interface HygieneStats {
  date: string;
  persistenceCount: number;
  persistenceByFile: Record<string, number>;
  lastPersistenceTime?: string;
  totalCharsPersisted: number;
  groomingExecutedCount: number;
  lastGroomingTime?: string;
}

export function createEmptyHygieneStats(date: string): HygieneStats {
  return {
    date,
    persistenceCount: 0,
    persistenceByFile: {},
    totalCharsPersisted: 0,
    groomingExecutedCount: 0,
  };
}
