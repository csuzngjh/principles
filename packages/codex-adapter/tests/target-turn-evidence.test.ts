/**
 * PRI-1273 (A2) — `readCodexTargetTurnEvidence`: the consent-gated EXACT-turn
 * read the worker's waiting-task reconcile consumes.
 *
 * The store is seeded through the REAL `ingestGovernanceObservations`
 * transaction (the same write path live/catch-up ingestion uses), and the
 * consent ledger is the REAL `.state/conversation-ingestion-consent.json`
 * the formal judgment reads — no mocks on either side.
 *
 * Locked behaviors:
 *  - consent missing / revoked / not granted ⇒ `blocked_by_consent` with the
 *    specific reason, BEFORE any store query (a denial is never not_found);
 *  - granted ⇒ the EXACT (rollout identity, host turn id) rows come back as
 *    entries in the submit-path enrichment shape; another session's rows,
 *    another host's same-key rows and non-retained rows never qualify;
 *  - a store failure ⇒ `read_failed` (observable, not a silent false).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestGovernanceObservations } from '@principles/host-runtime';
import { writeCodexConsent, writeGrantedCodexConsent } from './helpers/consent.js';
import { readCodexTargetTurnEvidence } from '../src/ingestion/pain-receipt-fallback.js';

const SESSION = 'rollout-1273-read';
const TARGET_TURN = 'turn-1273-10';

const dirs: string[] = [];
function workspace(granted: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-target-read-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  // The trajectory store treats a 0-byte file as a fresh database and creates
  // its schema on first ingest — the same bootstrap the catch-up suite uses.
  fs.writeFileSync(path.join(root, '.state', 'trajectory.db'), '');
  if (granted) writeGrantedCodexConsent(root);
  return root;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function observation(overrides: Partial<Parameters<typeof ingestGovernanceObservations>[0]['observations'][number]> = {}) {
  return {
    hostKind: 'codex' as const,
    rolloutIdentity: SESSION,
    rootSessionId: SESSION,
    hostTurnId: TARGET_TURN,
    kind: 'user_turn' as const,
    logicalObservationKey: `codex|${SESSION}|${TARGET_TURN}|user_turn`,
    // CodeRabbit: a FIXED timestamp would expire past the 7-day retention
    // bound once the wall clock moves on (the PRI-1271 time-bomb class) —
    // default to now; the expiry test overrides observedAt explicitly.
    visibleText: 'the target turn body: the verification step was skipped',
    source: 'transcript' as const,
    completeness: 'complete' as const,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

function seed(ws: string, observations: readonly unknown[]): void {
  const result = ingestGovernanceObservations({
    workspaceDir: ws,
    observations: observations as never,
  });
  if (!result.ok) throw new Error(`seed failed: ${JSON.stringify(result)}`);
}

describe('readCodexTargetTurnEvidence — consent gate first (PRI-1283 R2 parity)', () => {
  it('consent_missing (no ledger record) blocks BEFORE any store read', () => {
    const ws = workspace(false);
    const read = readCodexTargetTurnEvidence(ws, SESSION, TARGET_TURN);
    expect(read).toEqual({ status: 'blocked_by_consent', reason: 'consent_missing' });
  });

  it('consent_revoked blocks with its own reason even while the text exists in the store', () => {
    const ws = workspace(true);
    seed(ws, [observation()]);
    writeCodexConsent(ws, 'revoked');
    const read = readCodexTargetTurnEvidence(ws, SESSION, TARGET_TURN);
    expect(read).toEqual({ status: 'blocked_by_consent', reason: 'consent_revoked' });
  });

  it("consent_not_granted (pending decision) blocks with its own reason", () => {
    const ws = workspace(false);
    writeCodexConsent(ws, 'pending');
    const read = readCodexTargetTurnEvidence(ws, SESSION, TARGET_TURN);
    expect(read).toEqual({ status: 'blocked_by_consent', reason: 'consent_not_granted' });
  });
});

describe('readCodexTargetTurnEvidence — the EXACT turn only', () => {
  it('granted + the exact (session, turn) rows → available entries in the submit-path shape', () => {
    const ws = workspace(true);
    seed(ws, [
      observation({ kind: 'user_turn', logicalObservationKey: `codex|${SESSION}|${TARGET_TURN}|user_turn`, visibleText: 'user body of turn 10' }),
      observation({ kind: 'assistant_turn', logicalObservationKey: `codex|${SESSION}|${TARGET_TURN}|assistant_turn`, visibleText: 'assistant body of turn 10' }),
    ]);
    const read = readCodexTargetTurnEvidence(ws, SESSION, TARGET_TURN);
    expect(read).toEqual({
      status: 'available',
      entries: [
        { sourceRef: `governance_observation:codex|${SESSION}|${TARGET_TURN}|user_turn`, note: 'user body of turn 10' },
        { sourceRef: `governance_observation:codex|${SESSION}|${TARGET_TURN}|assistant_turn`, note: 'assistant body of turn 10' },
      ],
    });
  });

  it('devin BUG_0002: a long turn whose final answer sits behind 70 tool/reasoning rows is still fully backfilled', () => {
    const ws = workspace(true);
    const rows = [observation({ kind: 'user_turn', logicalObservationKey: `codex|${SESSION}|${TARGET_TURN}|user`, visibleText: 'long turn user instruction' })];
    for (let i = 0; i < 70; i += 1) {
      rows.push(observation({
        kind: i % 2 === 0 ? 'tool_call' : 'reasoning',
        logicalObservationKey: `codex|${SESSION}|${TARGET_TURN}|noise-${i}`,
        visibleText: undefined,
        toolFacts: { i },
      }));
    }
    rows.push(observation({ kind: 'assistant_turn', logicalObservationKey: `codex|${SESSION}|${TARGET_TURN}|final`, visibleText: 'long turn FINAL ANSWER' }));
    seed(ws, rows);
    const read = readCodexTargetTurnEvidence(ws, SESSION, TARGET_TURN);
    expect(read.status).toBe('available');
    if (read.status !== 'available') return;
    expect(read.entries.map((entry) => entry.note)).toEqual(['long turn user instruction', 'long turn FINAL ANSWER']);
  });

  it('the same text under ANOTHER session never satisfies this session\'s target (同文异会话)', () => {
    const ws = workspace(true);
    seed(ws, [observation({ rolloutIdentity: 'rollout-other-session', rootSessionId: 'rollout-other-session' })]);
    expect(readCodexTargetTurnEvidence(ws, SESSION, TARGET_TURN)).toEqual({ status: 'not_found' });
  });

  it('another HOST carrying the same rollout identity + turn id never satisfies the codex reader (异宿主同键)', () => {
    const ws = workspace(true);
    seed(ws, [observation({ hostKind: 'workbuddy', logicalObservationKey: `codex|${SESSION}|${TARGET_TURN}|user_turn` })]);
    expect(readCodexTargetTurnEvidence(ws, SESSION, TARGET_TURN)).toEqual({ status: 'not_found' });
  });

  it('rows the retention policy expired are not readable text (来源过期)', () => {
    const ws = workspace(true);
    // The store's own ingest transaction expires rows older than the 7-day
    // retention bound (visible_text nulled, retention_class=expired) — the
    // same real path a late catch-up of long-stale material takes.
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    seed(ws, [observation({ observedAt: stale })]);
    expect(readCodexTargetTurnEvidence(ws, SESSION, TARGET_TURN)).toEqual({ status: 'not_found' });
  });

  it('a turn id that was never ingested is an honest not_found (正文晚到之前)', () => {
    const ws = workspace(true);
    seed(ws, [observation({ hostTurnId: 'turn-1273-09', logicalObservationKey: `codex|${SESSION}|turn-1273-09|user_turn` })]);
    expect(readCodexTargetTurnEvidence(ws, SESSION, TARGET_TURN)).toEqual({ status: 'not_found' });
  });

  it('a workspace with no trajectory database at all degrades to read_failed, never throws', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-target-bare-'));
    dirs.push(ws);
    writeGrantedCodexConsent(ws);
    const read = readCodexTargetTurnEvidence(ws, SESSION, TARGET_TURN);
    expect(read.status).toBe('read_failed');
  });
});
