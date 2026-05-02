/**
 * Principle Tree Ledger — pure file-based ledger for principle entries.
 *
 * Lives in principles-core so pd-cli can read/write the ledger without
 * importing openclaw-plugin private code.
 *
 * M8: Single-path ledger. The ledger file is at:
 *   {stateDir}/principle_training_state.json
 *
 * M8 key insight: ledger operations are single-process. No cross-process
 * locking needed for pd-cli usage. The file write is atomic (rename).
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from './io.js';

const PRINCIPLE_TRAINING_FILE = 'principle_training_state.json';

// ---------------------------------------------------------------------------
// Types (subset of openclaw-plugin types needed for ledger operations)
// ---------------------------------------------------------------------------

export type PrincipleStatus = 'candidate' | 'active' | 'archived' | 'deprecated' | 'probation';
export type PrinciplePriority = 'P0' | 'P1' | 'P2';
export type PrincipleScope = 'general' | 'domain';
export type PrincipleEvaluability = 'manual_only' | 'deterministic' | 'weak_heuristic';

export interface Principle {
  id: string;
  version: number;
  text: string;
  triggerPattern: string;
  action: string;
  status: PrincipleStatus;
  priority: PrinciplePriority;
  scope: PrincipleScope;
  evaluability: PrincipleEvaluability;
  valueScore: number;
  adherenceRate: number;
  painPreventedCount: number;
  derivedFromPainIds: string[];
  ruleIds: string[];
  conflictsWithPrincipleIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Rule {
  id: string;
  principleId: string;
  ruleIds: string[];
  implementationIds: string[];
  type?: string;
  status?: string;
  lifecycleState?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Implementation {
  id: string;
  ruleId: string;
  type?: string;
  lifecycleState?: string;
  [key: string]: unknown;
}

export interface PrincipleValueMetrics {
  principleId: string;
  painPreventedCount?: number;
  lastPainPreventedAt?: string;
  avgPainSeverityPrevented?: number;
  totalOpportunities?: number;
  adheredCount?: number;
  violatedCount?: number;
  implementationCost?: number;
  benefitScore?: number;
  calculatedAt?: string;
}

export interface LedgerPrinciple extends Principle {
  suggestedRules?: string[];
}

export interface LedgerRule extends Rule {
  implementationIds: string[];
}

export interface LedgerTreeStore {
  principles: Record<string, LedgerPrinciple>;
  rules: Record<string, LedgerRule>;
  implementations: Record<string, Implementation>;
  metrics: Record<string, PrincipleValueMetrics>;
  lastUpdated: string;
}

export interface LegacyPrincipleTrainingState {
  principleId: string;
  evaluability: 'deterministic' | 'weak_heuristic' | 'manual_only';
  applicableOpportunityCount: number;
  observedViolationCount: number;
  complianceRate: number;
  violationTrend: number;
  generatedSampleCount: number;
  approvedSampleCount: number;
  includedTrainRunIds: string[];
  deployedCheckpointIds: string[];
  lastEvalScore?: number;
  internalizationStatus:
    | 'prompt_only'
    | 'needs_training'
    | 'in_training'
    | 'deployed_pending_eval'
    | 'internalized'
    | 'regressed';
}

export type LegacyPrincipleTrainingStore = Record<string, LegacyPrincipleTrainingState>;

export interface HybridLedgerStore {
  trainingStore: LegacyPrincipleTrainingStore;
  tree: LedgerTreeStore;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TREE_NAMESPACE = '_tree';

const VALID_EVALUABILITIES = ['deterministic', 'weak_heuristic', 'manual_only'] as const;
const VALID_INTERNALIZATION_STATUSES = [
  'prompt_only', 'needs_training', 'in_training',
  'deployed_pending_eval', 'internalized', 'regressed',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((e): e is string => typeof e === 'string') : [];
}

function clampFloat(value: unknown, opts: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return opts.fallback;
  return Math.max(opts.min, Math.min(opts.max, value));
}

function clampInt(value: unknown, opts: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return opts.fallback;
  return Math.max(opts.min, Math.min(opts.max, Math.round(value)));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseLegacyTrainingStore(raw: unknown): LegacyPrincipleTrainingStore {
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

function parsePrinciples(raw: unknown): Record<string, LedgerPrinciple> {
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

function parseRules(raw: unknown): Record<string, LedgerRule> {
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

function parseImplementations(raw: unknown): Record<string, Implementation> {
  if (!isRecord(raw)) return {};
  const implementations: Record<string, Implementation> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.ruleId !== 'string') continue;
    implementations[id] = { ...value, id, ruleId: value.ruleId } as Implementation;
  }
  return implementations;
}

function parseMetrics(raw: unknown): Record<string, PrincipleValueMetrics> {
  if (!isRecord(raw)) return {};
  const metrics: Record<string, PrincipleValueMetrics> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    metrics[id] = { ...value, principleId: typeof value.principleId === 'string' ? value.principleId : id } as PrincipleValueMetrics;
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

function createEmptyTree(): LedgerTreeStore {
  return { principles: {}, rules: {}, implementations: {}, metrics: {}, lastUpdated: new Date(0).toISOString() };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseTree(raw: unknown): LedgerTreeStore {
  if (!isRecord(raw)) return createEmptyTree();
  return {
    principles: parsePrinciples(raw.principles),
    rules: parseRules(raw.rules),
    implementations: parseImplementations(raw.implementations),
    metrics: parseMetrics(raw.metrics),
    lastUpdated: typeof raw.lastUpdated === 'string' ? raw.lastUpdated : new Date(0).toISOString(),
  };
}

function getLedgerFilePath(stateDir: string): string {
  return path.join(stateDir, PRINCIPLE_TRAINING_FILE);
}

function readLedgerFromFile(filePath: string): HybridLedgerStore {
  if (!fs.existsSync(filePath)) {
    return { trainingStore: {}, tree: createEmptyTree() };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content || content.trim() === '') {
      return { trainingStore: {}, tree: createEmptyTree() };
    }
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) return { trainingStore: {}, tree: createEmptyTree() };
    const trainingStoreRaw = parsed.trainingStore ?? parsed;
    const treeRaw = parsed[TREE_NAMESPACE] ?? parsed.tree;
    return {
      trainingStore: parseLegacyTrainingStore(trainingStoreRaw),
      tree: parseTree(treeRaw),
    };
  } catch {
    return { trainingStore: {}, tree: createEmptyTree() };
  }
}

function serializeLedger(store: HybridLedgerStore): string {
  return JSON.stringify({
    ...store.trainingStore,
    [TREE_NAMESPACE]: { ...store.tree, lastUpdated: new Date().toISOString() },
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Ledger mutations (synchronous — safe for single-process use)
// ---------------------------------------------------------------------------

/**
 * Read-modify-write the ledger file atomically.
 * Safe for single-process CLI use. NOT safe for concurrent multi-process access.
 */
