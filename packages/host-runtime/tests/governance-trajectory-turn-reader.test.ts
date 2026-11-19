/**
 * PRI-1265: the governance-observation-backed TrajectoryTurnReader.
 *
 * The reader is what `pd diagnose run`, `pd pain retry`, the Codex/WorkBuddy
 * workers and the host-runtime auto-run inject so a bound session's ORIGINAL
 * turns reach the diagnosis context window. These tests pin the read contract
 * at the store boundary: session matching by EITHER spelling, retention-aware
 * (expired rows are invisible), oldest-first ordering, empty-session safety.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  ingestGovernanceObservations,
  listGovernanceTurnTexts,
  type GovernanceObservationInput,
} from '../src/governance-observation-store.js';
import { createGovernanceTrajectoryTurnReader } from '../src/governance-trajectory-turn-reader.js';

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-turn-reader-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), '');
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

const NOW = new Date('2026-11-17T12:00:00.000Z');
const ROLLOUT = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const ROOT_SESSION = 'thread-root-1';

function seedTurn(overrides: Partial<GovernanceObservationInput> & { logicalObservationKey: string }): GovernanceObservationInput {
  const input: GovernanceObservationInput = {
    hostKind: 'codex',
    rolloutIdentity: ROLLOUT,
    rootSessionId: ROOT_SESSION,
    hostTurnId: 't1',
    kind: 'user_turn',
    source: 'transcript',
    completeness: 'complete',
    observedAt: NOW.toISOString(),
    ...overrides,
  };
  const result = ingestGovernanceObservations({ workspaceDir, observations: [input], now: NOW });
  if (!result.ok) throw new Error(`seed failed: ${result.reason}`);
  return input;
}

describe('listGovernanceTurnTexts (PRI-1265 store boundary)', () => {
  it('matches the session by root_session_id AND by rollout_identity — either spelling', () => {
    seedTurn({ logicalObservationKey: 'k1', kind: 'user_turn', visibleText: 'original owner words' });
    const byRoot = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: ROOT_SESSION });
    expect(byRoot.ok).toBe(true);
    if (!byRoot.ok) return;
    expect(byRoot.turns.map((t) => t.visibleText)).toEqual(['original owner words']);
    const byRollout = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: ROLLOUT });
    expect(byRollout.ok && byRollout.turns).toHaveLength(1);
  });

  it('returns turns oldest-first and separates user from assistant rows', () => {
    seedTurn({ logicalObservationKey: 'k1', kind: 'user_turn', visibleText: 'first', observedAt: '2026-11-17T10:00:00.000Z' });
    seedTurn({ logicalObservationKey: 'k2', kind: 'user_turn', visibleText: 'second', observedAt: '2026-11-17T11:00:00.000Z' });
    seedTurn({ logicalObservationKey: 'k3', kind: 'assistant_turn', visibleText: 'reply' });
    const users = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: ROLLOUT });
    expect(users.ok && users.turns.map((t) => t.visibleText)).toEqual(['first', 'second']);
    const assistants = listGovernanceTurnTexts({ workspaceDir, kind: 'assistant_turn', sessionId: ROLLOUT });
    expect(assistants.ok && assistants.turns.map((t) => t.visibleText)).toEqual(['reply']);
  });

  it('never returns rows whose text was not retained (expired / quarantined are invisible)', () => {
    seedTurn({ logicalObservationKey: 'k1', kind: 'user_turn' }); // no visibleText
    seedTurn({ logicalObservationKey: 'k2', kind: 'user_turn', visibleText: 'kept words' });
    const result = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: ROLLOUT });
    expect(result.ok && result.turns.map((t) => t.visibleText)).toEqual(['kept words']);
  });

  it('an unknown session yields an empty list, an empty session is safe', () => {
    seedTurn({ logicalObservationKey: 'k1', kind: 'user_turn', visibleText: 'words' });
    const unknown = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: 'other-session' });
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.turns).toEqual([]);
    expect(listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: '  ' }).ok).toBe(true);
  });

  it('review: expired rows never serve text even when a replay refilled the body (retention_class filter)', () => {
    seedTurn({ logicalObservationKey: 'k1', kind: 'user_turn', visibleText: 'was operational' });
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    // Simulate the legacy artifact the review flagged: retention expired the
    // row but a later replay refilled visible_text (pre-guard store).
    db.prepare("UPDATE governance_observations SET retention_class = 'expired', visible_text = 'refilled after expiry' WHERE logical_key = 'k1'").run();
    db.close();
    const result = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: ROLLOUT });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.turns).toEqual([]);
  });

  it('review: replay enrichment does not refill an expired row body (write-side guard)', () => {
    seedTurn({ logicalObservationKey: 'k1', kind: 'user_turn', visibleText: 'original text' });
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    db.prepare("UPDATE governance_observations SET retention_class = 'expired', visible_text = NULL WHERE logical_key = 'k1'").run();
    db.close();
    // The same logical key arrives again (checkpoint replay / catch-up).
    seedTurn({ logicalObservationKey: 'k1', kind: 'user_turn', visibleText: 'original text' });
    const after = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    const row = after.prepare("SELECT visible_text, retention_class FROM governance_observations WHERE logical_key = 'k1'").get();
    after.close();
    expect(row?.retention_class).toBe('expired');
    expect(row?.visible_text ?? null).toBeNull();
    const result = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: ROLLOUT });
    expect(result.ok && result.turns).toEqual([]);
  });

  it('review: a subagent rollout (root_session_id = parent thread) is never mixed into the parent conversation', () => {
    // Parent P: its own rollout rows.
    seedTurn({ logicalObservationKey: 'p1', kind: 'user_turn', visibleText: 'parent own turn', rolloutIdentity: ROLLOUT, rootSessionId: ROOT_SESSION });
    // Subagent C: DIFFERENT rollout identity, root_session_id points at the parent.
    seedTurn({ logicalObservationKey: 'c1', kind: 'user_turn', visibleText: 'SUBAGENT PROMPT LEAK', rolloutIdentity: 'subagent-rollout-c', rootSessionId: ROOT_SESSION });
    const parent = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: ROLLOUT });
    expect(parent.ok).toBe(true);
    if (parent.ok) expect(parent.turns.map((t) => t.visibleText)).toEqual(['parent own turn']);
    // The subagent session itself stays readable by its own rollout identity.
    const child = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: 'subagent-rollout-c' });
    expect(child.ok && child.turns.map((t) => t.visibleText)).toEqual(['SUBAGENT PROMPT LEAK']);
  });

  it('review: root_session_id fallback still resolves sessions with no exact rollout rows', () => {
    seedTurn({ logicalObservationKey: 'h1', kind: 'user_turn', visibleText: 'historical alias turn', rolloutIdentity: 'other-rollout', rootSessionId: ROOT_SESSION });
    const byRoot = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: ROOT_SESSION });
    expect(byRoot.ok).toBe(true);
    if (byRoot.ok) expect(byRoot.turns.map((t) => t.visibleText)).toEqual(['historical alias turn']);
  });

  it('review: hostKind restricts matches to one host (session ids are unique per host, not globally)', () => {
    seedTurn({ logicalObservationKey: 'cx1', kind: 'user_turn', visibleText: 'codex turn', hostKind: 'codex' });
    seedTurn({ logicalObservationKey: 'wb1', kind: 'user_turn', visibleText: 'workbuddy turn', hostKind: 'workbuddy' });
    const codexOnly = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: ROLLOUT, hostKind: 'codex' });
    expect(codexOnly.ok).toBe(true);
    if (codexOnly.ok) expect(codexOnly.turns.map((t) => t.visibleText)).toEqual(['codex turn']);
    const workbuddyOnly = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: ROLLOUT, hostKind: 'workbuddy' });
    expect(workbuddyOnly.ok).toBe(true);
    if (workbuddyOnly.ok) expect(workbuddyOnly.turns.map((t) => t.visibleText)).toEqual(['workbuddy turn']);
  });

  it('review: the NEWEST `limit` turns are returned when a session has more retained turns', () => {
    for (let index = 0; index < 6; index += 1) {
      seedTurn({
        logicalObservationKey: `k${index}`,
        kind: 'user_turn',
        visibleText: `turn-${index}`,
        observedAt: new Date(Date.parse(NOW.toISOString()) + index * 1000).toISOString(),
      });
    }
    const newestThree = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: ROLLOUT, limit: 3 });
    expect(newestThree.ok).toBe(true);
    // Ascending order preserved, but the window is the NEWEST three, not the oldest.
    if (newestThree.ok) expect(newestThree.turns.map((t) => t.visibleText)).toEqual(['turn-3', 'turn-4', 'turn-5']);
  });
});

describe('createGovernanceTrajectoryTurnReader (PRI-1265 adapter shape)', () => {
  it('maps the store rows onto the TrajectoryTurnReader contract', () => {
    seedTurn({ logicalObservationKey: 'k1', kind: 'user_turn', visibleText: 'owner turn', observedAt: '2026-11-17T10:00:00.000Z' });
    seedTurn({ logicalObservationKey: 'k2', kind: 'assistant_turn', visibleText: 'assistant turn' });
    const reader = createGovernanceTrajectoryTurnReader({ workspaceDir });
    const userTurns = reader.listUserTurnsForSession(ROLLOUT);
    expect(userTurns).toHaveLength(1);
    const [userTurn] = userTurns;
    expect(userTurn?.rawExcerpt).toBe('owner turn');
    expect(userTurn?.createdAt).toBe('2026-11-17T10:00:00.000Z');
    expect(userTurn?.correctionDetected).toBe(false);
    const assistantTurns = reader.listAssistantTurns(ROLLOUT);
    expect(assistantTurns[0]?.sanitizedText).toBe('assistant turn');
  });
});
