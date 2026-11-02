/**
 * SPEC-PD-EXAMINER-001 v0.10.1 §6/§9/§4 — host-backed study inputs.
 *
 * Assembles the REAL inputs a v0.10.1 study freezes:
 *   - the Challenge Suite catalog (server-fixed keys over the lab's existing
 *     authored case variants — no new authoring system, no request strings
 *     crossing into the research pipeline: a request only SELECTS a key);
 *   - the production snapshot (runtime activation truth + the production
 *     prompt projection + budget provenance), frozen into the study as
 *     `production-snapshot.json` so the report can state exactly where the
 *     A/B starting point differs from production;
 *   - RuleCode facts derived from RUNTIME activation rows (stronger evidence
 *     than the ledger rule count alone; both are cross-checked and any
 *     unresolved attribution stays a refusal — never an assumed OFF).
 *
 * Read-only against production: gathering a snapshot writes nothing outside
 * the study directory the executor already owns.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLivePromptInjectionProjection } from '@principles/host-runtime';
import { ActivationsConsoleModel } from '../models/ActivationsConsoleModel.js';
import { PrinciplesConsoleModel } from '../models/PrinciplesConsoleModel.js';

// ── Challenge Suite catalog (SPEC §9: reuse frozen research assets) ─────────

/**
 * Fixed server-side catalog. Each entry maps to a deterministic list of
 * `makeExaminerV3Case` variants from the lab's authored calibration battery
 * (`examiner-v07-cases.mjs`) — the same frozen assets the committed
 * acceptance studies use. Case ids are minted per study by the executor.
 */
export const SUITE_CATALOG = [
  {
    key: 'didactic-pair',
    title: 'Didactic pair (v0.9 default)',
    description: 'Two synthetic calibration cases: the canonical observe-then-report world plus the boundary (principle-not-applicable) variant. Same suite every v0.9 console study froze.',
    variants: [{}, { boundary: true }],
    goldProvenance: 'SYNTHETIC_OFFLINE',
  },
  {
    key: 'calibration-core',
    title: 'Calibration core (six worlds)',
    description: 'Six distinct worlds from the authored v0.7 calibration battery: canonical, boundary, deploy-cycle (owner signoff), unknown-evidence, preseeded-evidence and stale-source variants. Richer applicability mix; still SYNTHETIC gold.',
    variants: [{}, { boundary: true }, { deploy: true }, { unknown: true }, { preseed: true }, { staleRequiredSource: true }],
    goldProvenance: 'SYNTHETIC_OFFLINE',
  },
] as const;

export type SuiteKey = (typeof SUITE_CATALOG)[number]['key'];
export const SUITE_KEYS: readonly string[] = SUITE_CATALOG.map((suite) => suite.key);

export interface SuiteCatalogEntry {
  key: string;
  title: string;
  description: string;
  caseCount: number;
  variantLabels: string[];
  goldProvenance: string;
  goldGate: string;
  suiteHash: string | null;
}

/** Stable definition hash over the catalog entry (lab canonical hashing). */
async function suiteDefinitionHash(labRoot: string, entry: (typeof SUITE_CATALOG)[number]): Promise<string | null> {
  try {
    const freezeUrl = pathToFileURL(path.join(labRoot, 'lib', 'challenge-freeze.mjs')).href;
    const freeze = (await import(freezeUrl)) as { hashOfCanonical: (value: unknown) => string };
    return freeze.hashOfCanonical({ key: entry.key, variants: entry.variants, goldProvenance: entry.goldProvenance });
  } catch {
    return null;
  }
}

function variantLabel(variant: Record<string, unknown>): string {
  const flags = Object.keys(variant).filter((key) => variant[key] === true);
  return flags.length > 0 ? flags.join('+') : 'canonical';
}

export async function listSuiteCatalog(labRoot: string): Promise<SuiteCatalogEntry[]> {
  const entries: SuiteCatalogEntry[] = [];
  for (const suite of SUITE_CATALOG) {
    entries.push({
      key: suite.key,
      title: suite.title,
      description: suite.description,
      caseCount: suite.variants.length,
      variantLabels: suite.variants.map((variant) => variantLabel(variant as Record<string, unknown>)),
      goldProvenance: suite.goldProvenance,
      goldGate: 'SYNTHETIC gold validates the offline contract only — formal real-behavior conclusions stay blocked behind Gate 1 (independent human Gold review)',
      suiteHash: await suiteDefinitionHash(labRoot, suite),
    });
  }
  return entries;
}

export function isSuiteKey(value: unknown): value is SuiteKey {
  return typeof value === 'string' && SUITE_KEYS.includes(value);
}

/**
 * Compile the case definitions for one suite under a STUDY-MINTED id prefix.
 * The case ids are server-minted (`<studyId>-CASE-NN`); the request never
 * contributes a case id or a path.
 */
