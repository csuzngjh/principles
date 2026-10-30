import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqlitePIArtifactStore,
  ApprovalQueue,
  RUNTIME_V2_PRINCIPLE_BUDGET,
  detectPromptReplacementTarget,
  computeArtifactDigest,
  SqliteActivationStateStore,
} from '@principles/core/runtime-v2';
import {
  checkPromptArtifactDeliverability,
  operatorDeclaredBudgetResolution,
  resolveLivePromptInjectionProjection,
  RUNTIME_BUDGET_OBSERVATION_STALE_REASON,
  runtimeBudgetObservationToResolution,
  selectConsoleRuntimeBudgetFacts,
  type PromptInjectionTargetHost,
} from '@principles/host-runtime';
import { PROMPT_BUDGET_HOST_KINDS } from '@principles/core/runtime-v2';
import { loadLedger } from '@principles/core/principle-tree-ledger';
import type { ApprovalRecord, PIArtifactRecord } from '@principles/core/runtime-v2';
import { loadPdConfig } from '../config/pd-config-store.js';
import {
  createArtifactPrincipleResolutionDeps,
  resolveArtifactPrincipleId,
} from './artifact-principle-resolver.js';
import type { PromptInjectionBudgetStatus } from '../../shared/prompt-injection-contract.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Type guard: non-null object (not array). Replaces `as Record<string, unknown>` assertions. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseContent(contentJson: string): unknown {
  try { return JSON.parse(contentJson); } catch { return null; }
}

function readStatement(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.principleDraft) && typeof value.principleDraft.statement === 'string') return value.principleDraft.statement;
  return typeof value.text === 'string' ? value.text : null;
}

export interface ApprovalGroup {
  principleId: string;
  principleTitle: string;
  /** Human-readable description extracted from the first record's artifact contentJson.
   *  Wave 7: replaces raw fake principleId as card title so Owner can actually
   *  review the candidate content instead of staring at an internal ID. */
  candidateDescription?: string;
  status: 'pending' | 'approved' | 'rejected';
  /**
   * PR-1894: whether this candidate's own serialized prompt entry fits the
   * injection budget on its own. `false` means the entry is oversized, so fair
   * rotation can NEVER inject it — the pre-approval badge must not promise it
   * will come around. Computed server-side with the production serializer
   * (the client has no access to the escaped, serialized size).
   * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: `true` now means "fits within the
   * supported budget range" — see `promptBudgetTierFit` for whether that is
   * unconditional (fits every tier) or model-dependent.
   */
  fitsPromptBudget?: boolean;
  /**
   * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.3: honest tier classification of
   * the candidate's own serialized entry against the supported
   * [min, max] budget range. `model_dependent` = fits only on
   * larger-context models — the badge must qualify rotation promises, not
   * promise unconditionally. `unconfirmed` mirrors the precheck's honest
   * unknown.
   */
  promptBudgetTierFit?: 'fits_all_tiers' | 'model_dependent' | 'exceeds_max_tier' | 'unconfirmed';
  revisionReviewUnavailable?: boolean;
  revisionReview?: { artifactId: string; artifactDigest: string; oldStatement: string; newStatement: string; intentFields: Record<string, string> };
  /**
   * PRI-940: the pinned artifact no longer exists in pi_artifacts (typically
   * superseded by a newer scribe revision). There is no contentJson, so
   * `candidateDescription` is unavailable and `principleTitle` degrades to the
   * synthesized `unlinked:<artifactId>` grouping key — a machine id that must
   * never be rendered as a title. Absent when the artifact is readable. rc-9:
   * the UI shows a visible degradation note instead of going silently blank.
   */
  artifactUnavailable?: boolean;
  records: {
    id: string;
    artifactId: string;
    channel: string;
    createdAt: string;
  }[];
}

