/**
 * OwnerDecisionViewModel — the collecting boundary for the canonical
 * Owner-facing decision projection (Owner Decision Experience v1, Phase B).
 *
 * Gathers the sources `deriveOwnerDecisionView` needs and stays READ-ONLY:
 *   - ledger entry (principle_training_state.json, via the collector's parser)
 *   - GovernanceFacts (GovernanceProjectionCollector — same 4-table batch read
 *     the existing governance endpoint uses; one snapshot per request)
 *   - candidate / generic diagnosis artifact / PI scribe + philosopher texts
 *     (diagnostic read-through axes, SPEC §9.2 — never conflated with
 *     governance lineage)
 *   - behavior application counts (principle_applications, existing ledger)
 *     + receipt coverage availability
 *
 * It writes nothing, creates nothing, and does not mutate flags. Every source
 * read is recorded in `sourceReads`; failures degrade the specific source only.
 */
/* eslint-disable @typescript-eslint/no-use-before-define -- helpers declared after the class, matching codebase convention */
/* eslint-disable @typescript-eslint/class-methods-use-this -- lifecycle-style methods; kept on the model for cohesion */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GovernanceProjectionCollector,
  isRecord,
  readOwnString,
} from './GovernanceProjectionCollector.js';
import {
  deriveOwnerDecisionView,
} from '@principles/core/runtime-v2';
import type {
  OwnerDecisionInputs,
  OwnerDecisionViewCore,
  GovernanceFacts,
} from '@principles/core/runtime-v2';
import { SqliteConnection } from '@principles/core/runtime-v2';

const ISO_NOW = () => new Date().toISOString();

export interface OwnerDecisionInboxItem {
  principleId: string;
  decisionState: OwnerDecisionViewCore['decisionState'];
  learnedPrinciple: {
    status: 'known';
    text: string;
    sourceTier: 'scribe' | 'distiller' | 'philosopher' | 'candidate_principle';
  } | {
    status: 'unknown';
    reasonText: string;
  };
  inbox: OwnerDecisionViewCore['inbox'];
  blockerCodes: string[];
  nextAction: OwnerDecisionViewCore['nextAction'];
}

export interface OwnerDecisionInboxResponse {
  schemaVersion: '1';
  generatedAt: string;
  totalPrinciples: number;
  groups: {
    decision: OwnerDecisionInboxItem[];
    blocked: OwnerDecisionInboxItem[];
    recovery: OwnerDecisionInboxItem[];
  };
  /** §11.1 aggregate notice for historical unbound entries with no current subject. */
  historicalUnknown: {
    count: number;
    reasonText: string;
  };
  degraded?: { reason: string; nextAction: string };
}

interface CandidateRow {
  candidateId: string;
  status: string;
  recommendationKind: string;
  description: string;
  abstractedPrinciple?: string;
  trigger?: string;
  action?: string;
  title?: string;
  confidence?: number;
  artifactId?: string;
}

interface DiagnosisMaterial {
  artifactId: string;
  summary?: string;
  rootCause?: string;
  truncated: boolean;
}

interface ScribeMaterial {
  artifactId: string;
  statement?: string;
  rationale?: string;
  applicability: string[];
  antiPatterns: string[];
  risks: string[];
  targetBehavior?: string;
  updatedAt: string;
}

interface PhilosopherMaterial {
  artifactId: string;
  title?: string;
  rationale?: string;
  scope?: string;
}

interface BatchSnapshot {
  artifactRows: unknown[];
  taskRows: unknown[];
  approvalRows: unknown[];
  activationRows: unknown[];
  /** pi_artifacts rows WITH content_json (semantic read-through only). */
  piArtifactContentRows: unknown[];
  candidates: Map<string, CandidateRow>;
  genericArtifacts: Map<string, { artifactId: string; contentJson?: string; kind: string }>;
  piArtifactTaskKinds: Map<string, string>;
  applicationsByPrinciple: Map<string, { deterministic: number; selfReported: number; presence: number; recent: { text: string; createdAt?: string; level: string }[] }>;
  /** Codex review P2: false when principle_applications is missing/unreadable — the source must surface unavailable, not "available, zero". */
  applicationsAvailable: boolean;
  dbAvailable: boolean;
  ledgerUnavailableReason?: string;
}

export class OwnerDecisionViewModel {
  constructor(private readonly workspaceDir: string) {}