export async function suiteCaseDefs(labRoot: string, studyId: string, suiteKey: SuiteKey): Promise<Record<string, unknown>[]> {
  const suite = SUITE_CATALOG.find((entry) => entry.key === suiteKey);
  if (!suite) throw new Error(`suiteCaseDefs: unknown suite key '${String(suiteKey)}'`);
  const casesUrl = pathToFileURL(path.join(labRoot, 'lib', 'examiner-v07-cases.mjs')).href;
  const mod = (await import(casesUrl)) as { makeExaminerV3Case: (options: Record<string, unknown>) => Record<string, unknown> };
  return suite.variants.map((variant, index) => mod.makeExaminerV3Case({
    ...(variant as Record<string, unknown>),
    caseId: `${studyId}-CASE-${String(index + 1).padStart(2, '0')}`,
  }));
}

// ── Production snapshot (SPEC §4/§6.4: freeze where production differs) ─────

export interface ProductionSnapshot {
  schema: 'examiner-production-snapshot.v1';
  asOf: string;
  targetPrincipleId: string;
  promptRoute: {
    status: 'confirmed' | 'unconfirmed';
    routeName: string | null;
    note: string;
  };
  budget: {
    /** Production budget the projection actually resolved (UTF-16 chars). */
    chars: number | null;
    capacitySource: string | null;
    capacityStatus: string | null;
    policyVersion: string | null;
    unit: 'utf16-chars';
  };
  runtimeActivation: {
    /** Principles with an ACTIVE prompt activation row (runtime truth). */
    promptActivePrincipleIds: string[];
    /** Principles the production projection would inject right now. */
    projectedInjectedPrincipleIds: string[] | null;
    ruleCodeActivations: { activationId: string; principleId: string; mode: string | null; status: string }[];
  };
  ledgerActivePrincipleIds: string[];
  divergence: {
    /** Ledger-active principles with NO active runtime prompt activation. */
    activeInLedgerNotRuntime: string[];
    /** Ledger-active principles the current projection would NOT inject. */
    activeInLedgerNotProjected: string[] | null;
  };
  targetPrinciple: {
    runtimePromptActive: boolean;
    projectedInjected: boolean | null;
    ruleCodeActivationCount: number;
    ledgerRuleCount: number;
  };
  experimentVsProduction: {
    studyBudgetChars: number;
    productionBudgetChars: number | null;
    markers: string[];
    note: string;
  };
}

/** The single frozen marker for a configuration that is not the production injection path. */
export const EXPERIMENT_CONFIG_MARKER = 'EXPERIMENT_CONFIGURATION_DIFFERS_FROM_PRODUCTION';

/**
 * Gather the production facts a study must freeze at creation time. Every
 * fact comes from an existing authority (projection / activation read model /
 * ledger); nothing is inferred and nothing is written.
 */
export async function gatherProductionSnapshot(workspaceDir: string, targetPrincipleId: string, studyBudgetChars: number): Promise<ProductionSnapshot> {
  const asOf = new Date().toISOString();

  // Production prompt projection — the SAME computation the runtime performs
  // (route, budget, injected ids, selection policy).
  const resolution = await resolveLivePromptInjectionProjection({ workspaceDir });
  const confirmed = resolution.status === 'confirmed';
  const projection = confirmed ? resolution.projection : null;
  const perHost = confirmed ? [] : resolution.perHost;
  const routeName = projection?.route ?? null;
  const budgetChars = typeof projection?.budget === 'number' ? projection.budget : null;
  const projectedInjectedIds = projection?.injectedPrincipleIds ?? null;
  const budgetProvenance = projection ?? null;

  // Runtime activation truth + ledger truth.
  const activationsModel = new ActivationsConsoleModel(workspaceDir);
  const activations = await activationsModel.getActivations();
  const promptActivePrincipleIds = [...new Set(activations.activations
    .filter((row) => row.channel === 'prompt' && row.status === 'active')
    .map((row) => row.principleId))].sort();
  const ruleCodeActivations = activations.activations
    .filter((row) => row.channel === 'code_tool_hook')
    .map((row) => ({ activationId: row.activationId, principleId: row.principleId, mode: row.mode ?? null, status: row.status }));

  const principlesModel = new PrinciplesConsoleModel(workspaceDir);
  const list = await principlesModel.listPrinciples();
  const ledgerActivePrincipleIds = (list.principles ?? []).filter((p) => p.status === 'active').map((p) => p.id).sort();

  const targetRules = activations.activations.filter((row) => row.principleId === targetPrincipleId && row.channel === 'code_tool_hook');
  const ledgerTarget = (list.principles ?? []).find((p) => p.id === targetPrincipleId);

  const activeInLedgerNotRuntime = ledgerActivePrincipleIds.filter((id) => !promptActivePrincipleIds.includes(id));
  const activeInLedgerNotProjected = projectedInjectedIds === null
    ? null
    : ledgerActivePrincipleIds.filter((id) => !projectedInjectedIds.includes(id));

  const markers: string[] = [];
  if (budgetChars === null || budgetChars !== studyBudgetChars) markers.push(EXPERIMENT_CONFIG_MARKER);
  if (!confirmed) markers.push('PROMPT_ROUTE_UNCONFIRMED_AT_FREEZE');
  if (activeInLedgerNotProjected !== null && activeInLedgerNotProjected.length > 0) {
    markers.push('PROJECTION_EVICTS_ACTIVE_LIBRARY_PRINCIPLES');
  }

  return {
    schema: 'examiner-production-snapshot.v1',
    asOf,
    targetPrincipleId,
    promptRoute: {
      status: confirmed ? 'confirmed' : 'unconfirmed',
      routeName,
      note: confirmed
        ? 'the production injection route was resolved from workspace host facts at freeze time'
        : `the production route could not be confirmed (${perHost.length} candidate host(s)) — the study freezes an unconfirmed-route baseline`,
    },
    budget: {
      chars: budgetChars,
      capacitySource: budgetProvenance?.budgetCapacitySource ?? null,
      capacityStatus: budgetProvenance?.budgetCapacityStatus ?? null,
      policyVersion: budgetProvenance?.budgetPolicyVersion ?? null,
      unit: 'utf16-chars',
    },
    runtimeActivation: {
      promptActivePrincipleIds,
      projectedInjectedPrincipleIds: projectedInjectedIds,
      ruleCodeActivations: ruleCodeActivations.slice(0, 50),
    },
    ledgerActivePrincipleIds,
    divergence: {
      activeInLedgerNotRuntime,
      activeInLedgerNotProjected,
    },
    targetPrinciple: {
      runtimePromptActive: promptActivePrincipleIds.includes(targetPrincipleId),
      projectedInjected: projectedInjectedIds === null ? null : projectedInjectedIds.includes(targetPrincipleId),
      ruleCodeActivationCount: targetRules.length,
      ledgerRuleCount: ledgerTarget?.ruleCount ?? 0,
    },
    experimentVsProduction: {
      studyBudgetChars,
      productionBudgetChars: budgetChars,
      markers,
      note: 'the experiment renders arms under the frozen study budget with the offline deterministic renderer; the production prompt hook computes its own budget and selection — a marker above states every detected difference',
    },
  };
}

