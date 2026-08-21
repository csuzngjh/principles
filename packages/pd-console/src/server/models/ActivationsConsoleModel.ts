import {
  SqliteConnection,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
  extractPrincipleId,
  extractEvidenceRefs,
} from '@principles/core/runtime-v2';
import type { ActivationStatusRecord, PIArtifactRecord, PIArtifactSnapshot } from '@principles/core/runtime-v2';
import { loadPdConfig, computeFlagsFromLoadResult } from '../config/pd-config-store.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

export class ActivationsConsoleModel {
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
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

  async deactivateActivation(activationId: string): Promise<{ ok: true } | { ok: false; reason: string; nextAction: string }> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return { ok: false, reason: 'state.db not found — workspace may not be initialized', nextAction: 'Ensure the workspace has been initialized with PD before disabling activations.' };
    }

    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: false });
    try {
      const activationStore = new SqliteActivationStateStore(conn);

      try {
        const deactivated = await activationStore.deactivateActivation(activationId, new Date().toISOString());
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