  /** Full OwnerDecisionViewCore for one principle (Detail first layer). */
  async getView(principleId: string, now: string = ISO_NOW()): Promise<OwnerDecisionViewCore> {
    const inputs = await this.collectInputs(principleId, now);
    return deriveOwnerDecisionView(inputs);
  }

  /** Compact inbox projection over every ledger principle (§11.1). */
  async getInbox(now: string = ISO_NOW()): Promise<OwnerDecisionInboxResponse> {
    const snapshot = this.readBatchSnapshot();
    let ledgerParsed: unknown;
    try {
      ledgerParsed = this.parseLedger();
    } catch {
      // No readable ledger: degrade observably instead of an empty success
      // (SPEC §15 — an unavailable ledger is not "zero principles, all fine").
      return {
        schemaVersion: '1', generatedAt: now, totalPrinciples: 0,
        groups: { decision: [], blocked: [], recovery: [] },
        historicalUnknown: { count: 0, reasonText: '' },
        degraded: { reason: 'principle ledger unavailable', nextAction: '检查原则账本文件。' },
      };
    }
    const principlesTree = GovernanceProjectionCollector.principleTreeFromLedger(ledgerParsed);
    if (principlesTree === null) {
      return {
        schemaVersion: '1', generatedAt: now, totalPrinciples: 0,
        groups: { decision: [], blocked: [], recovery: [] },
        historicalUnknown: { count: 0, reasonText: '' },
        degraded: { reason: 'principle ledger unavailable', nextAction: '检查原则账本文件。' },
      };
    }
    const decision: OwnerDecisionInboxItem[] = [];
    const blocked: OwnerDecisionInboxItem[] = [];
    const recovery: OwnerDecisionInboxItem[] = [];
    let historicalUnknown = 0;
    let total = 0;
    for (const principleId of Object.keys(principlesTree).sort()) {
      total += 1;
      try {
        const inputs = this.buildInputsFor({ principleId, ledgerParsed, snapshot, now, compact: true });
        const view = deriveOwnerDecisionView(inputs);
        const item: OwnerDecisionInboxItem = {
          principleId,
          decisionState: view.decisionState,
          learnedPrinciple: view.learnedPrinciple.status === 'known'
            ? { status: 'known', text: view.learnedPrinciple.value.text, sourceTier: view.learnedPrinciple.value.sourceTier }
            : { status: 'unknown', reasonText: view.learnedPrinciple.reason.ownerText },
          inbox: view.inbox,
          blockerCodes: view.blockers.map((blocker) => blocker.reason.code),
          nextAction: view.nextAction,
        };
        if (view.inbox.group === 'decision') decision.push(item);
        else if (view.inbox.group === 'blocked') blocked.push(item);
        else if (view.inbox.group === 'recovery') recovery.push(item);
        if (view.inbox.group === 'blocked' && view.inbox.attention === 'aggregate') historicalUnknown += 1;
      } catch {
        // A single principle failing derivation must not take down the inbox;
        // it is counted as blocked-judgment so it stays observable.
        blocked.push({
          principleId,
          decisionState: 'blocked',
          learnedPrinciple: { status: 'unknown', reasonText: '该条目的决策投影暂时无法生成。' },
          inbox: {
            group: 'blocked', attention: 'individual',
            reason: { code: 'projection_error', ownerText: '该条目的决策投影暂时无法生成。', sourceRefs: [] },
          },
          blockerCodes: ['projection_error'],
          nextAction: { code: 'inspect_data', ownerText: '查看该原则详情页的错误说明。', targetRefs: [] },
        });
      }
    }
    return {
      schemaVersion: '1',
      generatedAt: now,
      totalPrinciples: total,
      groups: { decision, blocked, recovery },
      historicalUnknown: {
        count: historicalUnknown,
        reasonText: historicalUnknown > 0
          ? `有 ${historicalUnknown} 条历史原则的决策状态暂时无法确认（治理关联尚未建立）。这不是待办事项，也不代表需要你立即处理。`
          : '',
      },
    };
  }