function mutateLedger<T>(stateDir: string, mutate: (store: HybridLedgerStore) => T): T {
  const filePath = getLedgerFilePath(stateDir);
  const store = readLedgerFromFile(filePath);
  const result = mutate(store);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(filePath, serializeLedger(store));
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadLedger(stateDir: string): HybridLedgerStore {
  return readLedgerFromFile(getLedgerFilePath(stateDir));
}

export function saveLedger(stateDir: string, store: HybridLedgerStore): void {
  mutateLedger(stateDir, (current) => {
    current.trainingStore = store.trainingStore;
    current.tree = store.tree;
  });
}

export function addPrincipleToLedger(stateDir: string, principle: LedgerPrinciple): LedgerPrinciple {
  return mutateLedger(stateDir, (store) => {
    store.tree.principles[principle.id] = principle;
    store.tree.lastUpdated = new Date().toISOString();
    return principle;
  });
}

export function updatePrinciple(stateDir: string, principleId: string, updates: Partial<LedgerPrinciple>): LedgerPrinciple {
  return mutateLedger(stateDir, (store) => {
    const existing = store.tree.principles[principleId];
    if (!existing) throw new Error(`Cannot update missing principle "${principleId}".`);
    const next: LedgerPrinciple = {
      ...existing,
      ...updates,
      id: principleId,
      ruleIds: updates.ruleIds ? uniqueStrings(updates.ruleIds) : existing.ruleIds,
      conflictsWithPrincipleIds: updates.conflictsWithPrincipleIds
        ? uniqueStrings(updates.conflictsWithPrincipleIds) : existing.conflictsWithPrincipleIds,
      derivedFromPainIds: updates.derivedFromPainIds
        ? uniqueStrings(updates.derivedFromPainIds) : existing.derivedFromPainIds,
    };
    store.tree.principles[principleId] = next;
    return next;
  });
}

export function updatePrincipleValueMetrics(stateDir: string, principleId: string, metrics: PrincipleValueMetrics): PrincipleValueMetrics {
  return mutateLedger(stateDir, (store) => {
    const next: PrincipleValueMetrics = { ...metrics, principleId };
    store.tree.metrics[principleId] = next;
    return next;
  });
}

export function getLedgerFilePathPublic(stateDir: string): string {
  return getLedgerFilePath(stateDir);
}
