/**
 * End-to-end wiring proof (PRI-1171 P2, tickets ⑤/⑥).
 *
 * Unlike pipeline-integration.test.ts — which drives the seam directly — this
 * suite spawns the REAL built hook entry process with a REAL governance
 * workspace, REAL flag config, REAL v3 consent ledger and a REAL WorkBuddy
 * transcript on disk, then reads trajectory.db to prove that a Stop hook
 * actually writes WorkBuddy observations for the downstream data pipeline.
 *
 * Privacy invariants are asserted at the same boundary: flag-off, missing
 * consent and revoked consent all produce ZERO transcript port calls and zero
 * rows (SPEC §8.2 / §10).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  listGovernanceObservations,
  readGovernanceCheckpoint,
  recordConversationIngestionConsent,
  type TranscriptPort,
} from '@principles/host-runtime';
import { createSpawnStartBarrier, runEntry, runEntryAsync } from '../helpers/hook-runner.js';
import { cleanupTempDirs, makeGovernance, makeHome } from '../helpers/workbench.js';
import { ingestWorkbuddyConversation, workbuddyIngestionHints } from '../../src/ingestion/ingestion.js';
import { catchUpWorkbuddyIngestion } from '../../src/ingestion/catch-up.js';

afterAll(cleanupTempDirs);

const SESSION_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const OWNER_TEXT = '请对 PR 2534 做评审，确认 WorkBuddy 对话真正落库';
const HOST_CONTEXT = [
  '<system-reminder data-role="user-context">',
  '<user_info>OS Version: win32',
  `AGENTS.md constitution ${'x'.repeat(400)}`,
  '</user_info></system-reminder>',
  '<system-reminder data-role="additional-data"><current_time>2026-11-11</current_time></system-reminder>',
].join('\n');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface FixtureOptions {
  ingestionFlag: boolean;
  consent?: 'granted' | 'revoked';
}

interface Fixture {
  home: string;
  workspaceDir: string;
  transcriptPath: string;
  payload: Record<string, unknown>;
}

function makeFixture(options: FixtureOptions): Fixture {
  const home = makeHome();
  const workspaceDir = makeGovernance(home, { workbuddyFlag: true });

  // Enable (or explicitly disable) the ingestion flag in the REAL workspace
  // config. host.workbuddy is already enabled by makeGovernance.
  const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.features)) throw new Error('governance config has no features mapping');
  // `source` is optional in validateFeatureFlagEntry; when present it must be
  // owner|system. Omit it so the override stays a plain workspace decision.
  parsed.features['workbuddy_conversation_ingestion'] = { category: 'quiet', enabled: options.ingestionFlag };
  fs.writeFileSync(configPath, JSON.stringify(parsed));

  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), '');

  if (options.consent !== undefined) {
    const recorded = recordConversationIngestionConsent(workspaceDir, 'workbuddy', {
      decision: options.consent,
      decidedVia: 'owner_directive',
      disclosureVersion: 'wb-2026-11-11',
      evidenceRef: 'test: explicit Owner directive for WorkBuddy ingestion',
    });
    if (!recorded.ok) throw new Error(`consent fixture write failed: ${recorded.reason}`);
  }

  // Real on-disk WorkBuddy transcript under <home>/.workbuddy/projects/<encoded-cwd>/.
  const projectDir = path.join(home, '.workbuddy', 'projects', 'd-Synth-wb');
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
  const now = Date.now();
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', timestamp: now, type: 'message', role: 'user', sessionId: SESSION_ID, content: [{ type: 'input_text', text: `${HOST_CONTEXT}\n<user_query>${OWNER_TEXT}</user_query>` }] }),
    JSON.stringify({ id: '00000000-0000-4000-8000-000000000002', timestamp: now + 1, type: 'message', role: 'assistant', sessionId: SESSION_ID, content: [{ type: 'output_text', text: '已收到评审请求' }] }),
  ].join('\n') + '\n');

  const payload = {
    hook_event_name: 'Stop',
    session_id: SESSION_ID,
    transcript_path: transcriptPath,
    stop_hook_active: false,
    generation_id: 'generation-0001',
  };
  return { home, workspaceDir, transcriptPath, payload };
}

function rowsOf(workspaceDir: string) {
  const listed = listGovernanceObservations({ workspaceDir, rolloutIdentity: SESSION_ID });
  expect(listed.ok).toBe(true);
  if (!listed.ok) return [];
  return listed.observations;
}

describe('real Stop hook → trajectory.db', () => {
  it('writes WorkBuddy observations with the Owner utterance when all three gates are open', () => {
    const fixture = makeFixture({ ingestionFlag: true, consent: 'granted' });
    const result = runEntry(fixture.home, JSON.stringify(fixture.payload), 'Stop');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    // A decode/config failure also yields zero rows — assert a CLEAN neutral
    // result so these negative cases cannot pass as false greens.
    expect(result.stderr).toBe(''); // neutral: WorkBuddy injects any stdout into model context

    const rows = rowsOf(fixture.workspaceDir);
    expect(rows.length, `hook stderr: ${result.stderr}`).toBeGreaterThanOrEqual(2);
    const user = rows.find((row) => row.kind === 'user_turn');
    expect(user?.visibleText).toBe(OWNER_TEXT);
    expect(user?.visibleText).not.toContain('system-reminder');
    expect(user?.completeness).toBe('complete');
    expect(rows.some((row) => row.kind === 'assistant_turn')).toBe(true);

    const checkpoint = readGovernanceCheckpoint({ workspaceDir: fixture.workspaceDir, hostKind: 'workbuddy', rolloutIdentity: SESSION_ID });
    expect(checkpoint !== null && 'byteOffset' in checkpoint ? checkpoint.byteOffset : 0).toBeGreaterThan(0);
  });

  it('a successful ingestion that only SKIPPED routine records reports `skipped`, never `degraded` (review P2-9)', () => {
    const fixture = makeFixture({ ingestionFlag: true, consent: 'granted' });
    fs.appendFileSync(fixture.transcriptPath, JSON.stringify({
      id: '00000000-0000-4000-8000-000000000003',
      timestamp: Date.now() + 2,
      type: 'session-meta',
      sessionId: SESSION_ID,
    }) + '\n');

    const result = runEntry(fixture.home, JSON.stringify(fixture.payload), 'Stop');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    // rc-9: the skip stays observable, but it is routine — not a degradation.
    expect(result.stderr).toContain('status=skipped');
    expect(result.stderr).toContain('wb_skipped:session-meta');
    expect(result.stderr).not.toContain('status=degraded');
    expect(rowsOf(fixture.workspaceDir).length).toBeGreaterThanOrEqual(2);
  });

  it('writes ZERO rows and stays neutral when the ingestion flag is off', () => {
    const fixture = makeFixture({ ingestionFlag: false, consent: 'granted' });
    const result = runEntry(fixture.home, JSON.stringify(fixture.payload), 'Stop');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    // A decode/config failure also yields zero rows — assert a CLEAN neutral
    // result so these negative cases cannot pass as false greens.
    expect(result.stderr).toBe('');
    expect(rowsOf(fixture.workspaceDir)).toHaveLength(0);
  });

  it('writes ZERO rows when no WorkBuddy consent record exists', () => {
    const fixture = makeFixture({ ingestionFlag: true });
    const result = runEntry(fixture.home, JSON.stringify(fixture.payload), 'Stop');
    expect(result.status).toBe(0);
    // Without these two assertions a decode/config failure (which ALSO writes
    // zero rows) would be indistinguishable from a correctly gated skip.
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(rowsOf(fixture.workspaceDir)).toHaveLength(0);
  });

  it('writes ZERO rows after consent is revoked', () => {
    const fixture = makeFixture({ ingestionFlag: true, consent: 'revoked' });
    const result = runEntry(fixture.home, JSON.stringify(fixture.payload), 'Stop');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(rowsOf(fixture.workspaceDir)).toHaveLength(0);
  });

  it('positive control: with every gate OPEN a decode failure still yields status 0 + zero rows, but a NON-empty stderr', () => {
    // This is the assertion-discrimination proof for the negative cases above:
    // the same observable "status 0 / zero rows" can come from a real failure,
    // and only the stderr/stdout assertions tell the two apart.
    const fixture = makeFixture({ ingestionFlag: true, consent: 'granted' });
    const brokenPayload = {
      hook_event_name: 'Stop',
      session_id: SESSION_ID,
      stop_hook_active: false,
      // Neither transcript_path nor agent_transcript_path: the decoder must
      // fail loud even though all consent gates are open.
    };
    const result = runEntry(fixture.home, JSON.stringify(brokenPayload), 'Stop');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
    expect(result.stderr).toContain('transcript_path');
    expect(rowsOf(fixture.workspaceDir)).toHaveLength(0);
  });
});

describe('concurrency and revocation ordering (review P2-11)', () => {
  it('two concurrent Stop hooks for the same session stay clean and write no duplicate logical keys', { timeout: 60_000 }, async () => {
    const fixture = makeFixture({ ingestionFlag: true, consent: 'granted' });
    const barrier = createSpawnStartBarrier(2);
    const payload = JSON.stringify(fixture.payload);
    const [first, second] = await Promise.all([
      runEntryAsync(fixture.home, payload, 'Stop', { startBarrier: barrier }),
      runEntryAsync(fixture.home, payload, 'Stop', { startBarrier: barrier }),
    ]);
    for (const result of [first, second]) {
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(result.startedAt).toBeDefined();
      expect(result.endedAt).toBeDefined();
    }
    // Real interval overlap, not serialization (the start barrier is the reason).
    expect(first.startedAt ?? 0).toBeLessThan(second.endedAt ?? 0);
    expect(second.startedAt ?? 0).toBeLessThan(first.endedAt ?? 0);

    const rows = rowsOf(fixture.workspaceDir);
    const keys = rows.map((row) => row.logicalKey);
    expect(keys.every((key) => typeof key === 'string' && key.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.find((row) => row.kind === 'user_turn')?.visibleText).toBe(OWNER_TEXT);
  });

  it('revocation takes effect between two Stop runs: later turns are NOT ingested', () => {
    const fixture = makeFixture({ ingestionFlag: true, consent: 'granted' });
    const firstRun = runEntry(fixture.home, JSON.stringify(fixture.payload), 'Stop');
    expect(firstRun.stderr).toBe('');
    const before = rowsOf(fixture.workspaceDir);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const checkpointBefore = readGovernanceCheckpoint({ workspaceDir: fixture.workspaceDir, hostKind: 'workbuddy', rolloutIdentity: SESSION_ID });

    fs.appendFileSync(fixture.transcriptPath, JSON.stringify({
      id: '00000000-0000-4000-8000-000000000009',
      timestamp: Date.now() + 5,
      type: 'message',
      role: 'user',
      sessionId: SESSION_ID,
      content: [{ type: 'input_text', text: '<user_query>撤销之后新增的一轮</user_query>' }],
    }) + '\n');

    const revoked = recordConversationIngestionConsent(fixture.workspaceDir, 'workbuddy', {
      decision: 'revoked',
      decidedVia: 'owner_directive',
      disclosureVersion: 'wb-2026-11-11',
      evidenceRef: 'test: Owner revoked between runs',
    });
    expect(revoked.ok).toBe(true);

    const secondRun = runEntry(fixture.home, JSON.stringify(fixture.payload), 'Stop');
    expect(secondRun.status).toBe(0);
    expect(secondRun.stdout).toBe('');
    expect(secondRun.stderr).toBe('');

    const after = rowsOf(fixture.workspaceDir);
    expect(after).toHaveLength(before.length);
    expect(after.some((row) => row.visibleText === '撤销之后新增的一轮')).toBe(false);
    const checkpointAfter = readGovernanceCheckpoint({ workspaceDir: fixture.workspaceDir, hostKind: 'workbuddy', rolloutIdentity: SESSION_ID });
    expect(checkpointAfter !== null && 'byteOffset' in checkpointAfter ? checkpointAfter.byteOffset : 0)
      .toBe(checkpointBefore !== null && 'byteOffset' in checkpointBefore ? checkpointBefore.byteOffset : 0);
  });
});

describe('ingestion orchestrator contracts', () => {
  it('bridges snake_case hook hints to the host-neutral HookHints contract', () => {
    expect(workbuddyIngestionHints({
      transcript_path: 'C:/transcripts/a.jsonl',
      agent_transcript_path: '',
      generation_id: 'gen-1',
    })).toEqual({ transcriptPath: 'C:/transcripts/a.jsonl', generationId: 'gen-1' });
    expect(workbuddyIngestionHints({ agent_transcript_path: 'C:/transcripts/b.jsonl' })).toEqual({ agentTranscriptPath: 'C:/transcripts/b.jsonl' });
    expect(workbuddyIngestionHints(null)).toEqual({});
  });

  it('short-circuits BEFORE any transcript port call when the flag is off or consent is absent', () => {
    let calls = 0;
    const spyPort: TranscriptPort = { read: () => { calls += 1; throw new Error('transcript port must not be reached'); } };
    const base = makeFixture({ ingestionFlag: true });

    const flagOff = ingestWorkbuddyConversation({
      workspaceDir: base.workspaceDir, rawPayload: base.payload, sessionId: SESSION_ID,
      ingestionEnabled: false, port: spyPort,
    });
    expect(flagOff.status).toBe('skipped');
    expect(calls).toBe(0);

    const noConsent = ingestWorkbuddyConversation({
      workspaceDir: base.workspaceDir, rawPayload: base.payload, sessionId: SESSION_ID,
      ingestionEnabled: true, port: spyPort,
    });
    expect(noConsent.status).toBe('skipped');
    expect(noConsent).toMatchObject({ reason: 'consent_not_granted:not_present' });
    expect(calls).toBe(0);
  });
});

describe('worker catch-up (ticket ⑤)', () => {
  it('drains lag appended after a bounded window / missed Stop hook', () => {
    const fixture = makeFixture({ ingestionFlag: true, consent: 'granted' });
    // A first pass commits the durable checkpoint at the original EOF.
    const first = ingestWorkbuddyConversation({
      workspaceDir: fixture.workspaceDir,
      rawPayload: fixture.payload,
      sessionId: SESSION_ID,
      ingestionEnabled: true,
      home: fixture.home,
    });
    expect(first.status).toBe('ingested');

    // The host appends another turn after that read — this is exactly the lag
    // the worker cycle must recover without a second Stop hook.
    const appended = JSON.stringify({
      id: '00000000-0000-4000-8000-000000000003',
      timestamp: Date.now() + 2,
      type: 'message',
      role: 'user',
      sessionId: SESSION_ID,
      content: [{ type: 'input_text', text: '<user_query>追补的一轮对话</user_query>' }],
    });
    fs.appendFileSync(fixture.transcriptPath, appended + '\n');

    const caught = catchUpWorkbuddyIngestion({
      workspaceDir: fixture.workspaceDir,
      ingestionEnabled: true,
      home: fixture.home,
    });
    expect(caught.status).toBe('ok');
    expect(caught.examined).toBeGreaterThanOrEqual(1);
    expect(caught.ingested).toBeGreaterThanOrEqual(1);
    expect(rowsOf(fixture.workspaceDir).some((row) => row.visibleText === '追补的一轮对话')).toBe(true);
  });

  it('does zero work when the ingestion flag is off', () => {
    const fixture = makeFixture({ ingestionFlag: false, consent: 'granted' });
    const caught = catchUpWorkbuddyIngestion({
      workspaceDir: fixture.workspaceDir,
      ingestionEnabled: false,
      home: fixture.home,
    });
    expect(caught.status).toBe('skipped');
    expect(caught.examined).toBe(0);
    expect(rowsOf(fixture.workspaceDir)).toHaveLength(0);
  });
});
