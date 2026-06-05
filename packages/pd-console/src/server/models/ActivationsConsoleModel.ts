import {
  SqliteConnection,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
} from '@principles/core/runtime-v2';
import type { ActivationStatusRecord, PIArtifactRecord } from '@principles/core/runtime-v2';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ActivationFact {
  activationId: string;
  artifactId: string;
  channel: string;
  action: string;
  targetRef: string;
  activatedAt: string;
  sourcePrincipleId: string | null;
}

export interface ActivationsResponse {
  activations: ActivationFact[];
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

    const facts: ActivationFact[] = allActivations.map((record) => ({
      activationId: record.activationId,
      artifactId: record.artifactId,
      channel: record.channel,
      action: record.action,
      targetRef: record.targetRef,
      activatedAt: record.activatedAt,
      sourcePrincipleId: artifactPrincipleMap.get(record.artifactId) ?? null,
    }));

    return {
      activations: facts,
      generatedAt: new Date().toISOString(),
    };
  }

  dispose(): void {
    if (this.readConnection) {
      try { this.readConnection.close(); } catch { /* best-effort */ }
      this.readConnection = null;
    }
  }
}
