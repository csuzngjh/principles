import {
  SqliteConnection,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
  extractPrincipleId,
  extractEvidenceRefs,
  PromotionReadinessReader,
  RuleHostWriter,
  createProductionGateDeps,
  SqliteActivationSafetyStore,
  isFeatureEnabled,
  RuleCodeOwnerDecisionService,
  collectOpenClawPromotionChecks,
  summarizeRuleCodeShadowEvents,
  buildPromotionEvidenceSnapshot,
} from '@principles/core/runtime-v2';
import type { ActivationStatusRecord, PIArtifactRecord, PIArtifactSnapshot, PromotionReadinessResult, PromotionEvidenceSnapshot, ActivationControlState, ActivationDecisionRecord, GlobalRuleCodePause, OwnerPromotionActor, OwnerPromotionResult } from '@principles/core/runtime-v2';
import { OPENCLAW_HOST_LIVENESS_CONTRACT } from '@principles/host-runtime';
import { loadPdConfig, computeFlagsFromLoadResult } from '../config/pd-config-store.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  authorizeGovernanceAction,
  writeGovernanceAction,
  type GovernanceAuditWriter,
} from 'principles-disciple/governance-audit';

/**
 * Type guard for parsed JSON objects (rc-2-no-as-bypass).
 * Replaces `as Record<string, unknown>` casts on untrusted contentJson.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/**
 * PRI-491 — owner-observable activation record.
 *
 * Mirrors the CLI's `AnnotatedActivation` so the Console surfaces the same
 * mode / status / contextVersion / evidenceRefs / nextAction fields the owner
 * sees in `pd activation list`. Without this enrichment the Console would
 * hide suspended-by-flag state, silently showing v2 activations as "active"
 * even when the rulecode_context_v2 flag is off.
 */
export interface ActivationRecord {
  activationId: string;
  artifactId: string;
  principleId: string;
  channel: string;
  action: string;
  targetRef: string;
  activatedAt: string | null;
  /** When this activation was promoted from shadow to live (null for never-promoted). */
  promotedAt: string | null;
  /** When this activation was deactivated (null for active). */
  deactivatedAt: string | null;
  /**
   * Lifecycle mode derived from action.
   * - 'shadow' for code_tool_hook_shadow_activate
   * - 'live'   for code_tool_hook_live_activate
   * - undefined for unrecognized actions (cannot be safely mode-tagged).
   */
  mode?: 'shadow' | 'live';
  /**
   * Owner-visible status. Precedence: deactivated > suspended_by_flag > active.
   * - 'deactivated'      — deactivatedAt is non-null.
   * - 'suspended_by_flag' — v2 artifact but rulecode_context_v2 flag is off.
   * - 'active'           — loaded and (for v2) flag is on.
   */
  status: 'active' | 'deactivated' | 'suspended_by_flag';
  /** Artifact context version derived from requiresContextVersion field. */
  contextVersion?: 'v1' | 'v2';
  /** Owner-labelled evidence refs preserved from the artifact (PRI-490). */
  evidenceRefs?: string[];
  /** Human-readable summary of evidenceRefs for display. */
  evidenceSummary?: string;
  /** Next CLI command the owner should run to act on this activation. */
  nextAction?: string;
  /** Present when the activation references a non-existent artifact. */
  warning?: string;
  enforcement?: 'eligible' | 'safety_isolated';
  legacyDecisionUnknown?: boolean;
  ownerReviewDueAt?: string;
}

export interface ActivationsResponse {
  activations: ActivationRecord[];
  /** 'ok' on success, 'degraded' when data is incomplete/missing. */
  status: 'ok' | 'degraded';
  /** Present when status is 'degraded' — explains why. */
  reason?: string;
  /** Present when status is 'degraded' — next operator action. */
  nextAction?: string;
}

export interface RuleCodeOwnerReview {
  activation: ActivationStatusRecord;
  artifact: { artifactId: string; digest: string; sourceTaskId: string; lineageArtifactIds: string[]; content: Record<string, unknown> | null };
  readiness: PromotionReadinessResult;
  controlState: ActivationControlState | null;
  decisions: ActivationDecisionRecord[];
  globalPause: GlobalRuleCodePause | null;
  ownerDecisionEnabled: boolean;
  runtimeCapability: { hostRuntimeVersion: string; shadowEvidence: boolean };
  liveMetrics: RuleCodeTelemetryMetrics;
  behaviorDrift: { approvedBlockRate: number | null; liveBlockRate: number | null; delta: number | null };
}

