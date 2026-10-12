import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getDefaultPdConfig, SqliteActivationStateStore, SqliteConnection } from '@principles/core/runtime-v2';
import { getWorkbuddyWorkspaceDir } from '@principles/install-layout';

/**
 * Shared workbench builders for the entry/production suites: a FAKE home (so
 * the entry's os.homedir()-based OD-07 resolution lands in a temp dir), a
 * real governance workspace config, real production activation artifacts
 * (through SqliteActivationStateStore — the production store writer, never
 * direct evidence-table hacks), and the trajectory schema the shared pain
 * path expects.
 */
const EVENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'host-contract', 'events');

const tempDirs: string[] = [];
export function trackTempDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export function makeHome(): string {
  return trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-workbuddy-home-')));
}

export function makeProjectDir(home: string, name: string): string {
  return trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), `pd-workbuddy-proj-${name}-`)));
}

export interface GovernanceOptions {
  workbuddyFlag?: boolean;
  receiptLedgerFlag?: boolean;
  ruleContextV2Flag?: boolean;
  /** Write INVALID config yaml (degraded-config tests). */
  malformed?: boolean;
}

export function makeGovernance(home: string, options: GovernanceOptions = {}): string {
  const governance = getWorkbuddyWorkspaceDir(home);
  fs.mkdirSync(path.join(governance, '.pd'), { recursive: true });
  if (options.malformed) {
    fs.writeFileSync(path.join(governance, '.pd', 'config.yaml'), '{ this is: not: valid yaml ][');
    return governance;
  }
  const config = getDefaultPdConfig();
  if (config.features['host.workbuddy']) config.features['host.workbuddy'].enabled = options.workbuddyFlag ?? false;
  if (config.features['principle_receipt_ledger']) config.features['principle_receipt_ledger'].enabled = options.receiptLedgerFlag ?? false;
  if (options.ruleContextV2Flag !== undefined && config.features['rulecode_context_v2']) config.features['rulecode_context_v2'].enabled = options.ruleContextV2Flag;
  fs.writeFileSync(path.join(governance, '.pd', 'config.yaml'), JSON.stringify(config));
  return governance;
}

/** Load a REAL frozen fixture payload with the cwd (and transcript) pointed at temp reality. */
export function fixturePayload(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const fixture = JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, name), 'utf8')) as { payload?: unknown };
  if (typeof fixture.payload !== 'object' || fixture.payload === null) throw new Error(`fixture ${name} carries no payload`);
  return { ...(fixture.payload as Record<string, unknown>), ...overrides };
}

export interface ArtifactInput {
  id: string;
  kind: 'principle' | 'rule';
  principleId: string;
  ruleId?: string;
  content: object;
  channel: 'prompt' | 'code_tool_hook';
  action: 'prompt_activate' | 'code_tool_hook_live_activate' | 'code_tool_hook_shadow_activate';
  target: string;
}

/** Production store path: pi_artifacts row + SqliteActivationStateStore.recordActivation. */
export async function activationArtifact(governance: string, input: ArtifactInput): Promise<void> {
  const connection = new SqliteConnection(governance);
  try {
    const now = new Date().toISOString();
    connection.getDb().prepare(
      `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.kind, `task-${input.id}`, input.principleId, input.ruleId ?? null, '[]', 'validated', JSON.stringify(input.content), now, now);
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: `act-${input.id}`,
      idempotencyKey: `${input.id}::${input.channel}`,
      artifactId: input.id,
      channel: input.channel,
      action: input.action,
      targetRef: input.target,
      activatedAt: now,
      deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

/** Create the canonical trajectory schema the shared pain evidence path writes into. */
export function makeTrajectory(governance: string): void {
  fs.mkdirSync(path.join(governance, '.state'), { recursive: true });
  const db = new Database(path.join(governance, '.state', 'trajectory.db'));
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
    CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
  `);
  db.close();
}
