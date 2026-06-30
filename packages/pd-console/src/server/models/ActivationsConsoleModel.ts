import {
  SqliteConnection,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
  extractPrincipleId,
} from '@principles/core/runtime-v2';
import type { ActivationStatusRecord, PIArtifactRecord, PIArtifactSnapshot } from '@principles/core/runtime-v2';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ActivationRecord {
  id: string;
  artifactId: string;
  principleId: string;
  channel: string;
  action: string;
  targetRef: string;
  activatedAt: string | null;
  status: 'active' | 'inactive';
}

export interface ActivationsResponse {
  activations: ActivationRecord[];
  generatedAt: string;
  /** Present when data is degraded/missing rather than genuinely empty */
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

export class ActivationsConsoleModel {
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getActivations(): Promise<ActivationsResponse> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return { activations: [], generatedAt: new Date().toISOString(), note: 'state.db not found — workspace may not be initialized' };
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
          return { activations: [], generatedAt: new Date().toISOString(), note: 'activation table not found — workspace may not be initialized' };
        }
        throw err;
      }

      // Build artifactId → principleId map. Bug-O L2 fix: use extractPrincipleId
      // (4-step fallback: column → parsed.principleId → parsed.sourcePrincipleId
      // → parsed.principleDraft.title) instead of only reading the column.
      // Without this, dreamer artifacts whose sourcePrincipleId was stripped
      // (non-core-principle case) would show 'unlinked' even when contentJson
      // carries a resolvable principleId.
      const artifactPrincipleMap = new Map<string, string | null>();
      for (const activation of allActivations) {
        if (!artifactPrincipleMap.has(activation.artifactId)) {
          try {
            const artifact: PIArtifactRecord | null = await artifactStore.getArtifactById(activation.artifactId);
            const principleId = artifact ? extractPrincipleId(toSnapshot(artifact)) : null;
            artifactPrincipleMap.set(activation.artifactId, principleId);
          } catch (err) {
            if (isMissingTableError(err)) {
              artifactPrincipleMap.set(activation.artifactId, null);
            } else {
              throw err;
            }
          }
        }
      }

      const facts: ActivationRecord[] = allActivations.map((record) => ({
        id: record.activationId,
        artifactId: record.artifactId,
        principleId: artifactPrincipleMap.get(record.artifactId) ?? 'unlinked',
        channel: record.channel,
        action: record.action,
        targetRef: record.targetRef,
        activatedAt: record.activatedAt,
        status: record.deactivatedAt === null ? 'active' as const : 'inactive' as const,
      }));

      return {
        activations: facts,
        generatedAt: new Date().toISOString(),
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