interface RuleCodeTelemetryWindow { eligible: number | null; matched: number | null; blocked: number | null; unhealthy: number | null; circuitTrips: number; toolDistribution: Record<string, number> | null }
interface RuleCodeTelemetryMetrics { last24Hours: RuleCodeTelemetryWindow; last7Days: RuleCodeTelemetryWindow; representativeSamples: { toolName: string; decision: string; pathCategory: string }[] }

export interface OwnerMutationInput {
  actor: OwnerPromotionActor;
  idempotencyKey: string;
  reasonCode: string;
  note?: string;
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

/**
 * Bug-O L2 fix: adapt PIArtifactRecord (DB row) to PIArtifactSnapshot (activation
 * contract type). The two interfaces have identical fields but different names —
 * we use explicit field copy instead of `as` to comply with rc-2-no-as-bypass
 * and to surface future field drift as a compile error.
 */
function toSnapshot(record: PIArtifactRecord): PIArtifactSnapshot {
  return {
    artifactId: record.artifactId,
    artifactKind: record.artifactKind,
    sourceTaskId: record.sourceTaskId,
    sourcePrincipleId: record.sourcePrincipleId,
    sourceRuleId: record.sourceRuleId,
    lineageArtifactIds: record.lineageArtifactIds,
    validationStatus: record.validationStatus,
    contentJson: record.contentJson,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function makeActivationDecision(value: { activation: ActivationStatusRecord; artifactDigest: string; decision: 'continue_observing' | 'reject_after_shadow' | 'emergency_deactivate'; input: OwnerMutationInput }): ActivationDecisionRecord {
  const { activation, artifactDigest, decision, input } = value;
  return {
    decisionId: `decision-${randomUUID()}`,
    subject: { kind: 'activation', activationId: activation.activationId, artifactId: activation.artifactId, artifactDigest },
    decision, principal: input.actor.principal, authentication: input.actor.authentication,
    ...(input.actor.operator ? { operator: input.actor.operator } : {}), reasonCode: input.reasonCode,
    note: input.note?.trim() || null, evidenceSnapshotId: null, decidedAt: new Date().toISOString(),
  };
}

function unavailableShadowSummary(): PromotionEvidenceSnapshot['shadowSummary'] {
  return {
    observed: null, matched: null, wouldBlock: null, wouldAllow: null,
    requireApproval: null, autoCorrect: null, errors: null, neutralControl: null,
    firstObservedAt: null, lastObservedAt: null,
  };
}

/**
 * PRI-577: RuleCode event telemetry candidate directories, in priority order.
 *
 * Runtime V2 convention is `.pd/logs`, but the v1 EventLog writer
 * (openclaw-plugin `src/core/event-log.ts`) still emits `events_*.jsonl` under
 * `.state/logs`. No production code ever created `.pd/logs`, so scanning only
 * that path made every activation's shadow metrics report "unavailable" in the
 * console while real evaluations accumulated unread in `.state/logs`. Readers
 * scan both candidates until the writer migrates (ERR-031: both readers derive
 * from this same list).
 */
export const RULECODE_EVENT_LOG_CANDIDATE_DIRS: readonly string[] = ['.pd/logs', '.state/logs'];

export interface CollectedRuleCodeEventEntries {
  entries: unknown[];
  /** Number of candidate directories that actually exist on disk. */
  sourceDirsFound: number;
}

/**
 * Collect rulehost telemetry entries from all candidate log directories.
 * Malformed lines are excluded individually. A directory counts as a source
 * only after it can be enumerated, so an unreadable path cannot be mistaken
 * for a healthy channel with zero events (ERR-002).
 *
 * Exact lines copied between candidate directories are deduplicated by
 * priority. Different events in same-named daily files are retained.
 */
export function collectRuleCodeEventEntries(workspaceDir: string): CollectedRuleCodeEventEntries {
  const entries: unknown[] = [];
  let sourceDirsFound = 0;
  const higherPriorityLines = new Set<string>();
  for (const candidate of RULECODE_EVENT_LOG_CANDIDATE_DIRS) {
    const logsDir = path.join(workspaceDir, ...candidate.split('/'));
    if (!fs.existsSync(logsDir)) continue;
    try {
      const files = fs.readdirSync(logsDir)
        .filter(name => /^events_.*\.jsonl$/.test(name))
        .sort()
        .slice(-7);
      sourceDirsFound += 1;
      const currentSourceLines: string[] = [];
      for (const file of files) {
        const lines = fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          currentSourceLines.push(line);
          if (higherPriorityLines.has(line)) continue;
          try { entries.push(JSON.parse(line) as unknown); } catch { /* exclude malformed telemetry */ }
        }
      }
      for (const line of currentSourceLines) higherPriorityLines.add(line);
    } catch { /* unreadable directory contributes no entries */ }
  }
  return { entries, sourceDirsFound };
}

function readRuleCodeTelemetry(workspaceDir: string, activationId: string, decisions: readonly ActivationDecisionRecord[]): { shadowSummary: PromotionEvidenceSnapshot['shadowSummary']; metrics: RuleCodeTelemetryMetrics } {
  const countCircuitTrips = (minimumTime: number) => decisions.filter(decision => decision.decision === 'safety_isolate' && Date.parse(decision.decidedAt) >= minimumTime).length;
  const now = Date.now();
  const unavailableWindow = (minimumTime: number): RuleCodeTelemetryWindow => ({ eligible: null, matched: null, blocked: null, unhealthy: null, circuitTrips: countCircuitTrips(minimumTime), toolDistribution: null });
  const collected = collectRuleCodeEventEntries(workspaceDir);
  if (collected.sourceDirsFound === 0) return { shadowSummary: unavailableShadowSummary(), metrics: { last24Hours: unavailableWindow(now - 24 * 60 * 60 * 1000), last7Days: unavailableWindow(now - 7 * 24 * 60 * 60 * 1000), representativeSamples: [] } };
  const { entries } = collected;
  const summarizeWindow = (minimumTime: number): RuleCodeTelemetryWindow => {
    let eligible = 0; let matched = 0; let blocked = 0; let unhealthy = 0; const tools: Record<string, number> = {};
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.ts !== 'string' || Date.parse(entry.ts) < minimumTime || !isRecord(entry.data) || entry.data.activationId !== activationId) continue;
      if (entry.type === 'rulehost_unhealthy') { unhealthy += 1; continue; }
      if (entry.type !== 'rulehost_evaluated' || entry.data.activationMode !== 'live') continue;
      eligible += 1; if (entry.data.matched === true) matched += 1; if (entry.data.decision === 'block') blocked += 1;
      if (typeof entry.data.toolName === 'string') tools[entry.data.toolName] = (tools[entry.data.toolName] ?? 0) + 1;
    }
    return { eligible, matched, blocked, unhealthy, circuitTrips: countCircuitTrips(minimumTime), toolDistribution: tools };
  };
  const representativeSamples: RuleCodeTelemetryMetrics['representativeSamples'] = [];
  for (const entry of entries) {
    if (representativeSamples.length >= 6) break;
    if (!isRecord(entry) || entry.type !== 'rulehost_evaluated' || !isRecord(entry.data) || entry.data.activationId !== activationId || typeof entry.data.toolName !== 'string' || typeof entry.data.decision !== 'string') continue;
    const filePath = typeof entry.data.filePath === 'string' ? entry.data.filePath : '';
    representativeSamples.push({ toolName: entry.data.toolName, decision: entry.data.decision, pathCategory: path.extname(filePath) || (filePath ? 'workspace_path' : 'no_path') });
  }
  return { shadowSummary: summarizeRuleCodeShadowEvents(entries, activationId), metrics: { last24Hours: summarizeWindow(now - 24 * 60 * 60 * 1000), last7Days: summarizeWindow(now - 7 * 24 * 60 * 60 * 1000), representativeSamples } };
}