export interface ApprovalsGroupedResponse {
  groups: ApprovalGroup[];
  generatedAt: string;
  /** Present when data is degraded/missing rather than genuinely empty */
  note?: string;
  /** PRI-908: prompt-channel injection budget status for the pre-approval forecast. */
  promptInjection?: PromptInjectionBudgetStatus;
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

/**
 * Wave 7: Extract a human-readable description from a PIArtifact's contentJson.
 *
 * The artifact kinds have different contentJson shapes �?this function unifies
 * them into a single description string the Owner can actually read to make a
 * review decision, instead of staring at a fabricated principleId.
 *
 * Supported shapes:
 * - rule:           extract `// Principle: <text>` and `// Rule: <text>` from implementationCode
 * - principle/demo: contentJson.text
 * - scribe:         contentJson.principleDraft.title + .statement
 * - philosopher:    contentJson.principleCandidate.title
 * - dreamer:        contentJson.candidates[0].betterDecision
 *
 * Returns null if no readable description can be extracted.
 */
function extractCandidateDescription(contentJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const obj = parsed;

  // rule artifact: extract from implementationCode comments
  if (typeof obj.implementationCode === 'string') {
    const principleMatch = /\/\/\s*Principle:\s*(.+)/.exec(obj.implementationCode);
    const ruleMatch = /\/\/\s*Rule:\s*(.+)/.exec(obj.implementationCode);
    const principleRaw = principleMatch ? principleMatch[1] : undefined;
    const ruleRaw = ruleMatch ? ruleMatch[1] : undefined;
    const principleText = principleRaw ? principleRaw.trim() : null;
    const ruleText = ruleRaw ? ruleRaw.trim() : null;
    if (principleText && ruleText) return `${principleText} — ${ruleText}`;
    if (ruleText) return ruleText;
    if (principleText) return principleText;
  }

  // principle artifact (demo shape): text field
  if (typeof obj.text === 'string' && obj.text.trim().length > 0) return obj.text.trim();

  // scribe artifact: principleDraft.title + .statement
  if (isRecord(obj.principleDraft)) {
    const draft = obj.principleDraft;
    const title = typeof draft.title === 'string' ? draft.title.trim() : '';
    const statement = typeof draft.statement === 'string' ? draft.statement.trim() : '';
    if (title && statement) return `${title} — ${statement}`;
    if (title) return title;
    if (statement) return statement;
  }

  // philosopher artifact: principleCandidate.title
  if (isRecord(obj.principleCandidate)) {
    const cand = obj.principleCandidate;
    if (typeof cand.title === 'string' && cand.title.trim().length > 0) return cand.title.trim();
  }

  // dreamer artifact: candidates[0].betterDecision
  if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
    const [first] = obj.candidates;
    if (isRecord(first)) {
      const c = first;
      if (typeof c.betterDecision === 'string' && c.betterDecision.trim().length > 0) {
        return c.betterDecision.trim();
      }
    }
  }

  return null;
}

/**
 * PR-1894 → PD_PROMPT_CAPACITY_V1 R-A2 → SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001:
 * classify this candidate's own prompt entry against the SUPPORTED budget
 * range (not one fixed number — approval time cannot know the executing
 * model).
 *
 * The judgment comes from the ONE shared host-runtime precheck
 * (`checkPromptArtifactDeliverability`): the REAL resolved principle id (not a
 * fixed 36-char UUID allowance — a title-derived id can only be longer), the
 * effective route's own serializer (list entry vs full directive render incl.
 * the self-report footer), and an honest `unconfirmed` verdict when the route
 * or the artifact content cannot be confirmed. `unconfirmed` is also the
 * conservative answer when the precheck itself fails — an unknown size must
 * never become a rotation promise (rc-9).
 */
