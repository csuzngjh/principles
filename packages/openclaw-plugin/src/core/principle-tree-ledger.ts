import * as fs from 'fs';
import * as path from 'path';
import { withLock, withLockAsync } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/io.js';
import type {
  Implementation,
  ImplementationLifecycleState,
  Principle,
  PrincipleTreeStore,
  PrincipleValueMetrics,
  Rule,
} from '../types/principle-tree-schema.js';

const PRINCIPLE_TRAINING_FILE = 'principle_training_state.json';

export const TREE_NAMESPACE = '_tree';

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

export interface LedgerPrinciple extends Principle {
  suggestedRules?: string[];
}

export interface LedgerRule extends Rule {
  implementationIds: string[];
}

export interface LedgerTreeStore extends Omit<PrincipleTreeStore, 'principles' | 'rules'> {
  principles: Record<string, LedgerPrinciple>;
  rules: Record<string, LedgerRule>;
}

export interface HybridLedgerStore {
  trainingStore: LegacyPrincipleTrainingStore;
  tree: LedgerTreeStore;
}

export interface PrincipleSubtree {
  principle: LedgerPrinciple;
  rules: {
    rule: LedgerRule;
    implementations: Implementation[];
  }[];
}

const VALID_EVALUABILITIES = ['deterministic', 'weak_heuristic', 'manual_only'] as const;
const VALID_INTERNALIZATION_STATUSES = [
  'prompt_only',
  'needs_training',
  'in_training',
  'deployed_pending_eval',
  'internalized',
  'regressed',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

 
 
function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

 
 
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function createEmptyTree(): LedgerTreeStore {
  return {
    principles: {},
    rules: {},
    implementations: {},
    metrics: {},
    lastUpdated: new Date(0).toISOString(),
  };
}

function parseLegacyTrainingStore(raw: unknown): LegacyPrincipleTrainingStore {
  if (!isRecord(raw)) {
    return {};
  }

  const result: LegacyPrincipleTrainingStore = {};

  for (const [principleId, candidate] of Object.entries(raw)) {
    if (principleId === TREE_NAMESPACE || !isRecord(candidate)) {
      continue;
    }

    if (candidate.principleId !== principleId) {
      continue;
    }

    const evaluability = VALID_EVALUABILITIES.includes(candidate.evaluability as (typeof VALID_EVALUABILITIES)[number])
      ? candidate.evaluability as LegacyPrincipleTrainingState['evaluability']
      : 'manual_only';
    const internalizationStatus = VALID_INTERNALIZATION_STATUSES.includes(
      candidate.internalizationStatus as (typeof VALID_INTERNALIZATION_STATUSES)[number],
    )
      ? candidate.internalizationStatus as LegacyPrincipleTrainingState['internalizationStatus']
      : 'prompt_only';
    const rawLastEvalScore = candidate.lastEvalScore;

    result[principleId] = {
      principleId,
      evaluability,
      applicableOpportunityCount: clampInt(candidate.applicableOpportunityCount, 0, Number.POSITIVE_INFINITY, 0),
      observedViolationCount: clampInt(candidate.observedViolationCount, 0, Number.POSITIVE_INFINITY, 0),
      complianceRate: clampFloat(candidate.complianceRate, 0, 1, 0),
      violationTrend: clampFloat(candidate.violationTrend, -1, 1, 0),
      generatedSampleCount: clampInt(candidate.generatedSampleCount, 0, Number.POSITIVE_INFINITY, 0),
      approvedSampleCount: clampInt(candidate.approvedSampleCount, 0, Number.POSITIVE_INFINITY, 0),
      includedTrainRunIds: stringArray(candidate.includedTrainRunIds),
      deployedCheckpointIds: stringArray(candidate.deployedCheckpointIds),
      lastEvalScore:
        typeof rawLastEvalScore === 'number' && Number.isFinite(rawLastEvalScore)
          ? clampFloat(rawLastEvalScore, 0, 1, 0)
          : undefined,
      internalizationStatus,
    };
  }

  return result;
}

function parsePrinciples(raw: unknown): Record<string, LedgerPrinciple> {
  if (!isRecord(raw)) {
    return {};
  }

  const principles: Record<string, LedgerPrinciple> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      continue;
    }

    const suggestedRules = stringArray(value.suggestedRules);
    principles[id] = {
      ...value,
      id,
      ruleIds: stringArray(value.ruleIds),
      conflictsWithPrincipleIds: stringArray(value.conflictsWithPrincipleIds),
      derivedFromPainIds: stringArray(value.derivedFromPainIds),
      ...(Object.prototype.hasOwnProperty.call(value, 'suggestedRules') ? { suggestedRules } : {}),
    } as LedgerPrinciple;
  }

  return principles;
}

