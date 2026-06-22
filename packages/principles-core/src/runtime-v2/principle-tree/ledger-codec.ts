/**
 * Ledger codec — pure parse/serialize functions, zero I/O.
 *
 * Extracted from principle-tree-ledger.ts (PRI-443) to separate pure logic
 * from filesystem operations. This module has zero fs/path imports.
 */

import type {
  LegacyPrincipleTrainingStore,
  LegacyPrincipleTrainingState,
  LedgerPrinciple,
  LedgerRule,
  Implementation,
  PrincipleValueMetrics,
  LedgerTreeStore,
  HybridLedgerStore,
} from '../types/ledger-store.js';
import { TREE_NAMESPACE } from '../types/ledger-store.js';

const VALID_EVALUABILITIES = ['deterministic', 'weak_heuristic', 'manual_only'] as const;
const VALID_INTERNALIZATION_STATUSES = [
  'prompt_only', 'needs_training', 'in_training',
  'deployed_pending_eval', 'internalized', 'regressed',
] as const;

// --- Helpers ---

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((e): e is string => typeof e === 'string') : [];
}

export function clampFloat(value: unknown, opts: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return opts.fallback;
  return Math.max(opts.min, Math.min(opts.max, value));
}

export function clampInt(value: unknown, opts: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return opts.fallback;
  return Math.max(opts.min, Math.min(opts.max, Math.round(value)));
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

// --- Parsers ---

export function parseLegacyTrainingStore(raw: unknown): LegacyPrincipleTrainingStore {
  if (!isRecord(raw)) return {};
  const result: LegacyPrincipleTrainingStore = {};
  for (const [principleId, candidate] of Object.entries(raw)) {
    if (principleId === TREE_NAMESPACE || !isRecord(candidate)) continue;
    if (candidate.principleId !== principleId) continue;
    result[principleId] = {
      principleId,
      evaluability: VALID_EVALUABILITIES.includes(candidate.evaluability as typeof VALID_EVALUABILITIES[number])
        ? candidate.evaluability as LegacyPrincipleTrainingState['evaluability']
        : 'manual_only',
      applicableOpportunityCount: clampInt(candidate.applicableOpportunityCount, { min: 0, max: Infinity, fallback: 0 }),
      observedViolationCount: clampInt(candidate.observedViolationCount, { min: 0, max: Infinity, fallback: 0 }),
      complianceRate: clampFloat(candidate.complianceRate, { min: 0, max: 1, fallback: 0 }),
      violationTrend: clampFloat(candidate.violationTrend, { min: -1, max: 1, fallback: 0 }),
      generatedSampleCount: clampInt(candidate.generatedSampleCount, { min: 0, max: Infinity, fallback: 0 }),
      approvedSampleCount: clampInt(candidate.approvedSampleCount, { min: 0, max: Infinity, fallback: 0 }),
      includedTrainRunIds: stringArray(candidate.includedTrainRunIds),
      deployedCheckpointIds: stringArray(candidate.deployedCheckpointIds),
      lastEvalScore: typeof candidate.lastEvalScore === 'number' && Number.isFinite(candidate.lastEvalScore)
        ? clampFloat(candidate.lastEvalScore, { min: 0, max: 1, fallback: 0 }) : undefined,
      internalizationStatus: VALID_INTERNALIZATION_STATUSES.includes(
        candidate.internalizationStatus as typeof VALID_INTERNALIZATION_STATUSES[number],
      )
        ? candidate.internalizationStatus as LegacyPrincipleTrainingState['internalizationStatus']
        : 'prompt_only',
    };
  }
  return result;
}

export function parsePrinciples(raw: unknown): Record<string, LedgerPrinciple> {
  if (!isRecord(raw)) return {};
  const principles: Record<string, LedgerPrinciple> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    principles[id] = {
      ...value,
      id,
      ruleIds: stringArray(value.ruleIds),
      conflictsWithPrincipleIds: stringArray(value.conflictsWithPrincipleIds),
      derivedFromPainIds: stringArray(value.derivedFromPainIds),
    } as LedgerPrinciple;
  }
  return principles;
}

export function parseRules(raw: unknown): Record<string, LedgerRule> {
  if (!isRecord(raw)) return {};
  const rules: Record<string, LedgerRule> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    rules[id] = {
      ...value,
      id,
      principleId: typeof value.principleId === 'string' ? value.principleId : '',
      implementationIds: stringArray(value.implementationIds),
    } as LedgerRule;
  }
  return rules;
}

export function parseImplementations(raw: unknown): Record<string, Implementation> {
  if (!isRecord(raw)) return {};
  const implementations: Record<string, Implementation> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.ruleId !== 'string') continue;
    implementations[id] = { ...value, id, ruleId: value.ruleId };
  }
  return implementations;
}

export function parseMetrics(raw: unknown): Record<string, PrincipleValueMetrics> {
  if (!isRecord(raw)) return {};
  const metrics: Record<string, PrincipleValueMetrics> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    metrics[id] = { ...value, principleId: typeof value.principleId === 'string' ? value.principleId : id };
  }
  return metrics;
}

// --- Store factory ---

export function createEmptyTree(): LedgerTreeStore {
  return { principles: {}, rules: {}, implementations: {}, metrics: {}, lastUpdated: new Date(0).toISOString() };
}

// --- Tree parser ---

export function parseTree(raw: unknown): LedgerTreeStore {
  if (!isRecord(raw)) return createEmptyTree();
  return {
    principles: parsePrinciples(raw.principles),
    rules: parseRules(raw.rules),
    implementations: parseImplementations(raw.implementations),
    metrics: parseMetrics(raw.metrics),
    lastUpdated: typeof raw.lastUpdated === 'string' ? raw.lastUpdated : new Date(0).toISOString(),
  };
}

// --- Hybrid ledger parser ---

export function parseHybridLedger(raw: unknown): HybridLedgerStore {
  if (!isRecord(raw)) return { trainingStore: {}, tree: createEmptyTree() };
  const trainingStoreRaw = raw.trainingStore ?? raw;
  const treeRaw = raw[TREE_NAMESPACE] ?? raw.tree;
  return {
    trainingStore: parseLegacyTrainingStore(trainingStoreRaw),
    tree: parseTree(treeRaw),
  };
}

// --- Serializer ---

export function serializeLedger(store: HybridLedgerStore): string {
  return JSON.stringify({
    ...store.trainingStore,
    [TREE_NAMESPACE]: { ...store.tree, lastUpdated: new Date().toISOString() },
  }, null, 2);
}