  /** Compact per-principle projection for the Library list (§11.2). */
  async getLibraryCompact(now: string = ISO_NOW()): Promise<{
    schemaVersion: '1';
    generatedAt: string;
    entries: Record<string, { decisionState: OwnerDecisionViewCore['decisionState']; learnedPrinciple: OwnerDecisionInboxItem['learnedPrinciple'] }>;
    degraded?: { reason: string };
  }> {
    const snapshot = this.readBatchSnapshot();
    let ledgerParsed: unknown;
    try {
      ledgerParsed = this.parseLedger();
    } catch {
      return { schemaVersion: '1', generatedAt: now, entries: {}, degraded: { reason: 'principle ledger unavailable' } };
    }
    const principlesTree = GovernanceProjectionCollector.principleTreeFromLedger(ledgerParsed);
    if (principlesTree === null) {
      return { schemaVersion: '1', generatedAt: now, entries: {}, degraded: { reason: 'principle ledger unavailable' } };
    }
    const entries: Record<string, { decisionState: OwnerDecisionViewCore['decisionState']; learnedPrinciple: OwnerDecisionInboxItem['learnedPrinciple'] }> = {};
    for (const principleId of Object.keys(principlesTree).sort()) {
      try {
        const view = deriveOwnerDecisionView(this.buildInputsFor({ principleId, ledgerParsed, snapshot, now, compact: true }));
        entries[principleId] = {
          decisionState: view.decisionState,
          learnedPrinciple: view.learnedPrinciple.status === 'known'
            ? { status: 'known', text: view.learnedPrinciple.value.text, sourceTier: view.learnedPrinciple.value.sourceTier }
            : { status: 'unknown', reasonText: view.learnedPrinciple.reason.ownerText },
        };
      } catch {
        // Skip unreadable entries — the Library falls back to neutral copy.
      }
    }
    return { schemaVersion: '1', generatedAt: now, entries };
  }

  // ── input assembly ────────────────────────────────────────────────────────

  private async collectInputs(principleId: string, now: string): Promise<OwnerDecisionInputs> {
    const snapshot = this.readBatchSnapshot();
    const ledgerParsed = this.parseLedger();
    return this.buildInputsFor({ principleId, ledgerParsed, snapshot, now, compact: false });
  }

  private parseLedger(): unknown {
    return GovernanceProjectionCollector.parsePrincipleLedgerFile(this.workspaceDir);
  }

