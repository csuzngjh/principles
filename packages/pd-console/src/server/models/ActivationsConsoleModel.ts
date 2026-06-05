import {
  SqliteConnection,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
} from '@principles/core/runtime-v2';
import type { ActivationStatusRecord, PIArtifactRecord } from '@principles/core/runtime-v2';
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

export class ActivationsConsoleModel {
  private readConnection: SqliteConnection | null = null;
  private writeConnection: SqliteConnection | null = null;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  private getReadConnection(): SqliteConnection {
    if (!this.readConnection) {
      this.readConnection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    }
    return this.readConnection;
  }

  private getWriteConnection(): SqliteConnection {
    if (!this.writeConnection) {
      this.writeConnection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: false });
    }
    return this.writeConnection;
  }

  async getActivations(): Promise<ActivationsResponse> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return { activations: [], generatedAt: new Date().toISOString(), note: 'state.db not found — workspace may not be initialized' };
    }

    const conn = this.getReadConnection();
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

    // Build artifactId → sourcePrincipleId map from PIArtifactSnapshot
    const artifactPrincipleMap = new Map<string, string | null>();
    for (const activation of allActivations) {
      if (!artifactPrincipleMap.has(activation.artifactId)) {
        try {
          const artifact: PIArtifactRecord | null = await artifactStore.getArtifactById(activation.artifactId);
          artifactPrincipleMap.set(activation.artifactId, artifact?.sourcePrincipleId ?? null);
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
  }

  async deactivateActivation(activationId: string): Promise<{ ok: true } | { ok: false; reason: string; nextAction: string }> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return { ok: false, reason: 'state.db not found — workspace may not be initialized', nextAction: 'Ensure the workspace has been initialized with PD before disabling activations.' };
    }

    const conn = this.getWriteConnection();
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
  }

  dispose(): void {
    for (const conn of [this.readConnection, this.writeConnection]) {
      if (conn) {
        try { conn.close(); } catch (err) { console.warn('ActivationsConsoleModel.dispose: failed to close connection:', err instanceof Error ? err.message : String(err)); }
      }
    }
    this.readConnection = null;
    this.writeConnection = null;
  }
}