function parseRules(raw: unknown): Record<string, LedgerRule> {
  if (!isRecord(raw)) {
    return {};
  }

  const rules: Record<string, LedgerRule> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      continue;
    }

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
  if (!isRecord(raw)) {
    return {};
  }

  const implementations: Record<string, Implementation> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.ruleId !== 'string') {
      continue;
    }

    implementations[id] = {
      ...value,
      id,
      ruleId: value.ruleId,
    } as Implementation;
  }

  return implementations;
}

function parseMetrics(raw: unknown): Record<string, PrincipleValueMetrics> {
  if (!isRecord(raw)) {
    return {};
  }

  const metrics: Record<string, PrincipleValueMetrics> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      continue;
    }

    metrics[id] = {
      ...value,
      principleId: typeof value.principleId === 'string' ? value.principleId : id,
    } as PrincipleValueMetrics;
  }

  return metrics;
}

function parseTree(raw: unknown): LedgerTreeStore {
  if (!isRecord(raw)) {
    return createEmptyTree();
  }

  return {
    principles: parsePrinciples(raw.principles),
    rules: parseRules(raw.rules),
    implementations: parseImplementations(raw.implementations),
    metrics: parseMetrics(raw.metrics),
    lastUpdated: typeof raw.lastUpdated === 'string' ? raw.lastUpdated : new Date(0).toISOString(),
  };
}