  private buildInputsFor(input: {
    principleId: string;
    ledgerParsed: unknown;
    snapshot: BatchSnapshot;
    now: string;
    compact: boolean;
  }): OwnerDecisionInputs {
    const { principleId, ledgerParsed, snapshot, now, compact } = input;
    const issues: GovernanceFacts['collectionIssues'] = [];
    const principle = GovernanceProjectionCollector.principleFactFromLedger(ledgerParsed, principleId, issues);
    const entry = this.ledgerEntryFor(ledgerParsed, principleId);
    const sourceReads: OwnerDecisionInputs['sourceReads'] = [];

    let governance: GovernanceFacts;
    if (!snapshot.dbAvailable) {
      sourceReads.push({ source: 'state.db', status: 'unavailable', capturedAt: now, scope: 'governance tables', reason: snapshot.ledgerUnavailableReason });
      governance = GovernanceProjectionCollector.factsForUnavailableSource({
        principleId, asOf: now, principle, collectionIssues: issues,
      });
    } else {
      sourceReads.push({ source: 'state.db', status: 'available', capturedAt: now, scope: 'pi_artifacts/tasks/approvals/activations' });
      governance = GovernanceProjectionCollector.buildFacts({
        principleId, asOf: now, principle,
        tables: {
          artifactRows: snapshot.artifactRows,
          taskRows: snapshot.taskRows,
          approvalRows: snapshot.approvalRows,
          activationRows: snapshot.activationRows,
        },
        collectionIssues: issues,
      });
    }

    // F5-compatible reference classification: derivedFromPainIds may hold
    // candidate UUIDs (current producer) or real Pain IDs (legacy writers).
    // Only ids that resolve to principle_candidates become candidate refs —
    // presence of an id never implies "it is a candidate".
    const resolvedCandidates: CandidateRow[] = [];
    let ambiguousReferences = false;
    for (const refId of entry.derivedFromPainIds) {
      const hit = snapshot.candidates.get(refId);
      if (hit !== undefined) resolvedCandidates.push(hit);
    }
    if (resolvedCandidates.length > 1) ambiguousReferences = true;
    const candidate = resolvedCandidates.length === 1 ? resolvedCandidates[0] : undefined;
    if (candidate === undefined && !compact) {
      sourceReads.push({
        source: 'principle_candidates',
        status: ambiguousReferences ? 'unavailable' : 'not_requested',
        capturedAt: now,
        scope: 'candidate by derivedFromPainIds',
        reason: ambiguousReferences ? 'multiple candidates resolve — refusing to guess (F5)' : 'no candidate resolved for the stored references',
      });
    } else if (candidate !== undefined && !compact) {
      sourceReads.push({ source: 'principle_candidates', status: 'available', capturedAt: now, scope: `candidate ${candidate.candidateId}` });
    }

    // Diagnosis read-through (diagnostic axis; NOT governance lineage).
    let diagnosis: DiagnosisMaterial | null = null;
    if (!compact && candidate?.artifactId !== undefined) {
      const artifact = snapshot.genericArtifacts.get(candidate.artifactId);
      if (artifact?.contentJson !== undefined) {
        diagnosis = this.parseDiagnosis(artifact.artifactId, artifact.contentJson);
        sourceReads.push({ source: 'artifacts.diagnostician_output', status: diagnosis !== null ? 'available' : 'unavailable', capturedAt: now, scope: `artifact ${artifact.artifactId}`, reason: diagnosis === null ? 'contentJson not a DiagnosticianOutput shape' : undefined });
      } else {
        sourceReads.push({ source: 'artifacts.diagnostician_output', status: 'unavailable', capturedAt: now, scope: `artifact ${candidate.artifactId}`, reason: 'generic artifact missing or unreadable' });
      }
    }

    // Scribe + philosopher materials from PI artifacts (governance axis).
    const semantic = this.readSemanticArtifacts(principleId, snapshot, compact);
    const { scribe, philosopher } = semantic;

    // Behavior applications (existing receipt ledger; read-only aggregate).
    // Codex review P2 fix: a missing/unreadable principle_applications table
    // must surface as an UNAVAILABLE source — an empty map with dbAvailable
    // true would present "available, zero retained" on a damaged workspace.
    let applications: OwnerDecisionInputs['applications'] = null;
    if (!compact && snapshot.dbAvailable && !snapshot.applicationsAvailable) {
      sourceReads.push({ source: 'principle_applications', status: 'unavailable', capturedAt: now, scope: 'level+kind aggregates', reason: 'principle_applications table missing or unreadable' });
    } else if (!compact && snapshot.dbAvailable) {
      const aggregated = snapshot.applicationsByPrinciple.get(principleId);
      if (aggregated !== undefined) {
        applications = {
          sourceStatus: 'available',
          deterministicCount: aggregated.deterministic,
          selfReportedCount: aggregated.selfReported,
          contextPresenceCount: aggregated.presence,
          windowDays: 90,
          recent: aggregated.recent,
        };
        sourceReads.push({ source: 'principle_applications', status: 'available', capturedAt: now, scope: 'level+kind aggregates + recent 5' });
      } else {
        applications = { sourceStatus: 'available', deterministicCount: 0, selfReportedCount: 0, contextPresenceCount: 0, windowDays: 90, recent: [] };
        sourceReads.push({ source: 'principle_applications', status: 'available', capturedAt: now, scope: 'level+kind aggregates (none retained)' });
      }
    }

    // Semantic sources (lineage-constrained, tier-ordered inputs for the
    // core selector; the collector only FILTERS by binding, never by text).
    const semanticSources: OwnerDecisionInputs['semanticSources'] = [];
    if (scribe?.statement !== undefined) {
      semanticSources.push({ tier: 'scribe', text: scribe.statement, sourceVersion: scribe.artifactId });
    }
    if (candidate?.abstractedPrinciple !== undefined && candidate.abstractedPrinciple.trim() !== '') {
      semanticSources.push({ tier: 'distiller', text: candidate.abstractedPrinciple, sourceVersion: candidate.candidateId });
    }
    if (philosopher?.title !== undefined) {
      semanticSources.push({ tier: 'philosopher', text: philosopher.title, sourceVersion: philosopher.artifactId });
    }
    if (candidate !== undefined && candidate.recommendationKind === 'principle') {
      semanticSources.push({ tier: 'candidate_principle', text: candidate.description, sourceVersion: candidate.candidateId });
    }

    const piRootBound = snapshot.dbAvailable
      && snapshot.artifactRows.some((row) => isRecord(row) && readOwnString(row, 'source_principle_id') === principleId);

    sourceReads.push({
      source: 'ledger',
      status: 'available',
      capturedAt: now,
      scope: 'principle entry',
    });

    return {
      schemaVersion: '1',
      principleId,
      asOf: now,
      ledger: {
        status: entry.status,
        text: entry.text,
        evaluability: entry.evaluability,
        triggerPattern: entry.triggerPattern,
        action: entry.action,
        derivedFromPainIds: entry.derivedFromPainIds,
        ruleIds: entry.ruleIds,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      },
      governance,
      candidate: candidate === undefined ? null : {
        candidateId: candidate.candidateId,
        status: candidate.status,
        recommendationKind: candidate.recommendationKind,
        description: candidate.description,
        ...(candidate.abstractedPrinciple === undefined ? {} : { abstractedPrinciple: candidate.abstractedPrinciple }),
        ...(candidate.trigger === undefined ? {} : { trigger: candidate.trigger }),
        ...(candidate.action === undefined ? {} : { action: candidate.action }),
        ...(candidate.title === undefined ? {} : { title: candidate.title }),
        ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
        ...(candidate.artifactId === undefined ? {} : { sourceRef: candidate.artifactId }),
      },
      diagnosis: diagnosis === null ? null : {
        artifactId: diagnosis.artifactId,
        ...(diagnosis.summary === undefined ? {} : { summary: diagnosis.summary }),
        ...(diagnosis.rootCause === undefined ? {} : { rootCause: diagnosis.rootCause }),
        evidenceItems: [],
        truncated: diagnosis.truncated,
      },
      scribe: scribe === null ? null : {
        artifactId: scribe.artifactId,
        ...(scribe.statement === undefined ? {} : { statement: scribe.statement }),
        ...(scribe.rationale === undefined ? {} : { rationale: scribe.rationale }),
        applicability: scribe.applicability,
        antiPatterns: scribe.antiPatterns,
        risks: scribe.risks,
        ...(scribe.targetBehavior === undefined ? {} : { targetBehavior: scribe.targetBehavior }),
        updatedAt: scribe.updatedAt,
      },
      philosopher: philosopher === null ? null : {
        artifactId: philosopher.artifactId,
        ...(philosopher.title === undefined ? {} : { title: philosopher.title }),
        ...(philosopher.rationale === undefined ? {} : { rationale: philosopher.rationale }),
        ...(philosopher.scope === undefined ? {} : { scope: philosopher.scope }),
      },
      applications,
      coverageSourceStatus: !snapshot.dbAvailable ? 'unavailable' : 'available',
      semanticSources,
      technicalRecommendationAvailable: candidate !== undefined
        && candidate.recommendationKind !== 'principle'
        && candidate.description.trim() !== '',
      // Fix 1 (review P1): per-artifact scribe materials — subject material
      // resolves against this list by the subject's own artifactId; unrelated
      // revisions never borrow each other's text.
      scribeMaterials: semantic.scribeMaterials.map((material) => ({
        artifactId: material.artifactId,
        statement: material.statement ?? '',
        ...(material.rationale === undefined ? {} : { rationale: material.rationale }),
        ...(material.targetBehavior === undefined ? {} : { targetBehavior: material.targetBehavior }),
        sourceVersion: material.artifactId,
      })),
      piRootBound,
      sourceReads,
    };
  }

