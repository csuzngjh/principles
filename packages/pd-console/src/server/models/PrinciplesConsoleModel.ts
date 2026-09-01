import * as path from 'path';
import * as fs from 'fs';
import { classifyPrinciples, filterOwnerActionable } from './PrincipleClassifier.js';
import { updatePrinciple } from '@principles/core/principle-tree-ledger';
import { isCorePrincipleId } from '@principles/core/runtime-v2';

import type { PrincipleStatus } from '@principles/core/runtime-v2';

export type { PrincipleStatus };

// ── PRI-641: Core principle boundary errors ─────────────────────────────────
// Core principles (registry T-01..T-10) are PD's built-in semantics, not
// workspace governance targets. Refusals must be distinguishable from storage
// failures (`false`), so they surface as typed errors at the model boundary.

/** Core principle refused for a workspace governance mutation (archive/unarchive). */
export class ImmutableCorePrincipleError extends Error {
  readonly principleId: string;
  constructor(principleId: string) {
    super(`Core principle "${principleId}" is built into Principles Disciple and cannot be modified through workspace governance.`);
    this.name = 'ImmutableCorePrincipleError';
    this.principleId = principleId;
  }
}

/** Core principle refused from the ordinary Owner Principle detail flow. */
export class CorePrincipleNotGovernedError extends Error {
  readonly principleId: string;
  constructor(principleId: string) {
    super(`Core principle "${principleId}" is not owner-managed.`);
    this.name = 'CorePrincipleNotGovernedError';
    this.principleId = principleId;
  }
}

export type PrinciplePriority = 'P0' | 'P1' | 'P2';
export type PrincipleScope = 'general' | 'domain';
export type PrincipleEvaluability = 'manual_only' | 'deterministic' | 'weak_heuristic';
export type RuleStatus = 'proposed' | 'implemented' | 'enforced' | 'retired';
export type RuleType = 'hook' | 'gate' | 'skill' | 'lora' | 'test' | 'prompt';

