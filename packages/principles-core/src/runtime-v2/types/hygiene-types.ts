/**
 * Hygiene Tracking Types
 */
import { Type, type Static } from '@sinclair/typebox';

export interface PersistenceAction {
  ts: string;
  tool: string;
  path: string;
  type: 'memory' | 'plan' | 'other';
  contentLength: number;
}

export const PersistenceActionSchema = Type.Object({
  ts: Type.String(),
  tool: Type.String(),
  path: Type.String(),
  type: Type.Union([Type.Literal('memory'), Type.Literal('plan'), Type.Literal('other')]),
  contentLength: Type.Number(),
});
export type PersistenceActionStatic = Static<typeof PersistenceActionSchema>;

export interface HygieneStats {
  date: string;
  persistenceCount: number;
  persistenceByFile: Record<string, number>;
  lastPersistenceTime?: string;
  totalCharsPersisted: number;
  groomingExecutedCount: number;
  lastGroomingTime?: string;
}

export const HygieneStatsSchema = Type.Object({
  date: Type.String(),
  persistenceCount: Type.Number(),
  persistenceByFile: Type.Record(Type.String(), Type.Number()),
  lastPersistenceTime: Type.Optional(Type.String()),
  totalCharsPersisted: Type.Number(),
  groomingExecutedCount: Type.Number(),
  lastGroomingTime: Type.Optional(Type.String()),
});
export type HygieneStatsStatic = Static<typeof HygieneStatsSchema>;

export function createEmptyHygieneStats(date: string): HygieneStats {
  return {
    date,
    persistenceCount: 0,
    persistenceByFile: {},
    totalCharsPersisted: 0,
    groomingExecutedCount: 0,
  };
}