async function candidatePromptBudgetTierFit(
  workspaceDir: string,
  artifact: PIArtifactRecord | null,
  targetHost?: PromptInjectionTargetHost,
): Promise<NonNullable<ApprovalGroup['promptBudgetTierFit']>> {
  const deliverability = await checkPromptArtifactDeliverability({
    workspaceDir,
    targetHost,
    artifact: artifact
      ? {
        artifactId: artifact.artifactId,
        artifactKind: artifact.artifactKind,
        contentJson: artifact.contentJson,
        validationStatus: artifact.validationStatus,
      }
      : null,
  });
  if (deliverability.status === 'deliverable') return 'fits_all_tiers';
  if (deliverability.status === 'model_dependent') return 'model_dependent';
  if (deliverability.status === 'undeliverable') return 'exceeds_max_tier';
  // Route/artifact unconfirmed: aggregate the per-host tier verdicts
  // MONOTONICALLY. The list route bills ~700 fewer chars than the shared
  // route for the same entry (fixed wrapper delta), so "shared exceeds but
  // list does not" is REACHABLE (e.g. a ~15300-char statement: list ≈15341
  // = model_dependent, shared ≈16058 = exceeds). Collapsing that to
  // exceeds_max_tier would tell an OpenClaw owner their entry can never
  // inject when a large-window list-route host could carry it. Only when
  // EVERY applicable host exceeds is "oversized everywhere" true; any
  // disagreement leaves the honest model_dependent. Without per-host
  // facts, do not promise at all.
  if (deliverability.perHost && deliverability.perHost.length > 0) {
    if (deliverability.perHost.every((entry) => entry.tierFit === 'exceeds_max_tier')) {
      return 'exceeds_max_tier';
    }
    if (deliverability.perHost.every((entry) => entry.tierFit === 'fits_all_tiers')) {
      return 'fits_all_tiers';
    }
    return 'model_dependent';
  }
  return 'unconfirmed';
}

