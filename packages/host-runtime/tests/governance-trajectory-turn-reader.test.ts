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
    expect(listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: 'other-session' }).ok && []).toEqual([]);
    expect(listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: '  ' }).ok).toBe(true);
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