interface LedgerPrinciple {
  id: string;
  text?: string;
  triggerPattern?: string;
  action?: string;
  status?: string;
  priority?: string;
  scope?: string;
  domain?: string;
  evaluability?: string;
  valueScore?: number;
  adherenceRate?: number;
  painPreventedCount?: number;
  ruleIds?: string[];
  conflictsWithPrincipleIds?: string[];
  derivedFromPainIds?: string[];
  coreAxiomId?: string;
  lastPainPreventedAt?: string;
  supersedesPrincipleId?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface LedgerRule {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  triggerCondition?: string;
  enforcement?: string;
  action?: string;
  principleId?: string;
  status?: string;
  coverageRate?: number;
  falsePositiveRate?: number;
  implementationIds?: string[];
}

interface LedgerTreeStore {
  principles: Record<string, LedgerPrinciple>;
  rules: Record<string, LedgerRule>;
  implementations: Record<string, unknown>;
  metrics: Record<string, unknown>;
  lastUpdated: string;
}

interface HybridLedgerStore {
  trainingStore: Record<string, unknown>;
  tree: LedgerTreeStore;
}

export interface PrincipleListItem {
  id: string;
  text: string;
  triggerPattern: string;
  action: string;
  status: PrincipleStatus;
  priority: PrinciplePriority;
  scope: PrincipleScope;
  domain: string | null;
  evaluability: PrincipleEvaluability;
  valueScore: number;
  adherenceRate: number;
  painPreventedCount: number;
  ruleCount: number;
  conflictsWithCount: number;
  createdAt: string;
  updatedAt: string;
  /** Detected language of the principle text ('en' | 'zh' | 'unknown'). PRI-332 */
  detectedLanguage: 'en' | 'zh' | 'unknown';
  /** Structured readability warning code — front-end renders via i18n. PRI-332 P1-5 */
  readabilityWarningCode?: ReadabilityWarningCode;
}

export interface RuleItem {
  id: string;
  name: string;
  description: string;
  type: RuleType;
  triggerCondition: string;
  enforcement: 'block' | 'warn' | 'log';
  action: string;
  status: RuleStatus;
  coverageRate: number;
  falsePositiveRate: number;
}

export interface PrincipleDetail extends PrincipleListItem {
  coreAxiomId: string | null;
  lastPainPreventedAt: string | null;
  derivedFromPainIds: string[];
  ruleIds: string[];
  conflictsWithPrincipleIds: string[];
  supersedesPrincipleId: string | null;
  rules: RuleItem[];
}

export interface PrinciplesListOutput {
  principles: PrincipleListItem[];
  summary: {
    candidate: number;
    probation: number;
    active: number;
    deprecated: number;
    archived: number;
    total: number;
  };
  /** Category breakdown (PRI-330) */
  categories?: Record<string, number>;
  /** If the approval cross-check was unavailable, this explains why (ERR-002) */
  approvalCrossCheckUnavailable?: string;
}

export type PrincipleFilter = 'all' | 'actionable';

export interface PrincipleDetailOutput {
  principle: PrincipleDetail;
}

const VALID_STATUSES: readonly PrincipleStatus[] = ['candidate', 'active', 'archived', 'deprecated', 'probation'];
const VALID_PRIORITIES: readonly PrinciplePriority[] = ['P0', 'P1', 'P2'];
const VALID_SCOPES: readonly PrincipleScope[] = ['general', 'domain'];
const VALID_EVALUABILITIES: readonly PrincipleEvaluability[] = ['manual_only', 'deterministic', 'weak_heuristic'];
const VALID_RULE_TYPES: readonly RuleType[] = ['hook', 'gate', 'skill', 'lora', 'test', 'prompt'];
const VALID_RULE_STATUSES: readonly RuleStatus[] = ['proposed', 'implemented', 'enforced', 'retired'];
const VALID_ENFORCEMENTS: readonly ('block' | 'warn' | 'log')[] = ['block', 'warn', 'log'];

// ── PRI-332: Language detection & readability helpers ────────────────────────

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const REGEX_LIKE_PATTERN = /^[/^.*+?()[\]{}|$\\]|\/.*\/[gimsuy]*$/;
const TECHNICAL_RESIDUE_PATTERN = /^[a-zA-Z_]+\.[a-zA-Z_]+\(|^Error:|^TypeError:|\{\{.*\}\}|<\/?\w+>/;

/** Structured readability warning codes — front-end renders via i18n (PRI-332 P1-5). */
export type ReadabilityWarningCode = 'technical_pattern' | 'diagnostic_residue' | 'title_too_long';

/** Simple CJK-based language detection for principle text. */
function detectLanguage(text: string): 'en' | 'zh' | 'unknown' {
  if (!text || text.trim().length === 0) return 'unknown';
  return CJK_REGEX.test(text) ? 'zh' : 'en';
}

/** Check if a triggerPattern/title looks like unreadable technical residue.
 *  Returns a structured code instead of an English string (PRI-332 P1-5). */
function checkReadabilityWarning(triggerPattern: string, text: string): ReadabilityWarningCode | undefined {
  const title = triggerPattern || text.slice(0, 80);
  if (!title) return undefined;
  if (REGEX_LIKE_PATTERN.test(title.trim())) {
    return 'technical_pattern';
  }
  if (TECHNICAL_RESIDUE_PATTERN.test(title.trim())) {
    return 'diagnostic_residue';
  }
  if (title.length > 120) {
    return 'title_too_long';
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function parseTree(raw: unknown): LedgerTreeStore {
  if (!isRecord(raw)) {
    return createEmptyTree();
  }

  const principles: Record<string, LedgerPrinciple> = {};
  if (isRecord(raw.principles)) {
    for (const [id, value] of Object.entries(raw.principles)) {
      if (isRecord(value)) {
        principles[id] = { ...value, id };
      }
    }
  }

  const rules: Record<string, LedgerRule> = {};
  if (isRecord(raw.rules)) {
    for (const [id, value] of Object.entries(raw.rules)) {
      if (isRecord(value)) {
        rules[id] = { ...value, id };
      }
    }
  }

  return {
    principles,
    rules,
    implementations: isRecord(raw.implementations) ? raw.implementations : {},
    metrics: isRecord(raw.metrics) ? raw.metrics : {},
    lastUpdated: typeof raw.lastUpdated === 'string' ? raw.lastUpdated : new Date(0).toISOString(),
  };
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
    const raw = isRecord(parsed) ? parsed : {};
    const treeRaw = raw._tree ?? raw.tree;
    return {
      trainingStore: {},
      tree: parseTree(treeRaw),
    };
  } catch (e) {
    console.warn('PrinciplesConsoleModel: failed to parse principle_training_state.json, returning empty tree:', e);
    return { trainingStore: {}, tree: createEmptyTree() };
  }
}

function safeCastEnum<T extends string>(value: string | undefined, valid: readonly T[], fallback: T): T {
  if (value && (valid as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

const CACHE_TTL_MS = 5_000;

export class PrinciplesConsoleModel {
  private readonly workspaceDir: string;
  private cachedLedger: HybridLedgerStore | null = null;
  private cacheTimestamp = 0;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  private getLedgerPath(): string {
    return path.join(this.workspaceDir, '.state', 'principle_training_state.json');
  }

  private loadLedger(): HybridLedgerStore {
    const now = Date.now();
    if (this.cachedLedger && now - this.cacheTimestamp < CACHE_TTL_MS) {
      return this.cachedLedger;
    }
    const ledger = readLedgerFromFile(this.getLedgerPath());
    this.cachedLedger = ledger;
    this.cacheTimestamp = now;
    return ledger;
  }

  async listPrinciples(filter?: PrincipleFilter, decidedPrincipleIds?: Set<string>, pendingApprovalPrincipleIds?: Set<string>): Promise<PrinciplesListOutput> {
    const ledger = this.loadLedger();
    const principles = Object.values(ledger.tree.principles);

    const items: PrincipleListItem[] = [];

    for (const p of principles) {
      const status = safeCastEnum(p.status, VALID_STATUSES, 'candidate');

      const principleText = p.text ?? '';
      const principleTrigger = p.triggerPattern ?? '';
      items.push({
        id: p.id,
        text: principleText,
        triggerPattern: principleTrigger,
        action: p.action ?? '',
        status,
        priority: safeCastEnum(p.priority, VALID_PRIORITIES, 'P2'),
        scope: safeCastEnum(p.scope, VALID_SCOPES, 'general'),
        domain: p.domain ?? null,
        evaluability: safeCastEnum(p.evaluability, VALID_EVALUABILITIES, 'manual_only'),
        valueScore: p.valueScore ?? 0,
        adherenceRate: p.adherenceRate ?? 0,
        painPreventedCount: p.painPreventedCount ?? 0,
        ruleCount: (p.ruleIds ?? []).length,
        conflictsWithCount: (p.conflictsWithPrincipleIds ?? []).length,
        createdAt: p.createdAt ?? '',
        updatedAt: p.updatedAt ?? '',
        detectedLanguage: detectLanguage(principleText),
        readabilityWarningCode: checkReadabilityWarning(principleTrigger, principleText),
      });
    }

    items.sort((a, b) => b.valueScore - a.valueScore);

    // PRI-330 + PRI-641: classify first, then remove builtin from the corpus.
    // The workspace projection is "workspace-governed principles only" —
    // builtin axioms are PD's immutable semantics and never governance
    // targets, so they must not reach lists, summary, or Debt consumers.
    const classified = classifyPrinciples(items, decidedPrincipleIds, pendingApprovalPrincipleIds);
    const workspaceClassified = classified.filter((c) => c.category !== 'builtin');
    const workspaceItems = workspaceClassified.map((c) => c.principle);

    // PRI-641: summary and categories are computed over the same workspace
    // corpus the caller sees, so `principles[]` and `summary` can never
    // disagree (no "list 3, total 13" projection).
    const summary = {
      candidate: 0,
      probation: 0,
      active: 0,
      deprecated: 0,
      archived: 0,
      total: workspaceItems.length,
    };
    for (const p of workspaceItems) {
      switch (p.status) {
        case 'candidate': summary.candidate++; break;
        case 'probation': summary.probation++; break;
        case 'active': summary.active++; break;
        case 'deprecated': summary.deprecated++; break;
        case 'archived': summary.archived++; break;
      }
    }

    const categories: Record<string, number> = {};
    for (const c of workspaceClassified) {
      categories[c.category] = (categories[c.category] ?? 0) + 1;
    }

    let outputItems = workspaceItems;
    if (filter === 'actionable') {
      const actionable = filterOwnerActionable(workspaceClassified);
      outputItems = actionable.map((c) => c.principle);
    }

    return { principles: outputItems, summary, categories };
  }

  async getPrincipleDetail(principleId: string): Promise<PrincipleDetailOutput | null> {
    // PRI-641: Core principles are not workspace-governed objects — they have
    // no ordinary Owner detail (approvals/lifecycle/trajectory/receipts) and
    // are viewed read-only via the Core Principles surface instead.
    if (isCorePrincipleId(principleId)) {
      throw new CorePrincipleNotGovernedError(principleId);
    }

    const ledger = this.loadLedger();
    const p = ledger.tree.principles[principleId];
    if (!p) {
      return null;
    }

    const rules: RuleItem[] = (p.ruleIds ?? [])
      .map((ruleId: string) => ledger.tree.rules[ruleId])
      .filter((r: LedgerRule | undefined): r is LedgerRule => r !== undefined)
      .map((r: LedgerRule) => ({
        id: r.id,
        name: r.name ?? '',
        description: r.description ?? '',
        type: safeCastEnum(r.type, VALID_RULE_TYPES, 'hook'),
        triggerCondition: r.triggerCondition ?? '',
        enforcement: safeCastEnum(r.enforcement, VALID_ENFORCEMENTS, 'log'),
        action: r.action ?? '',
        status: safeCastEnum(r.status, VALID_RULE_STATUSES, 'proposed'),
        coverageRate: r.coverageRate ?? 0,
        falsePositiveRate: r.falsePositiveRate ?? 0,
      }));

    const status = safeCastEnum(p.status, VALID_STATUSES, 'candidate');

    const detailText = p.text ?? '';
    const detailTrigger = p.triggerPattern ?? '';
    const principle: PrincipleDetail = {
      id: p.id,
      text: detailText,
      triggerPattern: detailTrigger,
      action: p.action ?? '',
      status,
      priority: safeCastEnum(p.priority, VALID_PRIORITIES, 'P2'),
      scope: safeCastEnum(p.scope, VALID_SCOPES, 'general'),
      domain: p.domain ?? null,
      evaluability: safeCastEnum(p.evaluability, VALID_EVALUABILITIES, 'manual_only'),
      valueScore: p.valueScore ?? 0,
      adherenceRate: p.adherenceRate ?? 0,
      painPreventedCount: p.painPreventedCount ?? 0,
      ruleCount: (p.ruleIds ?? []).length,
      conflictsWithCount: (p.conflictsWithPrincipleIds ?? []).length,
      coreAxiomId: p.coreAxiomId ?? null,
      lastPainPreventedAt: p.lastPainPreventedAt ?? null,
      derivedFromPainIds: p.derivedFromPainIds ?? [],
      ruleIds: p.ruleIds ?? [],
      conflictsWithPrincipleIds: p.conflictsWithPrincipleIds ?? [],
      supersedesPrincipleId: p.supersedesPrincipleId ?? null,
      createdAt: p.createdAt ?? '',
      updatedAt: p.updatedAt ?? '',
      rules,
      detectedLanguage: detectLanguage(detailText),
      readabilityWarningCode: checkReadabilityWarning(detailTrigger, detailText),
    };

    return { principle };
  }

  async archivePrinciple(principleId: string): Promise<boolean> {
    // PRI-641: refuse before any write — builtin axioms are immutable
    if (isCorePrincipleId(principleId)) {
      throw new ImmutableCorePrincipleError(principleId);
    }
    try {
      const stateDir = path.join(this.workspaceDir, '.state');
      updatePrinciple(stateDir, principleId, {
        status: 'archived',
        updatedAt: new Date().toISOString(),
      });
      // Clear cache to force reload
      this.cachedLedger = null;
      this.cacheTimestamp = 0;
      return true;
    } catch (e) {
      console.error(`Failed to archive principle ${principleId}:`, e);
      return false;
    }
  }

  async unarchivePrinciple(principleId: string): Promise<boolean> {
    // PRI-641: refuse before any write — builtin axioms are immutable
    if (isCorePrincipleId(principleId)) {
      throw new ImmutableCorePrincipleError(principleId);
    }
    try {
      const stateDir = path.join(this.workspaceDir, '.state');
      updatePrinciple(stateDir, principleId, {
        status: 'active',
        updatedAt: new Date().toISOString(),
      });
      // Clear cache to force reload
      this.cachedLedger = null;
      this.cacheTimestamp = 0;
      return true;
    } catch (e) {
      console.error(`Failed to unarchive principle ${principleId}:`, e);
      return false;
    }
  }
}