export interface StudyRuleCodeFacts {
  ruleCodes: { ruleCodeId: string; principleId: string; baselineState: 'ON' | 'OFF' }[];
  principleRuleCodeIndependence: boolean | null;
  targetRuleCodeCount: number;
  evidenceNote: string;
}

/**
 * Derive the study's RuleCode facts from RUNTIME activation rows
 * (authoritative) cross-checked against the ledger rule count.
 *
 * Honesty rules (SPEC §7.2):
 *   - a live-enforcing RuleCode bound to the target is a REAL coupling → the
 *     count resolves but independence is unproven → INTERVENTION_NOT_IDENTIFIABLE
 *     (the lab refuses creation; nothing is silently labelled principle_only);
 *   - shadow (non-enforcing) rows resolve to baseline OFF — still a coupling
 *     attribution, so independence stays unproven while any row exists;
 *   - ledger-attributed rules with no runtime row stay UNRESOLVED (v0.9
 *     semantics: unresolved baseline refuses, never assumed OFF).
 */
export function deriveStudyRuleCodeFacts(snapshot: ProductionSnapshot): StudyRuleCodeFacts {
  // ONLY the rows bound to the TARGET principle count as its coupling — a
  // RuleCode activation for a DIFFERENT principle is part of the frozen
  // baseline, not the target's intervention variable (SPEC §7.2).
  const targetRows = snapshot.runtimeActivation.ruleCodeActivations
    .filter((row) => row.principleId === snapshot.targetPrincipleId);
  const targetRuleCodeCount = Math.max(targetRows.length, snapshot.targetPrinciple.ledgerRuleCount);
  const resolved = targetRows.map((row) => ({
    ruleCodeId: row.activationId,
    principleId: snapshot.targetPrincipleId,
    baselineState: row.mode === 'live' && row.status === 'active' ? 'ON' as const : 'OFF' as const,
  }));
  const independence = targetRuleCodeCount === 0 ? true : null;
  const evidenceNote = targetRuleCodeCount === 0
    ? 'no RuleCode is attributed to the target principle by either the runtime activation table or the ledger — independence is an evidenced zero'
    : `${targetRows.length} runtime RuleCode activation(s) and ${snapshot.targetPrinciple.ledgerRuleCount} ledger-attributed rule(s) bound to the TARGET; independent control of prompt injection while holding these at baseline is UNPROVEN — INTERVENTION_NOT_IDENTIFIABLE unless separately evidenced`;
  return { ruleCodes: resolved, principleRuleCodeIndependence: independence, targetRuleCodeCount, evidenceNote };
}

/**
 * Read a study's frozen production snapshot for DISPLAY (read-only; null when
 * absent/unrecognized). The snapshot is frozen study data, not a trusted
 * contract: the return type stays a plain untrusted record (rc-1) — no typed
 * facade over parsed JSON.
 */
/** rc-1/rc-2: plain-object type guard over parsed JSON (no `as` narrowing). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readProductionSnapshot(studyDir: string): Record<string, unknown> | null {
  const file = path.join(studyDir, 'production-snapshot.json');
  if (!fs.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(parsed)) return null;
    if (parsed.schema !== 'examiner-production-snapshot.v1') return null;
    return parsed;
  } catch {
    return null;
  }
}