export class ActivationsConsoleModel {
  private readonly workspaceDir: string;
  private readonly governanceAuditWriter: GovernanceAuditWriter;

  constructor(workspaceDir: string, governanceAuditWriter: GovernanceAuditWriter = writeGovernanceAction) {
    this.workspaceDir = workspaceDir;
    this.governanceAuditWriter = governanceAuditWriter;
  }

  async getActivations(): Promise<ActivationsResponse> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return { activations: [], status: 'degraded', reason: 'state.db not found — workspace may not be initialized', nextAction: 'Run pd runtime diagnostics to check workspace state' };
    }

    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const activationStore = new SqliteActivationStateStore(conn);
      const artifactStore = new SqlitePIArtifactStore(conn);

      let allActivations: ActivationStatusRecord[];
      try {
        allActivations = await activationStore.listAllActivations();
      } catch (err) {
        if (isMissingTableError(err)) {
          return { activations: [], status: 'degraded', reason: 'activation table not found — workspace may not be initialized', nextAction: 'Run pd runtime internalization integrity to check schema' };
        }
        throw err;
      }

      // Build artifactId → principleId map. Bug-O L2 fix: use extractPrincipleId
      // (4-step fallback: column → parsed.principleId → parsed.sourcePrincipleId
      // → parsed.principleDraft.title) instead of only reading the column.
      // Without this, dreamer artifacts whose sourcePrincipleId was stripped
      // (non-core-principle case) would show 'unlinked' even when contentJson
      // carries a resolvable principleId.
      //
      // PRI-491: also collect contextVersion + evidenceRefs from contentJson so
      // the Console can show whether a rule will block and why. rc-1/rc-2:
      // contentJson is parsed as unknown and type-narrowed with typeof; never
      // `as`-cast without a prior typeof check.
      const artifactPrincipleMap = new Map<string, string | null>();
      const artifactMetadata = new Map<string, { contextVersion: 'v1' | 'v2'; evidenceRefs: string[] | null }>();
      const danglingArtifactIds = new Set<string>();
      for (const activation of allActivations) {
        if (!artifactPrincipleMap.has(activation.artifactId)) {
          try {
            const artifact: PIArtifactRecord | null = await artifactStore.getArtifactById(activation.artifactId);
            if (!artifact) {
              danglingArtifactIds.add(activation.artifactId);
              artifactPrincipleMap.set(activation.artifactId, null);
            } else {
              const principleId = extractPrincipleId(toSnapshot(artifact));
              artifactPrincipleMap.set(activation.artifactId, principleId);

              // PRI-491: extract contextVersion + evidenceRefs from contentJson.
              // rc-1: treat parsed JSON as unknown; rc-2: narrow with typeof.
              let parsedContent: Record<string, unknown> | null = null;
              try {
                const parsed: unknown = JSON.parse(artifact.contentJson);
                if (isRecord(parsed)) {
                  parsedContent = parsed;
                }
              } catch {
                // Malformed contentJson — treat as no metadata. Not dangling,
                // just unreadable; the principleId may still resolve via column.
              }
              const requiresCtxV2 = parsedContent !== null
                && Object.hasOwn(parsedContent, 'requiresContextVersion')
                && parsedContent.requiresContextVersion === 2;
              const contextVersion: 'v1' | 'v2' = requiresCtxV2 ? 'v2' : 'v1';
              const evidenceRefs = parsedContent !== null ? extractEvidenceRefs(parsedContent) : null;
              artifactMetadata.set(activation.artifactId, { contextVersion, evidenceRefs });
            }
          } catch (err) {
            if (isMissingTableError(err)) {
              artifactPrincipleMap.set(activation.artifactId, null);
            } else {
              throw err;
            }
          }
        }
      }

      // PRI-491: Probe rulecode_context_v2 flag to determine suspended_by_flag
      // status for v2 activations. When the flag is off, v2 activations are
      // suspended (not executing) even though they remain active in the DB.
      const featureFlags = computeFlagsFromLoadResult(loadPdConfig(this.workspaceDir));
      const v2FlagEnabled = featureFlags.flags.rulecode_context_v2?.enabled === true;
      const safetyStore = new SqliteActivationSafetyStore(conn);
      const controlByActivation = new Map<string, ActivationControlState>();
      const hasPromotionDecision = new Set<string>();
      for (const activation of allActivations) {
        const control = await safetyStore.getControlState(activation.activationId);
        if (control) controlByActivation.set(activation.activationId, control);
        const decisions = await safetyStore.listDecisions(activation.activationId);
        if (decisions.some(decision => decision.decision === 'promote_live')) hasPromotionDecision.add(activation.activationId);
      }

      const facts: ActivationRecord[] = allActivations.map((record) => {
        const meta = artifactMetadata.get(record.artifactId);
        const contextVersion = meta?.contextVersion;
        const evidenceRefs = meta?.evidenceRefs ?? undefined;
        const evidenceSummary = evidenceRefs && evidenceRefs.length > 0
          ? `${evidenceRefs.length} evidence ref(s): ${evidenceRefs.slice(0, 3).join(', ')}${evidenceRefs.length > 3 ? '...' : ''}`
          : undefined;

        // Derive mode from action (shadow_activate -> shadow, live_activate -> live).
        const mode: 'shadow' | 'live' | undefined = record.action === 'code_tool_hook_shadow_activate'
          ? 'shadow'
          : record.action === 'code_tool_hook_live_activate'
            ? 'live'
            : undefined;

        // Derive status: deactivated > suspended_by_flag > active (matches CLI).
        let status: 'active' | 'deactivated' | 'suspended_by_flag';
        let nextAction: string | undefined;
        if (record.deactivatedAt) {
          status = 'deactivated';
          nextAction = undefined;
        } else if (contextVersion === 'v2' && !v2FlagEnabled) {
          status = 'suspended_by_flag';
          nextAction = `Enable rulecode_context_v2 flag or deactivate: pd activation deactivate --activation-id ${record.activationId}`;
        } else {
          status = 'active';
          if (mode === 'shadow') {
            nextAction = 'Keep shadow; promotion requires an authenticated Owner decision, immutable evidence bindings, and a passing Promotion Readiness result.';
          } else if (mode === 'live') {
            nextAction = `pd activation deactivate --activation-id ${record.activationId}`;
          } else {
            nextAction = undefined;
          }
        }

        const enriched: ActivationRecord = {
          activationId: record.activationId,
          artifactId: record.artifactId,
          principleId: artifactPrincipleMap.get(record.artifactId) ?? 'unlinked',
          channel: record.channel,
          action: record.action,
          targetRef: record.targetRef,
          activatedAt: record.activatedAt,
          promotedAt: record.promotedAt ?? null,
          deactivatedAt: record.deactivatedAt,
          mode,
          status,
          contextVersion,
          evidenceRefs,
          evidenceSummary,
          nextAction,
          enforcement: controlByActivation.get(record.activationId)?.enforcement,
          ...(mode === 'live' && !hasPromotionDecision.has(record.activationId) ? {
            legacyDecisionUnknown: true,
            ownerReviewDueAt: new Date(new Date(record.promotedAt ?? record.activatedAt ?? Date.now()).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          } : {}),
        };
        if (danglingArtifactIds.has(record.artifactId)) {
          enriched.warning = `artifact_id "${record.artifactId}" does not exist in pi_artifacts - activation is orphaned`;
        }
        return enriched;
      });

      // rc-9: surface dangling references instead of silently returning a degraded list.
      if (danglingArtifactIds.size > 0) {
        return {
          activations: facts,
          status: 'degraded',
          reason: `${danglingArtifactIds.size} activation(s) reference non-existent artifact_id(s): ${Array.from(danglingArtifactIds).join(', ')}`,
          nextAction: 'Run pd runtime internalization integrity to check for orphaned activations',
        };
      }

      return {
        activations: facts,
        status: 'ok',
      };
    } finally {
      try { conn.close(); } catch { /* best-effort */ }
    }
  }

  async getOwnerReview(activationId: string, ownerIdentityConfigured = false, ownerActor?: OwnerPromotionActor): Promise<RuleCodeOwnerReview> {
    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const activationStore = new SqliteActivationStateStore(conn);
      const artifactStore = new SqlitePIArtifactStore(conn);
      const safetyStore = new SqliteActivationSafetyStore(conn);
      const codeActivations = await activationStore.listCodeToolHookActivations(true);
      const matches = codeActivations.filter(record => record.activationId === activationId);
      if (matches.length !== 1) throw new Error(`Owner review requires exactly one RuleCode activation: ${activationId}`);
      const [activation] = matches;
      if (!activation) throw new Error(`Activation not found: ${activationId}`);
      const artifact = await artifactStore.getArtifactById(activation.artifactId);
      if (!artifact) throw new Error(`Artifact not found for activation: ${activation.artifactId}`);
      const digest = `sha256:${createHash('sha256').update(JSON.stringify(artifact), 'utf8').digest('hex')}`;
      const decisions = await safetyStore.listDecisions(activationId);
      const telemetry = readRuleCodeTelemetry(this.workspaceDir, activationId, decisions);
      const flags = computeFlagsFromLoadResult(loadPdConfig(this.workspaceDir));
      const writer = new RuleHostWriter({ gateDeps: createProductionGateDeps(), featureFlagProbe: id => isFeatureEnabled(flags, id) });
      const reader = new PromotionReadinessReader({
        listCodeToolHookActivations: () => activationStore.listCodeToolHookActivations(true),
        getArtifactById: id => artifactStore.getArtifactById(id),
        computeArtifactDigest: value => `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`,
        validateProductionArtifact: value => writer.canActivate(value),
        collectHostChecks: async value => {
          const liveArtifacts: PIArtifactSnapshot[] = [];
          for (const active of codeActivations) {
            if (active.action !== 'code_tool_hook_live_activate' || active.deactivatedAt !== null) continue;
            const liveArtifact = await artifactStore.getArtifactById(active.artifactId);
            if (liveArtifact) liveArtifacts.push(liveArtifact);
          }
          return collectOpenClawPromotionChecks(value, {
            ownerIdentityConfigured,
            safetyControlsEnabled: isFeatureEnabled(flags, 'rulecode_safety_controls'),
            hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT,
            existingLiveArtifacts: liveArtifacts,
            validateProductionArtifact: candidate => writer.canActivate(candidate),
          });
        },
        buildEvidenceSnapshot: (checks, value, evaluationId) => {
          return buildPromotionEvidenceSnapshot({
            activationId,
            evaluationId,
            checks,
            artifact: value,
            expectedArtifactDigest: digest,
            // Bind the real authenticated actor; null (not a placeholder) when
            // the review is read without an Owner session.
            ownerIdentity: ownerActor ?? null,
            hostRuntimeVersion: 'openclaw-legacy@1',
            shadowSummary: telemetry.shadowSummary,
          });
        },
        newEvaluationId: () => `readiness-${randomUUID()}`,
      });
      let content: Record<string, unknown> | null = null;
      try { const parsed: unknown = JSON.parse(artifact.contentJson); if (isRecord(parsed)) content = parsed; } catch { /* readiness reports validation failure */ }
      let approvedBlockRate: number | null = null;
      let promotion: ActivationDecisionRecord | undefined;
      for (let index = decisions.length - 1; index >= 0; index -= 1) {
        const candidate = decisions[index];
        if (candidate?.decision === 'promote_live' && candidate.evidenceSnapshotId !== null) {
          promotion = candidate;
          break;
        }
      }
      if (promotion?.evidenceSnapshotId) {
        const row: unknown = conn.getDb().prepare('SELECT shadow_summary FROM activation_evidence_snapshots WHERE snapshot_id = ?').get(promotion.evidenceSnapshotId);
        if (isRecord(row) && typeof row.shadow_summary === 'string') {
          try {
            const summary: unknown = JSON.parse(row.shadow_summary);
            if (isRecord(summary) && typeof summary.observed === 'number' && summary.observed > 0 && typeof summary.wouldBlock === 'number') {
              approvedBlockRate = summary.wouldBlock / summary.observed;
            }
          } catch { /* malformed immutable evidence leaves drift unavailable */ }
        }
      }
      const live24 = telemetry.metrics.last24Hours;
      const liveBlockRate = live24.eligible !== null && live24.eligible > 0 && live24.blocked !== null
        ? live24.blocked / live24.eligible
        : null;
      return {
        activation,
        artifact: { artifactId: artifact.artifactId, digest, sourceTaskId: artifact.sourceTaskId, lineageArtifactIds: [...artifact.lineageArtifactIds], content },
        readiness: await reader.evaluate({ activationId, expectedArtifactId: artifact.artifactId, expectedArtifactDigest: digest }),
        controlState: await safetyStore.getControlState(activationId),
        decisions,
        globalPause: await safetyStore.getActiveGlobalPause(),
        ownerDecisionEnabled: isFeatureEnabled(flags, 'rulecode_owner_live_decision'),
        runtimeCapability: {
          hostRuntimeVersion: OPENCLAW_HOST_LIVENESS_CONTRACT.version,
          shadowEvidence: OPENCLAW_HOST_LIVENESS_CONTRACT.supportsShadowEvidence,
        },
        liveMetrics: telemetry.metrics,
        behaviorDrift: {
          approvedBlockRate,
          liveBlockRate,
          delta: approvedBlockRate === null || liveBlockRate === null ? null : liveBlockRate - approvedBlockRate,
        },
      };
    } finally { try { conn.close(); } catch { /* best effort */ } }
  }

  async continueObserving(activationId: string, input: OwnerMutationInput): Promise<{ decisionId: string }> {
    this.requireOwnerDecisionFeature();
    return this.withMutableRuleCode(activationId, async (store, activation, artifactDigest) => store.recordOwnerDecision(
      makeActivationDecision({ activation, artifactDigest, decision: 'continue_observing', input }), input.idempotencyKey,
    ));
  }

  async deactivateRuleCode(activationId: string, decision: 'reject_after_shadow' | 'emergency_deactivate', input: OwnerMutationInput): Promise<{ activationId: string; decisionId: string; deactivatedAt: string }> {
    if (decision === 'reject_after_shadow') this.requireOwnerDecisionFeature();
    return this.withMutableRuleCode(activationId, async (store, activation, artifactDigest) =>
      authorizeGovernanceAction(
        path.join(this.workspaceDir, '.pd'),
        {
          action: 'deactivate',
          activationId,
          actor: 'owner',
          reasonCode: input.reasonCode,
          outcome: 'authorized',
        },
        () => store.deactivateWithDecision(
          makeActivationDecision({ activation, artifactDigest, decision, input }), input.idempotencyKey,
        ),
        this.governanceAuditWriter,
      ));
  }

  async recoverRuleCodeToShadow(activationId: string, expectedControlVersion: number, input: OwnerMutationInput): Promise<{ sourceActivationId: string; shadowActivationId: string; decisionId: string }> {
    this.requireOwnerDecisionFeature();
    return this.withMutableRuleCode(activationId, async (store, activation, artifactDigest) => store.recoverToShadow({
      ...makeActivationDecision({ activation, artifactDigest, decision: 'continue_observing', input }),
      decision: 'recover_to_shadow',
    }, { expectedControlVersion, newActivationId: `activation-recovery-${randomUUID()}`, idempotencyKey: input.idempotencyKey }));
  }

  async pauseAllRuleCode(input: OwnerMutationInput): Promise<GlobalRuleCodePause> {
    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: false });
    try {
      const decision: ActivationDecisionRecord = {
        decisionId: `decision-${randomUUID()}`, subject: { kind: 'all_live_rulecode' }, decision: 'global_emergency_pause',
        principal: input.actor.principal, authentication: input.actor.authentication,
        ...(input.actor.operator ? { operator: input.actor.operator } : {}), reasonCode: input.reasonCode,
        note: input.note ?? null, evidenceSnapshotId: null, decidedAt: new Date().toISOString(),
      };
      return await authorizeGovernanceAction(
        path.join(this.workspaceDir, '.pd'),
        {
          action: 'global_pause',
          subject: 'all_live_rulecode',
          actor: 'owner',
          reasonCode: input.reasonCode,
          outcome: 'authorized',
        },
        () => new SqliteActivationSafetyStore(conn).pauseAllLive(decision, `pause-${randomUUID()}`, input.idempotencyKey),
        this.governanceAuditWriter,
      );
    } finally { try { conn.close(); } catch { /* best effort */ } }
  }

  async releaseRuleCodePause(pauseId: string, expectedVersion: number, input: OwnerMutationInput): Promise<GlobalRuleCodePause> {
    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: false });
    try {
      const decision: ActivationDecisionRecord = {
        decisionId: `decision-${randomUUID()}`, subject: { kind: 'all_live_rulecode' }, decision: 'global_emergency_pause_release',
        principal: input.actor.principal, authentication: input.actor.authentication,
        ...(input.actor.operator ? { operator: input.actor.operator } : {}), reasonCode: input.reasonCode,
        note: input.note ?? null, evidenceSnapshotId: null, decidedAt: new Date().toISOString(),
      };
      return await new SqliteActivationSafetyStore(conn).releaseGlobalPause(decision, { pauseId, expectedVersion, idempotencyKey: input.idempotencyKey });
    } finally { try { conn.close(); } catch { /* best effort */ } }
  }

  async promoteRuleCode(activationId: string, expected: { artifactId: string; artifactDigest: string; controlVersion: number; confirmed: boolean }, input: OwnerMutationInput): Promise<OwnerPromotionResult> {
    const review = await this.getOwnerReview(activationId, input.actor.principal.kind === 'configured_owner' && input.actor.authentication.method === 'console_token', input.actor);
    const flags = computeFlagsFromLoadResult(loadPdConfig(this.workspaceDir));
    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: false });
    try {
      const store = new SqliteActivationSafetyStore(conn);
      const service = new RuleCodeOwnerDecisionService({
        ownerLiveDecisionEnabled: () => isFeatureEnabled(flags, 'rulecode_owner_live_decision'),
        safetyControlsEnabled: () => isFeatureEnabled(flags, 'rulecode_safety_controls'),
        evaluateReadiness: async () => review.readiness,
        commitPromotion: value => authorizeGovernanceAction(
          path.join(this.workspaceDir, '.pd'),
          {
            action: 'promote',
            activationId,
            actor: 'owner',
            reasonCode: input.reasonCode,
            outcome: 'authorized',
          },
          () => store.commitPromotion(value),
          this.governanceAuditWriter,
        ),
        newDecisionId: () => `decision-${randomUUID()}`,
        now: () => new Date().toISOString(),
      });
      const result = await service.promote({
        activationId, expectedArtifactId: expected.artifactId, expectedArtifactDigest: expected.artifactDigest,
        expectedControlVersion: expected.controlVersion, idempotencyKey: input.idempotencyKey,
        reasonCode: input.reasonCode, note: input.note, confirmed: expected.confirmed,
      }, input.actor);

      return result;
    } finally { try { conn.close(); } catch { /* best effort */ } }
  }

  private async withMutableRuleCode<T>(activationId: string, action: (store: SqliteActivationSafetyStore, activation: ActivationStatusRecord, artifactDigest: string) => Promise<T>): Promise<T> {
    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: false });
    try {
      const activationStore = new SqliteActivationStateStore(conn);
      const artifactStore = new SqlitePIArtifactStore(conn);
      const matches = (await activationStore.listCodeToolHookActivations(true)).filter(value => value.activationId === activationId);
      if (matches.length !== 1) throw new Error(`RuleCode mutation requires exactly one activation: ${activationId}`);
      const [activation] = matches;
      if (!activation) throw new Error(`Activation not found: ${activationId}`);
      const artifact = await artifactStore.getArtifactById(activation.artifactId);
      if (!artifact) throw new Error(`Artifact not found for activation: ${activation.artifactId}`);
      const artifactDigest = `sha256:${createHash('sha256').update(JSON.stringify(artifact), 'utf8').digest('hex')}`;
      return await action(new SqliteActivationSafetyStore(conn), activation, artifactDigest);
    } finally { try { conn.close(); } catch { /* best effort */ } }
  }

  private requireOwnerDecisionFeature(): void {
    const flags = computeFlagsFromLoadResult(loadPdConfig(this.workspaceDir));
    if (!isFeatureEnabled(flags, 'rulecode_owner_live_decision')) throw new Error('feature_not_enabled: enable rulecode_owner_live_decision only after the rollout gate passes');
  }

  async deactivateActivation(activationId: string): Promise<{ ok: true } | { ok: false; reason: string; nextAction: string }> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return { ok: false, reason: 'state.db not found — workspace may not be initialized', nextAction: 'Ensure the workspace has been initialized with PD before disabling activations.' };
    }

    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: false });
    try {
      const activationStore = new SqliteActivationStateStore(conn);

      try {
        const deactivated = await authorizeGovernanceAction(
          path.join(this.workspaceDir, '.pd'),
          {
            action: 'deactivate',
            activationId,
            actor: 'session',
            reasonCode: 'console_disable_confirmed',
            outcome: 'authorized',
          },
          () => activationStore.deactivateActivation(activationId, new Date().toISOString()),
          this.governanceAuditWriter,
        );
        if (!deactivated) {
          return { ok: false, reason: `Activation '${activationId}' not found or already inactive`, nextAction: 'Refresh the activation list and verify the activation ID is correct.' };
        }

        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `Failed to deactivate activation: ${message}`, nextAction: 'Check server logs for details. The activation state has not been changed.' };
      }
    } finally {
      try { conn.close(); } catch { /* best-effort */ }
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- lifecycle interface; connections are request-scoped
  dispose(): void {
    // Connections are opened and closed per-request; no persistent state.
  }
}