  private ledgerEntryFor(ledgerParsed: unknown, principleId: string): {
    status: string; text: string; evaluability: string; triggerPattern: string;
    action: string; derivedFromPainIds: string[]; ruleIds: string[];
    createdAt: string; updatedAt: string;
  } {
    const tree = GovernanceProjectionCollector.principleTreeFromLedger(ledgerParsed);
    const raw = tree?.[principleId];
    if (!isRecord(raw)) throw new Error('principle_not_found');
    const stringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    return {
      status: readOwnString(raw, 'status') ?? 'candidate',
      text: readOwnString(raw, 'text') ?? '',
      evaluability: readOwnString(raw, 'evaluability') ?? 'weak_heuristic',
      triggerPattern: readOwnString(raw, 'triggerPattern') ?? '',
      action: readOwnString(raw, 'action') ?? '',
      derivedFromPainIds: stringArray(raw.derivedFromPainIds),
      ruleIds: stringArray(raw.ruleIds),
      createdAt: readOwnString(raw, 'createdAt') ?? '',
      updatedAt: readOwnString(raw, 'updatedAt') ?? '',
    };
  }

  private parseDiagnosis(artifactId: string, contentJson: string): DiagnosisMaterial | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contentJson);
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    const summary = readOwnString(parsed, 'summary');
    const rootCause = readOwnString(parsed, 'rootCause');
    if (summary === undefined && rootCause === undefined) return null;
    const rawText = JSON.stringify(parsed);
    return {
      artifactId,
      ...(summary === undefined ? {} : { summary }),
      ...(rootCause === undefined ? {} : { rootCause }),
      truncated: rawText.includes('___TRUNCATED___'),
    };
  }

  private readSemanticArtifacts(principleId: string, snapshot: BatchSnapshot, compact: boolean): {
    scribe: ScribeMaterial | null;
    philosopher: PhilosopherMaterial | null;
    scribeMaterials: ScribeMaterial[];
  } {
    let scribe: ScribeMaterial | null = null;
    const scribeMaterials: ScribeMaterial[] = [];
    let philosopher: PhilosopherMaterial | null = null;
    if (!snapshot.dbAvailable) return { scribe, philosopher, scribeMaterials };
    // Content rows are a separate targeted read: the shared governance batch
    // SELECT intentionally omits content_json (heavy) — the semantic read-through
    // needs it only for artifacts bound to THIS principle.
    const boundRows = snapshot.piArtifactContentRows.filter((row) =>
      isRecord(row) && readOwnString(row, 'source_principle_id') === principleId);
    for (const row of boundRows) {
      if (!isRecord(row)) continue;
      const artifactId = readOwnString(row, 'artifact_id');
      const sourceTaskId = readOwnString(row, 'source_task_id');
      const updatedAt = readOwnString(row, 'updated_at') ?? '';
      const contentJson = readOwnString(row, 'content_json');
      if (artifactId === undefined || sourceTaskId === undefined || contentJson === undefined) continue;
      const taskKind = snapshot.piArtifactTaskKinds.get(sourceTaskId);
      if (taskKind === 'scribe') {
        const material = parseScribeContent(artifactId, contentJson, updatedAt);
        if (material === null) continue;
        // Fix 1 (review P1): EVERY bound scribe artifact with a statement is
        // per-artifact decision material — subject material resolves against
        // this list by the subject's own artifactId, never borrowed across
        // revisions.
        scribeMaterials.push(material);
        if (scribe === null || material.updatedAt >= scribe.updatedAt) scribe = material;
      }
    }
    if (!compact) {
      // Philosopher tier needs an exact lineage relation: the artifact must be
      // inside the bound closure (lineage_artifact_ids from a bound artifact).
      const philosopherRows = this.philosopherRowsInBoundClosure(snapshot, boundRows);
      for (const row of philosopherRows) {
        if (!isRecord(row)) continue;
        const artifactId = readOwnString(row, 'artifact_id');
        const contentJson = readOwnString(row, 'content_json');
        if (artifactId === undefined || contentJson === undefined) continue;
        const material = parsePhilosopherContent(artifactId, contentJson);
        if (material !== null) philosopher = material;
      }
    }
    return { scribe, philosopher, scribeMaterials };
  }

  private piContentRowsById(snapshot: BatchSnapshot): Map<string, unknown> {
    const rowsById = new Map<string, unknown>();
    for (const row of snapshot.piArtifactContentRows) {
      if (isRecord(row)) {
        const id = readOwnString(row, 'artifact_id');
        if (id !== undefined) rowsById.set(id, row);
      }
    }
    return rowsById;
  }

  private philosopherRowsInBoundClosure(snapshot: BatchSnapshot, boundRows: unknown[]): unknown[] {
    const closure = new Set<string>();
    const queue = boundRows
      .filter(isRecord)
      .map((row) => readOwnString(row, 'artifact_id'))
      .filter((id): id is string => id !== undefined);
    const rowsById = this.piContentRowsById(snapshot);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || closure.has(current)) continue;
      closure.add(current);
      const row = rowsById.get(current);
      if (!isRecord(row)) continue;
      const lineageJson = readOwnString(row, 'lineage_artifact_ids');
      if (lineageJson === undefined) continue;
      try {
        const parsed: unknown = JSON.parse(lineageJson);
        if (Array.isArray(parsed)) {
          for (const id of parsed) {
            if (typeof id === 'string' && !closure.has(id)) queue.push(id);
          }
        }
      } catch {
        // malformed lineage on one row — skip its expansion only
      }
    }
    const result: unknown[] = [];
    for (const artifactId of closure) {
      const row = rowsById.get(artifactId);
      if (!isRecord(row)) continue;
      const sourceTaskId = readOwnString(row, 'source_task_id');
      if (sourceTaskId !== undefined && snapshot.piArtifactTaskKinds.get(sourceTaskId) === 'philosopher') {
        result.push(row);
      }
    }
    return result;
  }

  // ── batch snapshot (shared reads; one DB open per request) ────────────────

  private readBatchSnapshot(): BatchSnapshot {
    const dbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    const dbAvailable = fs.existsSync(dbPath);
    const candidates = new Map<string, CandidateRow>();
    const genericArtifacts = new Map<string, { artifactId: string; contentJson?: string; kind: string }>();
    const piArtifactTaskKinds = new Map<string, string>();
    const applicationsByPrinciple = new Map<string, { deterministic: number; selfReported: number; presence: number; recent: { text: string; createdAt?: string; level: string }[] }>();
    let applicationsAvailable = true;
    if (!dbAvailable) {
      // No state.db: governance tables are unavailable; the view degrades with
      // source_read_status=partial rather than pretending an empty world.
      return {
        artifactRows: [], taskRows: [], approvalRows: [], activationRows: [],
        piArtifactContentRows: [],
        candidates, genericArtifacts, piArtifactTaskKinds, applicationsByPrinciple,
        applicationsAvailable: false,
        dbAvailable: false,
        ledgerUnavailableReason: 'state.db not found',
      };
    }
    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const db = conn.getDb();
      // One injected handle for the shared 4-table read + the extra sources.
      const tables = GovernanceProjectionCollector.readTables(this.workspaceDir, conn);
      // Targeted content read for the semantic axes (scribe/philosopher text):
      // the shared governance SELECT omits content_json by design.
      const piArtifactContentRows = db.prepare(
        'SELECT artifact_id, source_task_id, source_principle_id, lineage_artifact_ids, content_json, updated_at FROM pi_artifacts ORDER BY artifact_id ASC',
      ).all();
      for (const row of db.prepare('SELECT candidate_id, status, recommendation_kind, description, abstracted_principle, trigger_pattern, action, title, confidence, artifact_id FROM principle_candidates').all()) {
        if (!isRecord(row)) continue;
        const candidateId = readOwnString(row, 'candidate_id');
        if (candidateId === undefined) continue;
        const confidence = Object.hasOwn(row, 'confidence') ? row.confidence : undefined;
        candidates.set(candidateId, {
          candidateId,
          status: readOwnString(row, 'status') ?? 'unknown',
          recommendationKind: readOwnString(row, 'recommendation_kind') ?? 'unknown',
          description: readOwnString(row, 'description') ?? '',
          ...(readOwnString(row, 'abstracted_principle') === undefined ? {} : { abstractedPrinciple: readOwnString(row, 'abstracted_principle') }),
          ...(readOwnString(row, 'trigger_pattern') === undefined ? {} : { trigger: readOwnString(row, 'trigger_pattern') }),
          ...(readOwnString(row, 'action') === undefined ? {} : { action: readOwnString(row, 'action') }),
          ...(readOwnString(row, 'title') === undefined ? {} : { title: readOwnString(row, 'title') }),
          ...(typeof confidence === 'number' ? { confidence } : {}),
          ...(readOwnString(row, 'artifact_id') === undefined ? {} : { artifactId: readOwnString(row, 'artifact_id') }),
        });
      }
      for (const row of db.prepare('SELECT artifact_id, artifact_kind, content_json FROM artifacts').all()) {
        if (!isRecord(row)) continue;
        const artifactId = readOwnString(row, 'artifact_id');
        if (artifactId === undefined) continue;
        genericArtifacts.set(artifactId, {
          artifactId,
          kind: readOwnString(row, 'artifact_kind') ?? 'unknown',
          ...(readOwnString(row, 'content_json') === undefined ? {} : { contentJson: readOwnString(row, 'content_json') }),
        });
      }
      for (const row of tables.taskRows) {
        if (!isRecord(row)) continue;
        const taskId = readOwnString(row, 'task_id');
        const taskKind = readOwnString(row, 'task_kind');
        if (taskId !== undefined && taskKind !== undefined) piArtifactTaskKinds.set(taskId, taskKind);
      }
      try {
        const grouped = db.prepare('SELECT principle_id, level, kind, COUNT(*) AS n FROM principle_applications GROUP BY principle_id, level, kind').all();
        for (const row of grouped) {
          if (!isRecord(row)) continue;
          const principleId = readOwnString(row, 'principle_id');
          const level = readOwnString(row, 'level');
          const kind = readOwnString(row, 'kind');
          const n = Object.hasOwn(row, 'n') && typeof row.n === 'number' ? row.n : 0;
          if (principleId === undefined || level === undefined || kind === undefined) continue;
          const bucket = applicationsByPrinciple.get(principleId) ?? { deterministic: 0, selfReported: 0, presence: 0, recent: [] };
          if (level === 'effect' && (kind === 'rule_blocked' || kind === 'auto_correct_applied')) bucket.deterministic += n;
          else if (level === 'effect' && kind === 'self_reported') bucket.selfReported += n;
          else if (level === 'presence') bucket.presence += n;
          applicationsByPrinciple.set(principleId, bucket);
        }
        const recent = db.prepare('SELECT principle_id, level, kind, digest, created_at FROM principle_applications ORDER BY created_at DESC LIMIT 250').all();
        for (const row of recent) {
          if (!isRecord(row)) continue;
          const principleId = readOwnString(row, 'principle_id');
          if (principleId === undefined) continue;
          const bucket = applicationsByPrinciple.get(principleId) ?? { deterministic: 0, selfReported: 0, presence: 0, recent: [] };
          if (bucket.recent.length < 5) {
            bucket.recent.push({
              text: `${readOwnString(row, 'kind') ?? 'observation'}${readOwnString(row, 'digest') !== undefined ? `：${(readOwnString(row, 'digest') ?? '').slice(0, 120)}` : ''}`,
              ...(readOwnString(row, 'created_at') === undefined ? {} : { createdAt: readOwnString(row, 'created_at') }),
              level: readOwnString(row, 'level') ?? 'unknown',
            });
          }
        }
      } catch {
        // Codex review P2: a missing/unreadable ledger table is an UNAVAILABLE
        // source, not an available-with-zero source (Codex P2 fix).
        applicationsAvailable = false;
      }
      return {
        ...tables,
        piArtifactContentRows,
        candidates,
        genericArtifacts,
        piArtifactTaskKinds,
        applicationsByPrinciple,
        applicationsAvailable,
        dbAvailable: true,
      };
    } finally {
      conn.close();
    }
  }
}

