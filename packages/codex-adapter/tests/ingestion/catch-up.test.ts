import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestCodexConversation, catchUpCodexIngestion, setCodexTranscriptPortForTest } from '../../src/index.js';
import { listGovernanceCheckpoints, readGovernanceCheckpoint } from '@principles/host-runtime';
import { locateCodexTranscriptByRolloutIdentity } from '../../src/ingestion/transcript-locate.js';
import { writeGrantedCodexConsent } from '../helpers/consent.js';

/**
 * PRI-624 Slice C catch-up: bounded non-destructive recovery of transcript
 * lag from durable checkpoints, resolved by EXACT rollout uuid — with the
 * flag-off zero-transcript-I/O invariant extended over the lookup path.
 */

const FIXTURES = new URL('../fixtures/g1-contract/', import.meta.url);
const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const TURN_1 = '01a048ae-b344-7eb2-804b-a2fa34302fb3';
const ROLLOUT_UUID = '01a048ae-b2a5-71a1-9faf-0226980f98ff';

let workspaceDir: string;
let codexHome: string;
let transcriptPath: string;

function writeConfig(ingestionEnabled: boolean): void {
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), [
    'version: 1',
    'features:',
    '  codex_conversation_ingestion:',
    '    category: quiet',
    `    enabled: ${ingestionEnabled ? 'true' : 'false'}`,
    'runtimeProfiles:',
    '  openclaw.default:',
    '    type: openclaw',
    '    source: default',
    'internalAgents:',
    '  defaultRuntime: openclaw.default',
    '  agents:',
    '    dreamer:',
    '      enabled: true',
    '',
  ].join('\n'));
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-catchup-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), '');
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-home-'));
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '28');
  fs.mkdirSync(sessions, { recursive: true });
  transcriptPath = path.join(sessions, `rollout-2026-08-28T22-03-23-${ROLLOUT_UUID}.jsonl`);
  fs.copyFileSync(new URL('transcripts/normal-tool-final-turn.jsonl', FIXTURES), transcriptPath);
  writeConfig(true);
  // PRI-1262: catch-up reuses the formal consent judgment — happy-path tests
  // need a granted ledger record.
  writeGrantedCodexConsent(workspaceDir);
});

afterEach(() => {
  setCodexTranscriptPortForTest(null);
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
});

function stopPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: ROOT_SESSION,
    turn_id: TURN_1,
    transcript_path: transcriptPath,
    cwd: workspaceDir,
    hook_event_name: 'Stop',
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
    stop_hook_active: false,
    last_assistant_message: 'FIXTURE-A-DONE',
    ...overrides,
  };
}

function appendGrowthRecord(): void {
  const appended = JSON.stringify({ timestamp: '2026-08-28T14:10:00.000Z', ordinal: 40, type: 'event_msg', payload: { type: 'item_completed', thread_id: ROOT_SESSION, turn_id: '01a048af-9999-0000-0000-000000000001', item: { type: 'AgentMessage', id: 'msg_synthetic_final_1', content: [{ type: 'Text', text: 'grown later' }] } } });
  fs.appendFileSync(transcriptPath, `${appended}\n`);
}

describe('locateCodexTranscriptByRolloutIdentity', () => {
  it('resolves the exact rollout uuid under a dated sessions tree', () => {
    const result = locateCodexTranscriptByRolloutIdentity(codexHome, ROLLOUT_UUID);
    expect(result.ok).toBe(true);
  });

  it('refuses non-uuid identities and missing/ambiguous matches — never guesses', () => {
    expect(locateCodexTranscriptByRolloutIdentity(codexHome, 'not-a-uuid')).toMatchObject({ ok: false, reason: 'catch_up_rollout_identity_invalid' });
    expect(locateCodexTranscriptByRolloutIdentity(codexHome, '11111111-2222-3333-4444-555555555555')).toMatchObject({ ok: false, reason: 'catch_up_transcript_missing' });
    expect(locateCodexTranscriptByRolloutIdentity(path.join(codexHome, 'nope'), ROLLOUT_UUID)).toMatchObject({ ok: false, reason: 'catch_up_sessions_root_missing' });

    const otherDay = path.join(codexHome, 'sessions', '2026', '08', '29');
    fs.mkdirSync(otherDay, { recursive: true });
    fs.copyFileSync(transcriptPath, path.join(otherDay, `rollout-2026-08-29T10-00-00-${ROLLOUT_UUID}.jsonl`));
    expect(locateCodexTranscriptByRolloutIdentity(codexHome, ROLLOUT_UUID)).toMatchObject({ ok: false, reason: 'catch_up_transcript_ambiguous' });
  });
});