function serializeLedger(store: HybridLedgerStore): string {
  return JSON.stringify(
    {
      ...store.trainingStore,
      [TREE_NAMESPACE]: {
        ...store.tree,
        lastUpdated: new Date().toISOString(),
      },
    },
    null,
    2,
  );
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readLedgerFromFile(filePath: string): HybridLedgerStore {
  if (!fs.existsSync(filePath)) {
    return {
      trainingStore: {},
      tree: createEmptyTree(),
    };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content || content.trim() === '') {
      return { trainingStore: {}, tree: createEmptyTree() };
    }
    const parsed = JSON.parse(content) as unknown;
    const raw = isRecord(parsed) ? parsed : {};
    // #219: Handle both formats:
    // - New format: { trainingStore: {...}, tree: {...} }
    // - Legacy format: { P_xxx: {...}, _tree: {...} }
    const trainingStoreRaw = raw.trainingStore ?? raw;
    const treeRaw = raw[TREE_NAMESPACE] ?? raw.tree;
    return {
      trainingStore: parseLegacyTrainingStore(trainingStoreRaw),
      tree: parseTree(treeRaw),
    };
  } catch (err) {
    console.error(`[principle-tree-ledger] Failed to load ledger from ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return { trainingStore: {}, tree: createEmptyTree() };
  }
}

function writeLedgerUnlocked(filePath: string, store: HybridLedgerStore): void {
  ensureParentDir(filePath);
  atomicWriteFileSync(filePath, serializeLedger(store));
}

 
function mutateLedger<T>(stateDir: string, mutate: (store: HybridLedgerStore) => T): T {
   
   
  const filePath = getLedgerFilePath(stateDir);
  return withLock(filePath, () => {
    const store = readLedgerFromFile(filePath);
    const result = mutate(store);
    writeLedgerUnlocked(filePath, store);
    return result;
  });
}

 
async function mutateLedgerAsync<T>(stateDir: string, mutate: (store: HybridLedgerStore) => Promise<T>): Promise<T> {
   
   
  const filePath = getLedgerFilePath(stateDir);
  return withLockAsync(filePath, async () => {
    const store = readLedgerFromFile(filePath);
    const result = await mutate(store);
    writeLedgerUnlocked(filePath, store);
    return result;
  });
}

export function getLedgerFilePath(stateDir: string): string {
  return path.join(stateDir, PRINCIPLE_TRAINING_FILE);
}

export function loadLedger(stateDir: string): HybridLedgerStore {
  return readLedgerFromFile(getLedgerFilePath(stateDir));
}

export function saveLedger(stateDir: string, store: HybridLedgerStore): void {
  mutateLedger(stateDir, (current) => {
    current.trainingStore = store.trainingStore;
    current.tree = store.tree;
  });
}

export async function saveLedgerAsync(stateDir: string, store: HybridLedgerStore): Promise<void> {
  await mutateLedgerAsync(stateDir, async (current) => {
    current.trainingStore = store.trainingStore;
    current.tree = store.tree;
  });
}

export function updateTrainingStore(
  stateDir: string,

  mutate: (store: LegacyPrincipleTrainingStore) => void,
): void {
  mutateLedger(stateDir, (store) => {
    mutate(store.trainingStore);
  });
}

/**
 * Add a new principle directly to the ledger tree.
 * This is the companion to updatePrinciple() — use this when creating a NEW
 * principle so the compiler can find it in tree.principles.
 *
 * Idempotent: if the principle already exists, overwrites (update semantics).
 */
export function addPrincipleToLedger(
  stateDir: string,
  principle: LedgerPrinciple,
): LedgerPrinciple {
  return mutateLedger(stateDir, (store) => {
    store.tree.principles[principle.id] = principle;
    store.tree.lastUpdated = new Date().toISOString();
    return principle;
  });
}

export function createRule(stateDir: string, rule: LedgerRule): LedgerRule {
  return mutateLedger(stateDir, (store) => {
    const principle = store.tree.principles[rule.principleId];
    if (!principle) {
      throw new Error(`Cannot create rule "${rule.id}" for missing principle "${rule.principleId}".`);
    }

    const nextRule: LedgerRule = {
      ...rule,
      implementationIds: uniqueStrings(rule.implementationIds),
    };
    store.tree.rules[nextRule.id] = nextRule;
    principle.ruleIds = uniqueStrings([...principle.ruleIds, nextRule.id]);
    return nextRule;
  });
}

export function createImplementation(stateDir: string, implementation: Implementation): Implementation {
  return mutateLedger(stateDir, (store) => {
    const rule = store.tree.rules[implementation.ruleId];
    if (!rule) {
      throw new Error(`Cannot create implementation "${implementation.id}" for missing rule "${implementation.ruleId}".`);
    }

    store.tree.implementations[implementation.id] = implementation;
    rule.implementationIds = uniqueStrings([...rule.implementationIds, implementation.id]);
    return implementation;
  });
}

export function updatePrinciple(
  stateDir: string,
  principleId: string,
  updates: Partial<LedgerPrinciple>,
): LedgerPrinciple {
  return mutateLedger(stateDir, (store) => {
    const existingPrinciple = store.tree.principles[principleId];
    if (!existingPrinciple) {
      throw new Error(`Cannot update missing principle "${principleId}".`);
    }

    const nextPrinciple: LedgerPrinciple = {
      ...existingPrinciple,
      ...updates,
      id: principleId,
      ruleIds: updates.ruleIds ? uniqueStrings(updates.ruleIds) : existingPrinciple.ruleIds,
      conflictsWithPrincipleIds: updates.conflictsWithPrincipleIds
        ? uniqueStrings(updates.conflictsWithPrincipleIds)
        : existingPrinciple.conflictsWithPrincipleIds,
      derivedFromPainIds: updates.derivedFromPainIds
        ? uniqueStrings(updates.derivedFromPainIds)
        : existingPrinciple.derivedFromPainIds,
      ...(Object.prototype.hasOwnProperty.call(updates, 'suggestedRules')
        ? { suggestedRules: uniqueStrings(updates.suggestedRules ?? []) }
        : Object.prototype.hasOwnProperty.call(existingPrinciple, 'suggestedRules')
          ? { suggestedRules: existingPrinciple.suggestedRules }
          : {}),
    };

    store.tree.principles[principleId] = nextPrinciple;
    return nextPrinciple;
  });
}

export function updateRule(stateDir: string, ruleId: string, updates: Partial<LedgerRule>): LedgerRule {
  return mutateLedger(stateDir, (store) => {
    const existingRule = store.tree.rules[ruleId];
    if (!existingRule) {
      throw new Error(`Cannot update missing rule "${ruleId}".`);
    }

    const nextPrincipleId = updates.principleId ?? existingRule.principleId;
    const nextPrinciple = store.tree.principles[nextPrincipleId];
    if (!nextPrinciple) {
      throw new Error(`Cannot move rule "${ruleId}" to missing principle "${nextPrincipleId}".`);
    }

    const nextRule: LedgerRule = {
      ...existingRule,
      ...updates,
      id: ruleId,
      principleId: nextPrincipleId,
      implementationIds: updates.implementationIds
        ? uniqueStrings(updates.implementationIds)
        : existingRule.implementationIds,
    };

    if (existingRule.principleId !== nextPrincipleId) {
      const previousPrinciple = store.tree.principles[existingRule.principleId];
      if (previousPrinciple) {
        previousPrinciple.ruleIds = previousPrinciple.ruleIds.filter((candidateId) => candidateId !== ruleId);
      }
      nextPrinciple.ruleIds = uniqueStrings([...nextPrinciple.ruleIds, ruleId]);
    }

    store.tree.rules[ruleId] = nextRule;
    return nextRule;
  });
}

export function deleteRule(stateDir: string, ruleId: string): LedgerRule | undefined {
  return mutateLedger(stateDir, (store) => {
    const existingRule = store.tree.rules[ruleId];
    if (!existingRule) {
      return undefined;
    }

    const parentPrinciple = store.tree.principles[existingRule.principleId];
    if (parentPrinciple) {
      parentPrinciple.ruleIds = parentPrinciple.ruleIds.filter((candidateId) => candidateId !== ruleId);
    }

    const implementationIds = uniqueStrings([
      ...existingRule.implementationIds,
      ...Object.values(store.tree.implementations)
        .filter((implementation) => implementation.ruleId === ruleId)
        .map((implementation) => implementation.id),
    ]);
    for (const implementationId of implementationIds) {
      delete store.tree.implementations[implementationId];
    }

    delete store.tree.rules[ruleId];
    return existingRule;
  });
}

export function updateImplementation(
  stateDir: string,
  implementationId: string,
  updates: Partial<Implementation>,
): Implementation {
  return mutateLedger(stateDir, (store) => {
    const existingImplementation = store.tree.implementations[implementationId];
    if (!existingImplementation) {
      throw new Error(`Cannot update missing implementation "${implementationId}".`);
    }

    const nextRuleId = updates.ruleId ?? existingImplementation.ruleId;
    const nextRule = store.tree.rules[nextRuleId];
    if (!nextRule) {
      throw new Error(`Cannot move implementation "${implementationId}" to missing rule "${nextRuleId}".`);
    }

    const nextImplementation: Implementation = {
      ...existingImplementation,
      ...updates,
      id: implementationId,
      ruleId: nextRuleId,
    };

    if (existingImplementation.ruleId !== nextRuleId) {
      const previousRule = store.tree.rules[existingImplementation.ruleId];
      if (previousRule) {
        previousRule.implementationIds = previousRule.implementationIds.filter(
          (candidateId) => candidateId !== implementationId,
        );
      }
      nextRule.implementationIds = uniqueStrings([...nextRule.implementationIds, implementationId]);
    }

    store.tree.implementations[implementationId] = nextImplementation;
    return nextImplementation;
  });
}

export function deleteImplementation(stateDir: string, implementationId: string): Implementation | undefined {
  return mutateLedger(stateDir, (store) => {
    const existingImplementation = store.tree.implementations[implementationId];
    if (!existingImplementation) {
      return undefined;
    }

    const parentRule = store.tree.rules[existingImplementation.ruleId];
    if (parentRule) {
      parentRule.implementationIds = parentRule.implementationIds.filter(
        (candidateId) => candidateId !== implementationId,
      );
    }

    delete store.tree.implementations[implementationId];
    return existingImplementation;
  });
}

export function listImplementationsForRule(stateDir: string, ruleId: string): Implementation[] {
  const ledger = loadLedger(stateDir);
  const rule = ledger.tree.rules[ruleId];
  if (!rule) {
    return [];
  }

  return rule.implementationIds
    .map((implementationId) => ledger.tree.implementations[implementationId])
    .filter((implementation): implementation is Implementation => implementation !== undefined);
}

export function getPrincipleSubtree(stateDir: string, principleId: string): PrincipleSubtree | undefined {
  const ledger = loadLedger(stateDir);
  const principle = ledger.tree.principles[principleId];
  if (!principle) {
    return undefined;
  }

  return {
    principle,
    rules: principle.ruleIds
      .map((ruleId) => ledger.tree.rules[ruleId])
      .filter((rule): rule is LedgerRule => rule !== undefined)
      .map((rule) => ({
        rule,
        implementations: rule.implementationIds
          .map((implementationId) => ledger.tree.implementations[implementationId])
          .filter((implementation): implementation is Implementation => implementation !== undefined),
      })),
  };
}

export function updatePrincipleValueMetrics(
  stateDir: string,
  principleId: string,
  metrics: PrincipleValueMetrics,
): PrincipleValueMetrics {
  return mutateLedger(stateDir, (store) => {
    const nextMetrics: PrincipleValueMetrics = {
      ...metrics,
      principleId,
    };
    store.tree.metrics[principleId] = nextMetrics;
    return nextMetrics;
  });
}

// ---------------------------------------------------------------------------
// Implementation Lifecycle State Transitions
// ---------------------------------------------------------------------------

/**
 * Valid lifecycle state transitions (per Phase 13 context D-15):
 *   candidate -> active      (promote)
 *   active -> disabled       (disable)
 *   disabled -> active       (re-enable via promote)
 *   disabled -> archived     (permanent disable)
 *   active -> archived       (direct archive)
 *   candidate -> archived    (rejected candidate cleanup)
 */
const VALID_LIFECYCLE_TRANSITIONS: Record<ImplementationLifecycleState, ImplementationLifecycleState[]> = {
  candidate: ['active', 'archived'],
  active: ['disabled', 'archived'],
  disabled: ['active', 'archived'],
  archived: [],
};

/**
 * Validate a lifecycle state transition.
 * Returns true if the transition is valid, false otherwise.
 */
export function isValidLifecycleTransition(
  from: ImplementationLifecycleState,
  to: ImplementationLifecycleState
): boolean {
  return VALID_LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Get allowed transitions for a given lifecycle state.
 */
export function getAllowedTransitions(from: ImplementationLifecycleState): ImplementationLifecycleState[] {
  return VALID_LIFECYCLE_TRANSITIONS[from] ?? [];
}

/**
 * Transition an implementation's lifecycle state with validation.
 * Throws on invalid transitions */
export function transitionImplementationState(
  stateDir: string,
  implementationId: string,
  newState: ImplementationLifecycleState
): Implementation {
  return mutateLedger(stateDir, (store) => {
    const impl = store.tree.implementations[implementationId];
    if (!impl) {
      throw new Error(`Implementation not found: ${implementationId}`);
    }

    const currentState = impl.lifecycleState ?? 'candidate';
    if (!isValidLifecycleTransition(currentState, newState)) {
      const allowed = getAllowedTransitions(currentState);
      throw new Error(
        `Invalid lifecycle transition: ${currentState} -> ${newState}. ` +
          `Allowed: ${allowed.length > 0 ? allowed.join(', ') : 'none (terminal state)'}`
      );
    }

    const updated: Implementation = {
      ...impl,
      lifecycleState: newState,
      updatedAt: new Date().toISOString(),
    };

    store.tree.implementations[implementationId] = updated;
    return updated;
  });
}

/**
 * Get all implementations for a specific lifecycle state across all rules.
 */
export function listImplementationsByLifecycleState(
  stateDir: string,
  state: ImplementationLifecycleState
): Implementation[] {
  const ledger = loadLedger(stateDir);
  return Object.values(ledger.tree.implementations).filter(
    (impl) => impl.lifecycleState === state
  );
}

/**
 * Get implementations in a specific lifecycle state for a given rule.
 */
export function listRuleImplementationsByState(
  stateDir: string,
  ruleId: string,
  state: ImplementationLifecycleState
): Implementation[] {
  const implementations = listImplementationsForRule(stateDir, ruleId);
  return implementations.filter((impl) => impl.lifecycleState === state);
}

/**
 * Find active implementation for a rule (helper for rule host lookup).
 */
export function findActiveImplementation(
  stateDir: string,
  ruleId: string
): Implementation | null {
  const implementations = listImplementationsForRule(stateDir, ruleId);
  return implementations.find((impl) => impl.lifecycleState === 'active') ?? null;
}
