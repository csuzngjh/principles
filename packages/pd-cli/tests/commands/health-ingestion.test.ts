/**
 * PRI-1171 ticket ⑦: unified three-host ingestion health section contract.
 *
 * Drives `assessIngestionHealth` against a REAL temp workspace store seeded
 * through the production ingest path (same authority the hooks write), so the
 * assertions are the Owner-visible contract, not internal helper shapes:
 *   - three hosts present; codex/workbuddy `monitored`, openclaw explicit
 *     `not_wired` with reason + nextAction (rc-9, never an empty row);
 *   - flag/consent views follow the SAME production readers (config flags +
 *     v3 ledger) — flag-on-without-grant is visible;
 *   - checkpoint water-mark summary (offset / lag via SIZE stat / last
 *     degradation) computed from seeded rows;
 *   - live_only: an observation WITHOUT a checkpoint is listed as the
 *     explicit live_only state, never rendered as a lag anomaly;
 *   - a malformed config renders flags UNKNOWN (source=malformed), not a
 *     fake DISABLED.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assessIngestionHealth, formatIngestionHealthLines } from '../../src/commands/health-ingestion.js';
import {
  ingestGovernanceObservations,
  recordConversationIngestionConsent,
  type GovernanceObservationInput,
} from '@principles/host-runtime';
import { getDefaultPdConfig } from '@principles/core/runtime';

const NOW = new Date('2026-11-12T00:00:00.000Z');

let workspaceDir: string;
let home: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ingest-health-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), '');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ingest-home-'));
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function observation(hostKind: 'codex' | 'workbuddy', rolloutIdentity: string, logicalKey: string, observedAt: string): GovernanceObservationInput {
  return {
    hostKind,
    rolloutIdentity,
    rootSessionId: rolloutIdentity,
    hostTurnId: `turn-${logicalKey}`,
    kind: 'user_turn',
    logicalObservationKey: `${hostKind}|${rolloutIdentity}|${logicalKey}`,
    transcriptRecordKey: `${hostKind}|${rolloutIdentity}|${logicalKey}`,
    recordByteStart: 100,
    recordOrdinal: 1,
    visibleText: 'synthetic',
    source: 'transcript',
    completeness: 'complete',
    observedAt,
  };
}

function seedCheckpoint(hostKind: 'codex' | 'workbuddy', rolloutIdentity: string, byteOffset: number): void {
  const result = ingestGovernanceObservations({
    workspaceDir,
    rollout: { hostKind, rolloutIdentity, rootSessionId: rolloutIdentity },
    observations: [observation(hostKind, rolloutIdentity, 'seed', NOW.toISOString())],
    checkpoint: { hostKind, rolloutIdentity, byteOffset, lastOrdinal: 3, rootSessionId: rolloutIdentity, incompleteTail: false },
    now: NOW,
  });
  if (!result.ok) throw new Error(`seed failed: ${result.reason}`);
}

/** One real WorkBuddy transcript on disk so the SIZE-stat lag is reachable. */
function seedWorkbuddyTranscript(rolloutIdentity: string, sizeBytes: number): void {
  const projectDir = path.join(home, '.workbuddy', 'projects', 'd-Synth-Health');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${rolloutIdentity}.jsonl`), 'x'.repeat(sizeBytes), 'utf8');
}

describe('three-host ingestion health contract (ticket ⑦)', () => {
  it('renders all three hosts; openclaw is an explicit not_wired row (rc-9)', async () => {
    const section = await assessIngestionHealth({ workspaceDir, home });
    expect(section.codex.status).toBe('monitored');
    expect(section.workbuddy.status).toBe('monitored');
    expect(section.openclaw).toMatchObject({
      status: 'not_wired',
      reason: expect.stringContaining('openclaw_unified_observation'),
      nextAction: expect.stringContaining('ticket ⑨'),
    });
    // The text surface carries the nextAction too (cli-6).
    const lines = formatIngestionHealthLines(section);
    expect(lines.join('\n')).toContain('not_wired');
    expect(lines.join('\n')).toContain('ticket ⑨');
  });

  it('defaults to flags OFF (contract defaults) and consent not_present on an empty workspace', async () => {
    // As-implemented contract defaults: host.codex ON, both ingestion flags
    // OFF (feature-flag-contract.ts). NOTE: SPEC §4.4 says
    // workbuddy_conversation_ingestion defaults enabled=true (Owner 指示) —
    // the contract ships enabled=false; documented as ticket-⑥ drift in the
    // PR for Owner decision. This test pins AS-IMPLEMENTED truth.
    const section = await assessIngestionHealth({ workspaceDir, home });
    expect(section.codex.hostFlag).toMatchObject({ state: 'ENABLED', source: 'defaults' });
    expect(section.codex.ingestionFlag).toMatchObject({ state: 'DISABLED', source: 'defaults' });
    expect(section.workbuddy.hostFlag).toMatchObject({ state: 'DISABLED', source: 'defaults' });
    expect(section.workbuddy.ingestionFlag).toMatchObject({ state: 'DISABLED', source: 'defaults' });
    for (const host of ['codex', 'workbuddy'] as const) {
      expect(section[host].consent.state).toBe('not_present');
      expect(section[host].checkpoints).toMatchObject({ total: 0, checkpointOffset: null, lastSuccessAt: null });
      expect(section[host].liveOnly).toMatchObject({ sessions: [], truncated: false });
    }
  });

  it('surfaces flag_on_without_grant from the production consent reader (rc-9)', async () => {
    const config = getDefaultPdConfig();
    config.features['host.workbuddy'].enabled = true;
    config.features['workbuddy_conversation_ingestion'].enabled = true;
    writeConfig(config as unknown as Record<string, unknown>);
    const section = await assessIngestionHealth({ workspaceDir, home });
    expect(section.workbuddy.ingestionFlag.state).toBe('ENABLED');
    expect(section.workbuddy.consent.state).toBe('flag_on_without_grant');
    expect(section.workbuddy.consent.nextAction).toBeTruthy();
  });

  it('reports the seeded checkpoint water mark and SIZE-stat lag for workbuddy', async () => {
    const config = getDefaultPdConfig();
    config.features['workbuddy_conversation_ingestion'].enabled = true;
    writeConfig(config as unknown as Record<string, unknown>);
    const grant = recordConversationIngestionConsent(workspaceDir, 'workbuddy', {
      decision: 'granted',
      decidedVia: 'owner_directive',
      evidenceRef: 'SPEC v0.2 approval row (2026-11-11)',
      disclosureVersion: 'wb-1',
      decidedAt: NOW.toISOString(),
    });
    expect(grant.ok).toBe(true);
    const identity = 'aaaaaaaa-0000-4000-8000-0000000000a1';
    seedCheckpoint('workbuddy', identity, 1000);
    seedWorkbuddyTranscript(identity, 2500);

    const section = await assessIngestionHealth({ workspaceDir, home });
    const checkpoints = section.workbuddy.checkpoints;
    if ('reason' in checkpoints) throw new Error(`checkpoints degraded: ${checkpoints.reason}`);
    expect(checkpoints.total).toBe(1);
    expect(checkpoints.checkpointOffset).toBe(1000);
    expect(checkpoints.lastSuccessAt).toBe(NOW.toISOString());
    expect(checkpoints.lagBytes).toBe(1500); // size 2500 − offset 1000
    expect(checkpoints.lagUndetectable).toBe(false);
    expect(checkpoints.sessions[0]).toMatchObject({ rolloutIdentity: identity, byteOffset: 1000, lagBytes: 1500, incompleteTail: false });
    expect(section.workbuddy.consent.state).toBe('granted');
    expect(section.workbuddy.consent.disclosureVersion).toBe('wb-1');
  });

  it('lists an observation without a checkpoint as the explicit live_only state', async () => {
    // Codex live-hook rows: observations written with NO checkpoint ever.
    const result = ingestGovernanceObservations({
      workspaceDir,
      rollout: { hostKind: 'codex', rolloutIdentity: 'live-session-1', rootSessionId: 'live-session-1' },
      observations: [observation('codex', 'live-session-1', 'live', '2026-11-11T23:00:00.000Z')],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    // A DIFFERENT codex session has a real checkpoint — it must NOT appear in liveOnly.
    seedCheckpoint('codex', 'checkpointed-session-1', 500);

    const section = await assessIngestionHealth({ workspaceDir, home });
    const liveOnly = section.codex.liveOnly;
    if ('reason' in liveOnly) throw new Error(`liveOnly degraded: ${liveOnly.reason}`);
    expect(liveOnly.sessions).toHaveLength(1);
    expect(liveOnly.sessions[0]).toMatchObject({
      rolloutIdentity: 'live-session-1',
      lastObservedAt: '2026-11-11T23:00:00.000Z',
      observationCount: 1,
    });
    const checkpoints = section.codex.checkpoints;
    if ('reason' in checkpoints) throw new Error(`checkpoints degraded: ${checkpoints.reason}`);
    expect(checkpoints.total).toBe(1);
    expect(checkpoints.checkpointOffset).toBe(500);
    // The text surface renders the live_only count (Owner-visible).
    expect(formatIngestionHealthLines(section).join('\n')).toContain('liveOnly=1');
  });

  it('renders flags UNKNOWN on a malformed config instead of a fake DISABLED (rc-9)', async () => {
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), '::::not yaml:::\n', 'utf8');
    const section = await assessIngestionHealth({ workspaceDir, home });
    for (const host of ['codex', 'workbuddy'] as const) {
      expect(section[host].hostFlag).toMatchObject({ state: 'UNKNOWN', source: 'malformed' });
      expect(section[host].ingestionFlag).toMatchObject({ state: 'UNKNOWN', source: 'malformed' });
    }
  });
});

describe('review round 1 regression pins (PR #2563)', () => {
  it('reports lag UNDETECTABLE when the transcript shrank below the checkpoint (never a fake zero)', async () => {
    // VALID lowercase-hex identity. The locator rejects non-hex names, so an
    // 's' here used to make this test pass for the WRONG reason (EP-09 / PR
    // #2563 re-review 4546266159): the transcript was never located at all.
    const identity = 'bbbbbbbb-0000-4000-8000-000000000001';
    seedCheckpoint('workbuddy', identity, 5000);
    const config = getDefaultPdConfig();
    config.features['workbuddy_conversation_ingestion'].enabled = true;
    writeConfig(config as unknown as Record<string, unknown>);
    const grant = recordConversationIngestionConsent(workspaceDir, 'workbuddy', { decision: 'granted', decidedVia: 'owner_directive', evidenceRef: 'spec', disclosureVersion: 'wb-1', decidedAt: NOW.toISOString() });
    expect(grant.ok).toBe(true);

    // Positive control: with a 6000B transcript the SAME identity resolves to
    // a real 1000B lag — proves the locator actually found the file.
    seedWorkbuddyTranscript(identity, 6000);
    const before = await assessIngestionHealth({ workspaceDir, home });
    const beforeCheckpoints = before.workbuddy.checkpoints;
    if ('reason' in beforeCheckpoints) throw new Error(`degraded: ${beforeCheckpoints.reason}`);
    expect(beforeCheckpoints.lagBytes).toBe(1000);
    expect(beforeCheckpoints.lagUndetectable).toBe(false);

    // Now the file is replaced by a SMALLER one: incomparable, never a fake zero.
    seedWorkbuddyTranscript(identity, 100);
    const section = await assessIngestionHealth({ workspaceDir, home });
    const checkpoints = section.workbuddy.checkpoints;
    if ('reason' in checkpoints) throw new Error(`degraded: ${checkpoints.reason}`);
    expect(checkpoints.lagBytes).toBeNull();
    expect(checkpoints.lagUndetectable).toBe(true);
  });

  it('does NOT stat transcripts without a granted consent (privacy ordering)', async () => {
    // VALID lowercase-hex identity: an 's' here used to make this test pass
    // because the locator rejected the name, NOT because of the consent guard
    // (PR #2563 re-review 4546269473).
    const identity = 'bbbbbbbb-0000-4000-8000-000000000002';
    seedCheckpoint('workbuddy', identity, 100);
    seedWorkbuddyTranscript(identity, 9000); // would show 8900B lag IF statted
    const config = getDefaultPdConfig();
    config.features['workbuddy_conversation_ingestion'].enabled = true;
    writeConfig(config as unknown as Record<string, unknown>);
    // NO consent record → health must not locate/stat the transcript.
    const section = await assessIngestionHealth({ workspaceDir, home });
    const checkpoints = section.workbuddy.checkpoints;
    if ('reason' in checkpoints) throw new Error(`degraded: ${checkpoints.reason}`);
    expect(section.workbuddy.consent.state).toBe('flag_on_without_grant');
    expect(checkpoints.lagBytes).toBeNull();
    expect(checkpoints.lagUndetectable).toBe(true);

    // Positive control: grant consent on the SAME workspace and SAME file —
    // the lag becomes determinable, proving the earlier null was caused by
    // the guard alone (a mutation removing the guard fails this test).
    const grant = recordConversationIngestionConsent(workspaceDir, 'workbuddy', { decision: 'granted', decidedVia: 'owner_directive', evidenceRef: 'spec', disclosureVersion: 'wb-1', decidedAt: NOW.toISOString() });
    expect(grant.ok).toBe(true);
    const after = await assessIngestionHealth({ workspaceDir, home });
    const afterCheckpoints = after.workbuddy.checkpoints;
    if ('reason' in afterCheckpoints) throw new Error(`degraded: ${afterCheckpoints.reason}`);
    expect(afterCheckpoints.lagBytes).toBe(8900);
    expect(afterCheckpoints.lagUndetectable).toBe(false);
  });

  it('lastSuccessAt counts only CLEAN checkpoints (a deferral is not a success)', async () => {
    const dirty = 'bbbbbbbb-0000-4000-8000-0000000000d1';
    const clean = 'bbbbbbbb-0000-4000-8000-0000000000c1';
    const earlier = new Date(NOW.getTime() - 3_600_000);
    // Dirty row: NEWER updated_at but carries a degradation reason (deferral).
    const dirtySeed = ingestGovernanceObservations({
      workspaceDir,
      rollout: { hostKind: 'workbuddy', rolloutIdentity: dirty, rootSessionId: dirty },
      observations: [observation('workbuddy', dirty, 'd', NOW.toISOString())],
      checkpoint: { hostKind: 'workbuddy', rolloutIdentity: dirty, byteOffset: 100, lastOrdinal: 1, rootSessionId: dirty, incompleteTail: false },
      degradations: [{ reason: 'catch_up_transcript_unavailable' }],
      now: NOW,
    });
    expect(dirtySeed.ok).toBe(true);
    // Clean row: OLDER updated_at, no degradation.
    const cleanSeed = ingestGovernanceObservations({
      workspaceDir,
      rollout: { hostKind: 'workbuddy', rolloutIdentity: clean, rootSessionId: clean },
      observations: [observation('workbuddy', clean, 'c', NOW.toISOString())],
      checkpoint: { hostKind: 'workbuddy', rolloutIdentity: clean, byteOffset: 100, lastOrdinal: 1, rootSessionId: clean, incompleteTail: false },
      now: earlier,
    });
    expect(cleanSeed.ok).toBe(true);
    const section = await assessIngestionHealth({ workspaceDir, home });
    const checkpoints = section.workbuddy.checkpoints;
    if ('reason' in checkpoints) throw new Error(`degraded: ${checkpoints.reason}`);
    // The dirty row's NEWER timestamp must NOT claim lastSuccessAt.
    expect(checkpoints.lastSuccessAt).toBe(earlier.toISOString());
    expect(checkpoints.lastDegradation).toMatchObject({ reason: 'catch_up_transcript_unavailable' });
  });
});

describe('review round 2 regression pins (PR #2563)', () => {
  it('text report accounts for EVERY hidden session at 4..8 checkpoints (no silent loss)', async () => {
    for (let i = 0; i < 4; i += 1) {
      seedCheckpoint('workbuddy', `cccccccc-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, 100 + i);
    }
    const section = await assessIngestionHealth({ workspaceDir, home });
    const text = formatIngestionHealthLines(section).join('\n');
    // 4 total, only 3 rendered — the 4th used to disappear with NO hint at all.
    expect(text).toContain('…and 1 more sessions');
    expect(text).toContain('lastCleanCheckpoint:');
  });

  it('text report counts the FULL set when checkpoints exceed the JSON detail cap', async () => {
    for (let i = 0; i < 9; i += 1) {
      seedCheckpoint('workbuddy', `dddddddd-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, 100 + i);
    }
    const section = await assessIngestionHealth({ workspaceDir, home });
    const text = formatIngestionHealthLines(section).join('\n');
    // 9 total, 3 rendered; the old formula (total − sessions.length = 9 − 8)
    // reported "1 more", and only when `truncated` happened to be set.
    expect(text).toContain('…and 6 more sessions');
  });

  it('text report discloses hidden live-only sessions even below the store limit', async () => {
    for (let i = 0; i < 4; i += 1) {
      const identity = `eeeeeeee-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
      const result = ingestGovernanceObservations({
        workspaceDir,
        rollout: { hostKind: 'codex', rolloutIdentity: identity, rootSessionId: identity },
        observations: [observation('codex', identity, 'live', NOW.toISOString())],
        now: NOW,
      });
      expect(result.ok).toBe(true);
    }
    const section = await assessIngestionHealth({ workspaceDir, home });
    const text = formatIngestionHealthLines(section).join('\n');
    expect(text).toContain('liveOnly=4');
    expect(text).toContain('…and 1 more live-only sessions');
  });

  it('bounds transcript lookups: sessions beyond the cap report lag as undetectable', async () => {
    const config = getDefaultPdConfig();
    config.features['workbuddy_conversation_ingestion'].enabled = true;
    writeConfig(config as unknown as Record<string, unknown>);
    const grant = recordConversationIngestionConsent(workspaceDir, 'workbuddy', {
      decision: 'granted', decidedVia: 'owner_directive', evidenceRef: 'spec',
      disclosureVersion: 'wb-1', decidedAt: NOW.toISOString(),
    });
    expect(grant.ok).toBe(true);
    // 33 sessions, ALL with a readable transcript. With an unbounded walk the
    // lag would be fully determinable; the cap must leave at least one out and
    // say so explicitly instead of silently dropping it from the max (rc-9).
    for (let i = 0; i < 33; i += 1) {
      const identity = `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`;
      seedCheckpoint('workbuddy', identity, 100);
      seedWorkbuddyTranscript(identity, 2500);
    }
    const section = await assessIngestionHealth({ workspaceDir, home });
    const checkpoints = section.workbuddy.checkpoints;
    if ('reason' in checkpoints) throw new Error(`degraded: ${checkpoints.reason}`);
    expect(checkpoints.total).toBe(33);
    expect(checkpoints.lagUndetectable).toBe(true);
    expect(checkpoints.sessions).toHaveLength(8);
  });
});

/** Write a minimal .pd/config.yaml the production loader reads (js-yaml JSON subset). */
function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config), 'utf8');
}