export class ApprovalsGroupedConsoleModel {
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getApprovalsGrouped(targetHost?: PromptInjectionTargetHost): Promise<ApprovalsGroupedResponse> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return { groups: [], generatedAt: new Date().toISOString(), note: 'state.db not found — workspace may not be initialized' };
    }

    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const store = new SqliteApprovalQueueStore(conn);
      const queue = new ApprovalQueue(store);
      const artifactStore = new SqlitePIArtifactStore(conn);

      let allApprovals: ApprovalRecord[];
      try {
        allApprovals = await queue.listAll();
      } catch (err) {
        if (isMissingTableError(err)) {
          return { groups: [], generatedAt: new Date().toISOString(), note: 'approval table not found — workspace may not be initialized' };
        }
        throw err;
      }

      // Build artifactId �?sourcePrincipleId map AND artifactId �?candidateDescription map.
      // Wave 7: candidateDescription lets FocusPage show human-readable content
      // instead of a fabricated principleId.
      //
      // PRI-768 v5 follow-up (F3): sourcePrincipleId is null for most scribe
      // artifacts, which used to collapse every group to `unlinked:<id>` and
      // dead-end the owner decision UI. When the column is missing, fall back
      // to the shared lineage resolver (scribe �?dreamer seed �?candidateId �?      // ledger derivedFromPainIds) so groups bind to the REAL ledger id.
      const artifactPrincipleMap = new Map<string, string | null>();
      const artifactDescriptionMap = new Map<string, string | null>();
      // PR-1894: per-artifact "does this entry fit the budget alone" fact, so
      // the pre-approval badge never promises rotation for an entry that is
      // oversized (rotation cannot rescue a per-entry overflow).
      const artifactFitsBudgetMap = new Map<string, NonNullable<ApprovalGroup['promptBudgetTierFit']>>();
      const revisionReviewUnavailable = new Set<string>();
      const revisionReviews = new Map<string, NonNullable<ApprovalGroup['revisionReview']>>();
      // PRI-940: which approval artifacts are MISSING from the store (superseded
      // or pruned) — those cards have no contentJson, so the UI must degrade
      // visibly instead of rendering the `unlinked:` machine id as a title.
      const artifactUnavailableMap = new Map<string, boolean>();
      const stateDir = path.join(this.workspaceDir, '.state');
      const resolutionDeps = createArtifactPrincipleResolutionDeps(conn, artifactStore, this.workspaceDir);
      for (const approval of allApprovals) {
        if (!artifactPrincipleMap.has(approval.artifactId)) {
          try {
            const artifact: PIArtifactRecord | null = await artifactStore.getArtifactById(approval.artifactId);
            const mappedId = artifact ? await resolveArtifactPrincipleId(artifact, resolutionDeps) : null;
            artifactPrincipleMap.set(approval.artifactId, mappedId);
            if (artifact?.contentJson) {
              artifactDescriptionMap.set(approval.artifactId, extractCandidateDescription(artifact.contentJson));
            } else {
              artifactDescriptionMap.set(approval.artifactId, null);
            }
            if (artifact?.artifactKind === 'principle' && approval.channel === 'prompt' && approval.status === 'pending') {
              const detection = await detectPromptReplacementTarget({
                approvalArtifactId: artifact.artifactId,
                getArtifactById: (id) => artifactStore.getArtifactById(id),
                listPromptActivations: () => new SqliteActivationStateStore(conn).listPromptActivations(),
              });
              const current = parseContent(artifact.contentJson);
              const newStatement = readStatement(current);
              if (isRecord(current) && newStatement !== null) {
                for (const parentId of detection.ok && detection.target ? [detection.target.supersededArtifactId] : []) {
                  const prior = await artifactStore.getArtifactById(parentId);
                  if (prior?.artifactKind !== 'principle') continue;
                  const parent = parseContent(prior.contentJson);
                  const oldStatement = readStatement(parent);
                  if (oldStatement === null) continue;
                  const intentFields: Record<string, string> = {};
                  if (isRecord(current.intentContract)) {
                    for (const key of ['ownerIntent', 'targetBehavior', 'forbiddenBehavior', 'evidenceSource', 'validationExpectation']) {
                      const value = current.intentContract[key];
                      if (typeof value === 'string') intentFields[key] = value;
                    }
                  }
                  revisionReviews.set(artifact.artifactId, { artifactId: artifact.artifactId, artifactDigest: computeArtifactDigest(artifact), oldStatement, newStatement, intentFields });
                  break;
                }
              }
              if (!detection.ok || (detection.target !== null && !revisionReviews.has(artifact.artifactId))) revisionReviewUnavailable.add(artifact.artifactId);
            }
            artifactFitsBudgetMap.set(approval.artifactId, await candidatePromptBudgetTierFit(this.workspaceDir, artifact, targetHost));
            artifactUnavailableMap.set(approval.artifactId, artifact === null);
          } catch (err) {
            if (isMissingTableError(err)) {
              artifactPrincipleMap.set(approval.artifactId, null);
              artifactDescriptionMap.set(approval.artifactId, null);
              artifactFitsBudgetMap.set(approval.artifactId, 'unconfirmed');
              artifactUnavailableMap.set(approval.artifactId, true);
            } else {
              throw err;
            }
          }
        }
      }

      // Load ledger for principle titles
      let principleTitles = new Map<string, string>();
      try {
        const ledger = loadLedger(stateDir);
        for (const [id, principle] of Object.entries(ledger.tree.principles)) {
          principleTitles.set(id, principle.text);
        }
      } catch {
        // Ledger not available �?will fall back to principleId
      }

      // Group by principleId (null �?"unlinked")
      const groupMap = new Map<string, {
        id: string;
        artifactId: string;
        channel: string;
        createdAt: string;
        status: 'pending' | 'approved' | 'rejected';
      }[]>();

      for (const approval of allApprovals) {
        const mappedPrincipleId = artifactPrincipleMap.get(approval.artifactId);
        const principleId = mappedPrincipleId ?? `unlinked:${approval.artifactId}`;

        if (!groupMap.has(principleId)) {
          groupMap.set(principleId, []);
        }
        const records = groupMap.get(principleId);
        if (!records) continue;

        records.push({
          id: approval.approvalId,
          artifactId: approval.artifactId,
          channel: approval.channel,
          createdAt: approval.requestedAt,
          status: approval.status === 'approved' || approval.status === 'rejected'
            ? approval.status
            : 'pending',
        });
      }

      const groups: ApprovalGroup[] = [];
      for (const [principleId, records] of groupMap) {
        const statuses = records.map((r) => r.status);
        let status: 'pending' | 'approved' | 'rejected';
        if (statuses.every((s) => s === 'approved')) {
          status = 'approved';
        } else if (statuses.every((s) => s === 'rejected')) {
          status = 'rejected';
        } else {
          status = 'pending';
        }

        const principleTitle = principleTitles.get(principleId) ?? principleId;
        const firstArtifactId = records.find((record) => record.status === 'pending')?.artifactId ?? records[0]?.artifactId;
        const candidateDescription = firstArtifactId
          ? (artifactDescriptionMap.get(firstArtifactId) ?? undefined)
          : undefined;

        groups.push({
          principleId,
          principleTitle,
          candidateDescription,
          status,
          // PR-1894: undefined-safe — absent when the artifact could not be
          // read, which the UI treats as "do not promise rotation".
          // SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: the boolean stays the
          // rotation-promise signal (true = within the supported budget
          // range); the tier fit carries the honest fits-everywhere vs
          // model-dependent distinction.
          ...(firstArtifactId !== undefined && artifactFitsBudgetMap.has(firstArtifactId)
            ? {
              fitsPromptBudget: artifactFitsBudgetMap.get(firstArtifactId) === 'fits_all_tiers'
                || artifactFitsBudgetMap.get(firstArtifactId) === 'model_dependent',
              promptBudgetTierFit: artifactFitsBudgetMap.get(firstArtifactId),
            }
            : {}),
          // PRI-940: absent when the pinned artifact is readable — same
          // spread style as fitsPromptBudget so the wire contract stays
          // unchanged for healthy cards.
          ...(firstArtifactId !== undefined && artifactUnavailableMap.get(firstArtifactId) === true
            ? { artifactUnavailable: true }
            : {}),
          ...(firstArtifactId === undefined ? {} : { revisionReview: revisionReviews.get(firstArtifactId) }),
          ...(records.some((record) => record.status === 'pending' && revisionReviewUnavailable.has(record.artifactId))
            || (new Set(records.filter((record) => record.status === 'pending').map((record) => record.artifactId)).size > 1 && records.some((record) => revisionReviews.has(record.artifactId)))
            ? { revisionReviewUnavailable: true } : {}),
          records,
        });
      }

      return {
        groups,
        generatedAt: new Date().toISOString(),
        ...(await this.readPromptInjectionBudgetStatus(targetHost)),
      };
    } finally {
      try { conn.close(); } catch { /* best-effort */ }
    }
  }

  /**
   * PRI-908: recompute the production prompt injection projection so the
   * focus page can forecast "approved → effective" BEFORE the Owner decides.
   * PR #1844 follow-up: the forecast follows the workspace's REAL injection
   * route; PD_PROMPT_CAPACITY_V1 AC-01 additionally binds that route to host
   * facts (declarations ∪ pain evidence) or an explicit request-level target
   * host — a Codex workspace is never forecast on the list route, and when
   * the applicable hosts disagree the payload says `capacityStatus:
   * 'unconfirmed'` with per-host forecasts instead of guessing. Advisory
   * only: a projection failure omits the field — the approve-time precheck
   * (B1) remains the fail-loud gate (rc-9), so this must never fail the
   * grouped read.
   *
   * PRI-1017: the forecast now runs under the workspace's most recent
   * RUNTIME BUDGET OBSERVATION (the budget the last real injection used,
   * read from the existing `runtime_v2_prompt_activations_injected` events)
   * instead of the console's own parameterless fallback — SPEC
   * §6.1 forbids the injection and the console forecasting under different
   * budgets. The observation is a PAST fact: `budgetObservedAt` travels with
   * the payload so the UI labels it as such. No observation, an observation
   * for a different host, or an observation past the freshness bound ⇒ the
   * honest fixed-fallback projection (with `runtime_budget_observation_stale`
   * when a stale observation exists). No second budget state is created:
   * the events remain the single runtime record and this is a read model.
   */
  private async readPromptInjectionBudgetStatus(targetHost?: PromptInjectionTargetHost): Promise<{ promptInjection?: PromptInjectionBudgetStatus }> {
    try {
      const facts = selectConsoleRuntimeBudgetFacts({
        workspaceDir: this.workspaceDir,
        ...(targetHost !== undefined ? { targetHost } : {}),
      });
      const perHostBudget = new Map(
        [...facts.perHost].map(([hostKind, observation]) => [hostKind, runtimeBudgetObservationToResolution(observation)] as const),
      );
      // PRI-1020: a host with NO fresh runtime observation falls back to the
      // Owner's declared basis (.pd/config.yaml promptBudget) instead of the
      // fixed 2000 — resolved through the same tier-0 policy branch the real
      // injection uses, so forecast and injection can never disagree. A fresh
      // observation still wins (it is what the runtime actually did last).
      const configLoad = loadPdConfig(this.workspaceDir);
      const declaredConfig = configLoad.ok ? configLoad.effective.config.promptBudget : undefined;
      const declaredHosts = new Set<PromptInjectionTargetHost>();
      for (const hostKind of PROMPT_BUDGET_HOST_KINDS) {
        if (perHostBudget.has(hostKind)) continue;
        const declared = operatorDeclaredBudgetResolution(declaredConfig, hostKind);
        if (declared !== undefined) {
          perHostBudget.set(hostKind, declared);
          declaredHosts.add(hostKind);
        }
      }
      const resolution = await resolveLivePromptInjectionProjection({
        workspaceDir: this.workspaceDir,
        ...(targetHost !== undefined ? { targetHost } : {}),
        ...(facts.selected !== undefined
          ? { promptBudget: runtimeBudgetObservationToResolution(facts.selected) }
          : {}),
        ...(perHostBudget.size > 0
          ? { perHostPromptBudget: Object.fromEntries(perHostBudget) }
          : {}),
      });
      if (resolution.status === 'unconfirmed') {
        // The numbers still come from the flag-based view so the badge can
        // show SOMETHING, but capacityStatus marks them not authoritative.
        // PRI-1017: each per-host forecast runs under THAT host's own
        // observation (or its own fallback) — no host's window is smuggled
        // into another host's number, and the headline reference is never
        // presented as the current host's actual budget (the banner says so).
        // The top-level numbers are a legacy REFERENCE view only (required
        // fields for old consumers). Under `capacityStatus: 'unconfirmed'`
        // they bind to no host, so the UI must never present them as the
        // current host's actual budget — every host's own basis is in
        // `perHost`, including its own fallback reason.
        const reference = resolution.perHost[0]?.projection;
        return {
          promptInjection: {
            budget: reference?.budget ?? RUNTIME_V2_PRINCIPLE_BUDGET,
            usedChars: reference?.usedChars ?? 0,
            truncated: reference?.truncated ?? false,
            capacityStatus: 'unconfirmed',
            unconfirmedReason: resolution.decision.unconfirmedReason ?? 'effective injection route cannot be confirmed',
            nextAction: resolution.decision.nextAction ?? 'pass an explicit target host (openclaw|codex|workbuddy)',
            perHost: resolution.perHost.map((entry) => {
              const observation = facts.perHost.get(entry.hostKind);
              // PRI-1020: the stale marker explains a FALLBACK that ignored a
              // too-old observation; it must not contradict a declared basis
              // that was actually used.
              const declaredUsed = observation === undefined && declaredHosts.has(entry.hostKind);
              const stale = observation === undefined && !declaredUsed
                ? facts.stalePerHost.get(entry.hostKind)
                : undefined;
              return {
                hostKind: entry.hostKind,
                route: entry.projection.route,
                usedChars: entry.projection.usedChars,
                truncated: entry.projection.truncated,
                budget: entry.projection.budget,
                ...(entry.projection.budgetCapacitySource !== undefined ? { budgetCapacitySource: entry.projection.budgetCapacitySource } : {}),
                ...(entry.projection.budgetCapacityStatus !== undefined ? { budgetCapacityStatus: entry.projection.budgetCapacityStatus } : {}),
                ...(observation !== undefined ? { budgetObservedAt: observation.observedAt } : {}),
                ...(stale !== undefined
                  ? { budgetFallbackReason: RUNTIME_BUDGET_OBSERVATION_STALE_REASON }
                  : entry.projection.budgetFallbackReason !== undefined
                    ? { budgetFallbackReason: entry.projection.budgetFallbackReason }
                    : {}),
              };
            }),
          },
        };
      }
      const {projection} = resolution;
      // Bind the observation to the host the route actually resolved to — not
      // to a request parameter that may be absent (single-host workspace) or
      // to whichever host happens to appear first.
      const decidedHost = resolution.decision.hostKind;
      const usedObservation = decidedHost !== undefined ? facts.perHost.get(decidedHost) : undefined;
      const declaredHeadlineUsed = decidedHost !== undefined && usedObservation === undefined && declaredHosts.has(decidedHost);
      const staleObservation = decidedHost !== undefined && usedObservation === undefined && !declaredHeadlineUsed
        ? facts.stalePerHost.get(decidedHost)
        : undefined;
      return {
        promptInjection: {
          budget: projection.budget,
          usedChars: projection.usedChars,
          truncated: projection.truncated,
          // PR-1894: the badge must describe what the PRODUCTION route will do,
          // not which policy this session-less forecast happened to run.
          productionRotates: projection.productionRotates,
          eligibleCount: projection.eligibleCount,
          capacityStatus: 'confirmed',
          ...(resolution.decision.hostKind !== undefined ? { hostKind: resolution.decision.hostKind } : {}),
          route: projection.route,
          unit: projection.unit,
          budgetScope: projection.budgetScope,
          ...(projection.fullRenderChars !== undefined ? { fullRenderChars: projection.fullRenderChars } : {}),
          oversizedActivationIds: projection.oversizedActivationIds,
          oversizedDiagnosticTruncated: projection.oversizedDiagnosticTruncated,
          // SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §7: budget provenance — when
          // a runtime budget OBSERVATION backs this forecast (PRI-1017) the
          // numbers are the ones the last real injection used; otherwise this
          // is the fixed-budget view and the UI labels it as such.
          ...(projection.budgetCapacitySource !== undefined ? { budgetCapacitySource: projection.budgetCapacitySource } : {}),
          ...(projection.budgetCapacityStatus !== undefined ? { budgetCapacityStatus: projection.budgetCapacityStatus } : {}),
          ...(projection.budgetContextWindowTokens != null ? { budgetContextWindowTokens: projection.budgetContextWindowTokens } : {}),
          ...(projection.budgetFallbackReason !== undefined ? { budgetFallbackReason: projection.budgetFallbackReason } : {}),
          // A stale observation is NOT a current fact: the honest reason code
          // replaces the generic absence code so the UI can say why the
          // runtime's last budget was not used.
          ...(staleObservation !== undefined ? { budgetFallbackReason: RUNTIME_BUDGET_OBSERVATION_STALE_REASON } : {}),
          ...(usedObservation !== undefined ? { budgetObservedAt: usedObservation.observedAt } : {}),
        },
      };
    } catch (err: unknown) {
      // rc-9: degradation is observable to operators even though it stays
      // invisible in the UI payload (the badge is advisory only).
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pd-console] prompt injection forecast unavailable, omitting promptInjection: ${message}`);
      return {};
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- lifecycle interface; connections are request-scoped
  dispose(): void {
    // Connections are opened and closed per-request; no persistent state.
  }
}