// ── PI artifact content parsers (rc-1/rc-2: untrusted JSON, validated) ─────

function parseScribeContent(artifactId: string, contentJson: string, updatedAt: string): ScribeMaterial | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const draft = parsed.principleDraft;
  const draftRecord = isRecord(draft) ? draft : undefined;
  // Codex P1 follow-up: a scribe artifact WITHOUT a statement carries no
  // owner-facing principle material — it must not be selected as "the" scribe
  // material for the principle (that would shadow a real one and would let
  // per-subject gating treat its revision as scribe-backed).
  if (draftRecord === undefined || readOwnString(draftRecord, 'statement') === undefined) return null;
  const risksValue = parsed.risks;
  const risks = Array.isArray(risksValue) ? risksValue.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
  const applicability = draftRecord !== undefined && Array.isArray(draftRecord.applicability)
    ? draftRecord.applicability.filter((item): item is string => typeof item === 'string')
    : [];
  const antiPatterns = draftRecord !== undefined && Array.isArray(draftRecord.antiPatterns)
    ? draftRecord.antiPatterns.filter((item): item is string => typeof item === 'string')
    : [];
  const intentContract = isRecord(parsed.intentContract) ? parsed.intentContract : undefined;
  const targetBehavior = intentContract !== undefined ? readOwnString(intentContract, 'targetBehavior') : undefined;
  return {
    artifactId,
    statement: readOwnString(draftRecord, 'statement'),
    ...(draftRecord !== undefined && readOwnString(draftRecord, 'rationale') !== undefined ? { rationale: readOwnString(draftRecord, 'rationale') } : {}),
    applicability,
    antiPatterns,
    risks,
    ...(targetBehavior === undefined ? {} : { targetBehavior }),
    updatedAt,
  };
}

function parsePhilosopherContent(artifactId: string, contentJson: string): PhilosopherMaterial | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const candidateRecord = isRecord(parsed.principleCandidate) ? parsed.principleCandidate : undefined;
  if (candidateRecord === undefined) return null;
  return {
    artifactId,
    ...(readOwnString(candidateRecord, 'title') === undefined ? {} : { title: readOwnString(candidateRecord, 'title') }),
    ...(readOwnString(candidateRecord, 'rationale') === undefined ? {} : { rationale: readOwnString(candidateRecord, 'rationale') }),
    ...(readOwnString(candidateRecord, 'scope') === undefined ? {} : { scope: readOwnString(candidateRecord, 'scope') }),
  };
}

// Compact semantic title helper for the Library list (same selector, no
// second eligibility algorithm).
export function compactSemanticTitle(view: OwnerDecisionViewCore): OwnerDecisionInboxItem['learnedPrinciple'] {
  if (view.learnedPrinciple.status === 'known') {
    return { status: 'known', text: view.learnedPrinciple.value.text, sourceTier: view.learnedPrinciple.value.sourceTier };
  }
  return { status: 'unknown', reasonText: view.learnedPrinciple.reason.ownerText };
}
