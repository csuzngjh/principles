import * as fs from 'fs';
import * as path from 'path';
import { withLock, withLockAsync } from '../utils/file-lock.js';
import type {
  Implementation,
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
  rules: Array<{
    rule: LedgerRule;
    implementations: Implementation[];
  }>;
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
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    const raw = isRecord(parsed) ? parsed : {};
    return {
      trainingStore: parseLegacyTrainingStore(raw),
      tree: parseTree(raw[TREE_NAMESPACE]),
    };
  } catch {
    return {
      trainingStore: {},
      tree: createEmptyTree(),
    };
  }
}

function writeLedgerUnlocked(filePath: string, store: HybridLedgerStore): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, serializeLedger(store), 'utf-8');
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

export function createRule(stateDir: string, rule: LedgerRule): LedgerRule {
  return mutateLedger(stateDir, (store) => {
    const principle = store.tree.principles[rule.principleId];
    if (!principle) {
      throw new Error(`Cannot create rule "${rule.id}" for missing principle "${rule.principleId}".`);
    }

    const nextRule: LedgerRule = {
      ...rule,
      implementationIds: Array.from(new Set(rule.implementationIds)),
    };
    store.tree.rules[nextRule.id] = nextRule;
    principle.ruleIds = Array.from(new Set([...principle.ruleIds, nextRule.id]));
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
    rule.implementationIds = Array.from(new Set([...rule.implementationIds, implementation.id]));
    return implementation;
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