describe('catchUpCodexIngestion', () => {
  it('performs ZERO transcript I/O when codex_conversation_ingestion is off — even with a checkpoint present and the sessions root removed', async () => {
    // Seed a checkpoint through the hook path first (ingestion enabled).
    const seeded = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(seeded.status).toBe('ok');
    appendGrowthRecord();
    writeConfig(false);
    // Remove the sessions root entirely — any lookup attempt would have to fail loudly,
    // so a clean skip proves the gate preceded the walk, not just the read.
    fs.rmSync(path.join(codexHome, 'sessions'), { recursive: true, force: true });
    const readCalls: string[] = [];
    setCodexTranscriptPortForTest({ read: (args: { canonicalPath: string }) => { readCalls.push(args.canonicalPath); throw new Error('must not read'); } });
    const result = await catchUpCodexIngestion({ workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result).toMatchObject({ status: 'skipped', reason: 'feature_disabled' });
    expect(readCalls).toEqual([]);
  });

  it('resumes lag from the checkpoint after transcript growth, advancing the checkpoint exactly like the hook path', async () => {
    ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    appendGrowthRecord();
    const before = readGovernanceCheckpoint({ workspaceDir, hostKind: 'codex', rolloutIdentity: ROLLOUT_UUID });
    expect(before && 'byteOffset' in before ? before.byteOffset : null).toBeLessThan(fs.statSync(transcriptPath).size);

    const result = await catchUpCodexIngestion({ workspaceDir, env: { CODEX_HOME: codexHome } });
    if (result.status === 'skipped') throw new Error(`unexpected skip: ${result.reason}`);
    expect(result.status).toBe('ok');
    expect(result.rollouts).toHaveLength(1);
    const entry = result.rollouts[0];
    expect(entry?.outcome.status).toBe('ok');
    const after = readGovernanceCheckpoint({ workspaceDir, hostKind: 'codex', rolloutIdentity: ROLLOUT_UUID });
    expect(after && 'byteOffset' in after ? after.byteOffset : null).toBe(fs.statSync(transcriptPath).size);
    expect(result.remainingLagRollouts).toEqual([]);
  });

  it('is idempotent: a second pass with no growth reports ok with zero inserts', async () => {
    ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    const result = await catchUpCodexIngestion({ workspaceDir, env: { CODEX_HOME: codexHome } });
    if (result.status === 'skipped') throw new Error(`unexpected skip: ${result.reason}`);
    const entry = result.rollouts[0];
    if (!entry || entry.outcome.status !== 'ok') throw new Error('expected ok rollout outcome');
    expect(entry.outcome.inserted).toBe(0);
    expect(entry.outcome.lagBytes).toBe(0);
  });

  it('degrades per-rollout when the transcript is gone, without losing committed observations', async () => {    ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    fs.rmSync(transcriptPath);
    const result = await catchUpCodexIngestion({ workspaceDir, env: { CODEX_HOME: codexHome } });
    if (result.status === 'skipped') throw new Error(`unexpected skip: ${result.reason}`);
    expect(result.status).toBe('degraded');
    expect(result.rollouts[0]?.outcome).toMatchObject({ status: 'degraded', reason: 'catch_up_transcript_missing' });
    expect(result.remainingLagRollouts).toEqual([ROLLOUT_UUID]);
  });

  it('bounds rollouts per invocation and repeated passes converge the remainder', async () => {
    ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    const secondUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const secondSessions = path.join(codexHome, 'sessions', '2026', '08', '30');
    fs.mkdirSync(secondSessions, { recursive: true });
    const secondPath = path.join(secondSessions, `rollout-2026-08-30T09-00-00-${secondUuid}.jsonl`);
    fs.copyFileSync(new URL('transcripts/normal-tool-final-turn.jsonl', FIXTURES), secondPath);
    const secondIngest = ingestCodexConversation(
      { ...stopPayload(), session_id: secondUuid, transcript_path: secondPath },
      'turn_complete',
      { workspaceDir, env: { CODEX_HOME: codexHome } },
    );
    expect(secondIngest.status).toBe('ok');
    const listed = listGovernanceCheckpoints({ workspaceDir, hostKind: 'codex' });
    expect(listed.ok && listed.checkpoints.length).toBe(2);

    const first = await catchUpCodexIngestion({ workspaceDir, env: { CODEX_HOME: codexHome }, maxRollouts: 1 });
    if (first.status === 'skipped') throw new Error(`unexpected skip: ${first.reason}`);
    expect(first.rollouts).toHaveLength(1);
    expect(first.remainingLagRollouts).toEqual([]);
    expect(first.unexaminedRollouts).toHaveLength(1);
    // Processing a rollout refreshes its updated_at, so the bounded slice
    // ROTATES: the next bounded pass examines the other rollout (no starvation).
    const second = await catchUpCodexIngestion({ workspaceDir, env: { CODEX_HOME: codexHome }, maxRollouts: 1 });
    if (second.status === 'skipped') throw new Error(`unexpected skip: ${second.reason}`);
    expect(second.rollouts[0]?.rolloutIdentity).not.toBe(first.rollouts[0]?.rolloutIdentity);
    expect(second.remainingLagRollouts).toEqual([]);
    expect(second.unexaminedRollouts).toEqual([first.rollouts[0]?.rolloutIdentity]);
    // A full-width pass then converges with nothing remaining and nothing unexamined.
    const full = await catchUpCodexIngestion({ workspaceDir, env: { CODEX_HOME: codexHome } });
    if (full.status === 'skipped') throw new Error(`unexpected skip: ${full.reason}`);
    expect(full.remainingLagRollouts).toEqual([]);
    expect(full.unexaminedRollouts).toEqual([]);
  });

  it('skips loudly on malformed workspace config', async () => {
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), 'version: 1\nfeatures: [broken\n');
    const result = await catchUpCodexIngestion({ workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') expect(result.reason).toContain('pd_config_invalid');
  });

  // ── PRI-1261: an oversized COMPLETE record must not stall the checkpoint ──

  it('PRI-1261: oversized complete record is SKIPPED with a tracked disposition; subsequent turns, incomplete tail and restart replay all converge', async () => {
    // The audit's reproduction shape: normal fixture lines → one oversized
    // complete line (~1.5 MB > the 1 MiB window) → collectible turns → an
    // incomplete tail WITHOUT a trailing newline.
    const fixtureLines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
    const normalBefore = fixtureLines.slice(0, 4).join('\n') + '\n';
    const oversizeLine = JSON.stringify({
      timestamp: '2026-08-28T14:09:00.000Z', ordinal: 39, type: 'event_msg',
      payload: { type: 'item_completed', thread_id: ROOT_SESSION, turn_id: '01a048af-8888-0000-0000-000000000001', item: { type: 'AgentMessage', id: 'msg_oversized_1', content: [{ type: 'Text', text: `AUDIT-OVERSIZE-${'x'.repeat(1_500_000)}` }] } },
    }) + '\n';
    const after = fixtureLines.slice(4, 6).join('\n') + '\n';
    const incompleteTail = '{"timestamp":"2026-08-28T14:11:00.000Z","ordinal":50,"type":"event_msg","payload":{"type":"item_co';
    const oversizeStart = Buffer.byteLength(normalBefore, 'utf8');
    const oversizeEnd = oversizeStart + Buffer.byteLength(oversizeLine, 'utf8');
    const beforeTail = oversizeEnd + Buffer.byteLength(after, 'utf8');
    fs.writeFileSync(transcriptPath, normalBefore + oversizeLine + after + incompleteTail);

    const cp = (): number | null => {
      const read = readGovernanceCheckpoint({ workspaceDir, hostKind: 'codex', rolloutIdentity: ROLLOUT_UUID });
      return read !== null && 'byteOffset' in read ? read.byteOffset : null;
    };

    // Cycle 1 (hook path): consumes the normal lines; the window ends inside
    // the oversized record — byte_bound, NOT an oversized stop.
    const first = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(first.status).toBe('ok');
    expect(cp()).toBe(oversizeStart);

    // Cycle 2 (formal catch-up entry): the window is entirely inside the
    // oversized COMPLETE record. PRI-1261: scan-ahead finds its newline, the
    // record is skipped with a tracked disposition and the checkpoint ADVANCES
    // (the pre-fix behavior returned the same offset forever).
    const skipPass = await catchUpCodexIngestion({ workspaceDir, env: { CODEX_HOME: codexHome } });
    if (skipPass.status === 'skipped') throw new Error(`unexpected skip: ${skipPass.reason}`);
    const skipOutcome = skipPass.rollouts[0]?.outcome;
    expect(skipOutcome?.status).toBe('degraded');
    if (skipOutcome?.status !== 'degraded') return;
    expect(skipOutcome.reason).toBe('transcript_record_too_large');
    expect(skipOutcome.warnings.join(' ')).toContain(`transcript_record_skipped_oversized:${oversizeEnd - oversizeStart}b@${oversizeStart}->${oversizeEnd}`);
    expect(cp()).toBe(oversizeEnd);

    // Cycle 3: the turns AFTER the oversized record are collectible; the
    // trailing partial record holds as an incomplete tail.
    const afterPass = await catchUpCodexIngestion({ workspaceDir, env: { CODEX_HOME: codexHome } });
    if (afterPass.status === 'skipped') throw new Error(`unexpected skip: ${afterPass.reason}`);
    const afterOutcome = afterPass.rollouts[0]?.outcome;
    expect(afterOutcome?.status).toBe('ok');
    if (afterOutcome?.status !== 'ok') return;
    expect(afterOutcome.inserted).toBeGreaterThan(0);
    expect(cp()).toBe(beforeTail);

    // Cycle 4 (restart replay): the tail completes and is consumed exactly
    // once; a final pass is a pure no-op.
    fs.appendFileSync(transcriptPath, 'mpleted","thread_id":"' + ROOT_SESSION + '","turn_id":"01a048af-9999-0000-0000-000000000002","item":{"type":"AgentMessage","id":"msg_tail_complete","content":[{"type":"Text","text":"tail completed"}]}}}\n');
    const tailPass = await catchUpCodexIngestion({ workspaceDir, env: { CODEX_HOME: codexHome } });
    if (tailPass.status === 'skipped') throw new Error(`unexpected skip: ${tailPass.reason}`);
    expect(tailPass.rollouts[0]?.outcome).toMatchObject({ status: 'ok' });
    expect(cp()).toBe(fs.statSync(transcriptPath).size);
    const replay = await catchUpCodexIngestion({ workspaceDir, env: { CODEX_HOME: codexHome } });
    if (replay.status === 'skipped') throw new Error(`unexpected skip: ${replay.reason}`);
    expect(replay.rollouts[0]?.outcome).toMatchObject({ status: 'ok', inserted: 0 });
  });
});
