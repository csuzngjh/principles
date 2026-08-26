/**
 * PRI-537 — runtime_v2_prompt_activations_injected index-pairing contract.
 *
 * Under budget truncation only a PREFIX of the candidate principles is
 * injected. The observability event must pair principleIds / activationIds /
 * artifactIds index-for-index over that INJECTED subset — emitting the full
 * candidate lists alongside the injected principleIds mispairs every index
 * past the cut (rc-6-adjacent). Live evidence: 802/1341 events (60%) carried
 * mismatched array lengths between 2026-08-21 and 08-26.
 *
 * Drives the REAL handleBeforePromptBuild against a real seeded activation
 * DB (no mocks on the injection-read or event-write paths) — EP-02: the
 * production entry point is exercised, not a reimplementation.
 *
 * Negative control: against the pre-fix emission (raw dedupedV2.map), the
 * array-length assertions fail because activationIds/artifactIds carry all
 * candidates while principleIds carries only the injected prefix.
 *
 * ERR checklist:
 * - ERR-088 (EP-09): v2Truncated===true proves truncation actually engaged,
   so the pairing assertions cannot pass vacuously on an untruncated build;
   per-index equality uses seeded id construction, not just lengths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore, RUNTIME_V2_PRINCIPLE_BUDGET } from '@principles/core/runtime-v2';
import { handleBeforePromptBuild } from '../../src/hooks/prompt.js';
import { EventLogService } from '../../src/core/event-log.js';

const SESSION_ID = 'sess-pair-pri537';
const SEED_COUNT = 5;
// Long enough that only ~2 of 5 entries fit the 2000-char budget.
const PRINCIPLE_TEXT = 'P'.repeat(900);

let tempWorkspaceDir: string;
let sqliteConn: SqliteConnection;

const seededIds = Array.from({ length: SEED_COUNT }, (_, i) => `princ-pair-${i}`);
const seededActivationById = new Map(seededIds.map((id) => [id, `act_prompt_${id}`]));
const seededArtifactById = new Map(seededIds.map((id) => [id, `art_${id}`]));

beforeEach(() => {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri537-pairing-'));
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

function insertValidatedPrincipleArtifact(principleId: string, artifactId: string, text: string): void {
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactId,
    'principle',
    `task_${principleId}`,
    principleId,
    null,
    '[]',
    'validated',
    JSON.stringify({ principleId, text }),
    now,
    now,
  );
}

async function insertPromptActivation(principleId: string, artifactId: string, activatedAt: string): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  await store.recordActivation({
    activationId: `act_prompt_${principleId}`,
    idempotencyKey: `${artifactId}::prompt`,
    artifactId,
    channel: 'prompt',
    action: 'prompt_activate',
    targetRef: `ledger://${principleId}`,
    activatedAt,
    deactivatedAt: null,
  });
}

function readInjectionEvents(): Array<{ type: string; data: Record<string, unknown> }> {
  const logsDir = path.join(tempWorkspaceDir, '.state', 'logs');
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  if (!fs.existsSync(logsDir)) return events;
  for (const f of fs.readdirSync(logsDir)) {
    if (!f.startsWith('events_')) continue;
    for (const line of fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string; data?: Record<string, unknown> };
        if (parsed.type === 'runtime_v2_prompt_activations_injected') {
          events.push(parsed as { type: string; data: Record<string, unknown> });
        }
      } catch {
        // ignore malformed tail lines
      }
    }
  }
  return events;
}

describe('PRI-537: activations-injected event pairs source arrays with the injected subset', () => {
  it('budget-truncated build emits index-aligned principleIds/activationIds/artifactIds', async () => {
    // Seed in activated_at ASC order — listPromptActivations returns them in
    // this order, so trimToBudget injects the first K seeds verbatim.
    for (let i = 0; i < SEED_COUNT; i++) {
      const id = seededIds[i]!;
      insertValidatedPrincipleArtifact(id, seededArtifactById.get(id)!, `${PRINCIPLE_TEXT}_${i}`);
      await insertPromptActivation(id, seededArtifactById.get(id)!, new Date(Date.UTC(2026, 7, 26, 0, 0, i)).toISOString());
    }

    const event = {
      prompt: 'hello',
      messages: [],
      trigger: 'user',
      sessionId: SESSION_ID,
    };
    const ctx = { workspaceDir: tempWorkspaceDir, sessionId: SESSION_ID };

    await handleBeforePromptBuild(
      event as unknown as Parameters<typeof handleBeforePromptBuild>[0],
      ctx as unknown as Parameters<typeof handleBeforePromptBuild>[1],
    );

    EventLogService.get(path.join(tempWorkspaceDir, '.state')).flush();
    const injectionEvents = readInjectionEvents().filter((e) => e.data['sessionId'] === SESSION_ID);
    expect(injectionEvents).toHaveLength(1);
    const d = injectionEvents[0]!.data;

    // Truncation must have engaged — otherwise this test proves nothing
    // about the pairing contract (ERR-088 vacuous-pass guard).
    expect(d['v2Truncated']).toBe(true);

    const principleIds = d['principleIds'] as string[];
    const activationIds = d['activationIds'] as string[];
    const artifactIds = d['artifactIds'] as string[];
    const injectedCount = d['injectedCount'] as number;

    expect(injectedCount).toBeGreaterThanOrEqual(1);
    expect(injectedCount).toBeLessThan(SEED_COUNT);
    expect(principleIds).toHaveLength(injectedCount);
    expect(activationIds).toHaveLength(injectedCount);
    expect(artifactIds).toHaveLength(injectedCount);

    // Injected set = the FIRST K seeds (trimToBudget walks in list order).
    const expectedPrincipleIds = seededIds.slice(0, injectedCount);
    expect(principleIds).toEqual(expectedPrincipleIds);
    for (let i = 0; i < injectedCount; i++) {
      const pid = principleIds[i]!;
      expect(activationIds[i]).toBe(seededActivationById.get(pid));
      expect(artifactIds[i]).toBe(seededArtifactById.get(pid));
    }

    // Sanity: the budget actually bound (rendered content under budget).
    expect(d['injectedCharCount'] as number).toBeLessThanOrEqual(RUNTIME_V2_PRINCIPLE_BUDGET);
  });
});
