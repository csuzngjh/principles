import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { ingestCodexConversation, setCodexTranscriptPortForTest } from '../../src/ingestion/ingestion.js';
import { listGovernanceObservations, readGovernanceCheckpoint } from '@principles/host-runtime';

/**
 * Orchestrator-level Slice A tests: the real Stop ingestion path against a
 * real workspace trajectory.db and real G1 fixture bytes placed under a
 * configured CODEX_HOME — path authorization, checkpointing, replay
 * idempotency, live+transcript convergence, version degradation, and the
 * flag-off zero-read privacy invariant.
 */

const FIXTURES = new URL('../fixtures/g1-contract/', import.meta.url);
const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const TURN_1 = '01a048ae-b344-7eb2-804b-a2fa34302fb3';
const TOOL_USE_ID = 'exec-db1bff81-f42e-45f8-91ce-e87480fa15d9';

let workspaceDir: string;
let codexHome: string;
let transcriptPath: string;
const ROLLOUT_UUID = '01a048ae-b2a5-71a1-9faf-0226980f98ff';

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-ingest-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), '');
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-home-'));
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '28');
  fs.mkdirSync(sessions, { recursive: true });
  transcriptPath = path.join(sessions, `rollout-2026-08-28T22-03-23-${ROLLOUT_UUID}.jsonl`);
  fs.copyFileSync(new URL('transcripts/normal-tool-final-turn.jsonl', FIXTURES), transcriptPath);
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

function userPromptPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: ROOT_SESSION,
    turn_id: TURN_1,
    transcript_path: transcriptPath,
    cwd: workspaceDir,
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
    prompt: 'Use the shell tool to run this exact command: echo fixture-tool-a. After it finishes, reply with exactly: FIXTURE-A-DONE',
    ...overrides,
  };
}

function postToolUsePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: ROOT_SESSION,
    turn_id: TURN_1,
    transcript_path: transcriptPath,
    cwd: workspaceDir,
    hook_event_name: 'PostToolUse',
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
    tool_name: 'Bash',
    tool_input: { command: ['echo', 'fixture-tool-a'] },
    tool_response: { exitCode: 0 },
    tool_use_id: TOOL_USE_ID,
    ...overrides,
  };
}

describe('Stop ingestion through the production orchestrator', () => {
  it('ingests the real fixture transcript into governance observations with a committed checkpoint', () => {
    const result = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      // 6 logical rows: 2 user turns + 3 assistant messages + 1 tool. The
      // second user channel (UserMessage completion) converges on the same
      // logical key — counted as duplicates, never second rows.
      expect(result.inserted).toBe(6);
      expect(result.duplicates).toBe(2);
      expect(result.lagBytes).toBe(0);
    }
    const listed = listGovernanceObservations({ workspaceDir, rolloutIdentity: ROLLOUT_UUID });
    if (!listed.ok) throw new Error('list failed');
    expect(listed.observations).toHaveLength(6);
    const keys = listed.observations.map((row) => row.logicalKey);
    expect(keys).toContain(`codex|${ROLLOUT_UUID}|${TURN_1}|user`);
    expect(keys).toContain(`codex|${ROLLOUT_UUID}|${TOOL_USE_ID}`);
    expect(keys.filter((key) => key.includes('msg_'))).toHaveLength(3);
    // No host-injected content anywhere.
    for (const row of listed.observations) {
      expect(row.visibleText ?? '').not.toContain('host-injected');
    }
    const checkpoint = readGovernanceCheckpoint({ workspaceDir, hostKind: 'codex', rolloutIdentity: ROLLOUT_UUID });
    expect(checkpoint && 'byteOffset' in checkpoint ? checkpoint : null).toMatchObject({
      byteOffset: fs.statSync(transcriptPath).size,
      cliVersion: '0.150.1',
      rootSessionId: ROOT_SESSION,
      incompleteTail: false,
    });
  });

  it('replaying the same Stop is idempotent: the checkpoint is at EOF, nothing re-reads or duplicates', () => {
    ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    const replay = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(replay.status).toBe('ok');
    if (replay.status === 'ok') {
      expect(replay.inserted).toBe(0);
      expect(replay.enriched).toBe(0);
      expect(replay.duplicates).toBe(0);
    }
    const listed = listGovernanceObservations({ workspaceDir, rolloutIdentity: ROLLOUT_UUID });
    if (!listed.ok) throw new Error('list failed');
    expect(listed.observations).toHaveLength(6);
    const keys = listed.observations.map((row) => row.logicalKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('live user/tool observations converge with the later transcript into one logical observation each', () => {
    const liveUser = ingestCodexConversation(userPromptPayload(), 'before_prompt_build', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(liveUser.status).toBe('ok');
    const liveTool = ingestCodexConversation(postToolUsePayload(), 'after_tool_call', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(liveTool.status).toBe('ok');
    const stop = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(stop.status).toBe('ok');
    const listed = listGovernanceObservations({ workspaceDir, rolloutIdentity: ROLLOUT_UUID });
    if (!listed.ok) throw new Error('list failed');
    const users = listed.observations.filter((row) => row.kind === 'user_turn');
    const tools = listed.observations.filter((row) => row.kind === 'tool_call');
    expect(users).toHaveLength(2); // turn 1 + turn 2 — the live turn-1 row was converged, not duplicated
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool?.toolUseId).toBe(TOOL_USE_ID);
    expect(tool?.transcriptRecordKey).toContain(`|13`); // enriched with the physical record identity
    expect(tool?.transcriptToolCallId).toBe('call_CYLni3uCUFlFtk3fQ3z1pxgJ'); // bridged model call id
  });

  it('resumes from the checkpoint after the transcript grows (restart continuation)', () => {
    // First Stop consumes the file up to EOF.
    ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    // A later turn is appended (the fixture already models a second turn;
    // instead simulate growth with a synthetic extra turn appended).
    const appended = JSON.stringify({ timestamp: '2026-08-28T14:10:00.000Z', ordinal: 40, type: 'event_msg', payload: { type: 'item_completed', thread_id: ROOT_SESSION, turn_id: '01a048af-9999-0000-0000-000000000001', item: { type: 'AgentMessage', id: 'msg_synthetic_final_1', content: [{ type: 'Text', text: 'grown later' }] } } });
    fs.appendFileSync(transcriptPath, `${appended}\n`);
    const second = ingestCodexConversation({ ...stopPayload(), turn_id: '01a048af-9999-0000-0000-000000000001' }, 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(second.status).toBe('ok');
    if (second.status === 'ok') expect(second.inserted).toBe(1);
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    expect(listed.observations.filter((row) => row.logicalKey === `codex|${ROLLOUT_UUID}|01a048af-9999-0000-0000-000000000001|msg_synthetic_final_1`)).toHaveLength(1);
  });

  it('an incomplete final line retries silently and completes on the next Stop', () => {
    // Cut the final line mid-JSON without a trailing newline.
    const full = readFileSync(transcriptPath, 'utf8');
    fs.writeFileSync(transcriptPath, full.slice(0, full.length - 30));
    const first = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(first.status).toBe('ok');
    if (first.status === 'ok') expect(first.warnings).toContain('transcript_incomplete_tail');
    const checkpoint = readGovernanceCheckpoint({ workspaceDir, hostKind: 'codex', rolloutIdentity: ROLLOUT_UUID });
    expect(checkpoint && 'incompleteTail' in checkpoint ? checkpoint.incompleteTail : null).toBe(true);
    // The append completes the line; the next Stop consumes it.
    fs.writeFileSync(transcriptPath, full);
    const second = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(second.status).toBe('ok');
    if (second.status === 'ok') expect(second.warnings).not.toContain('transcript_incomplete_tail');
    const finalCheckpoint = readGovernanceCheckpoint({ workspaceDir, hostKind: 'codex', rolloutIdentity: ROLLOUT_UUID });
    expect(finalCheckpoint && 'byteOffset' in finalCheckpoint ? finalCheckpoint.byteOffset : 0).toBe(fs.statSync(transcriptPath).size);
  });

  it('a stable malformed record degrades loudly and holds the checkpoint at the record', () => {
    const full = readFileSync(transcriptPath, 'utf8');
    const lines = full.split('\n');
    lines.splice(9, 0, '{"broken":');
    fs.writeFileSync(transcriptPath, lines.join('\n'));
    const result = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') expect(result.reason).toBe('transcript_record_malformed');
    const checkpoint = readGovernanceCheckpoint({ workspaceDir, hostKind: 'codex', rolloutIdentity: ROLLOUT_UUID });
    expect(checkpoint && 'lastDegradationReason' in checkpoint ? checkpoint.lastDegradationReason : null).toBe('transcript_record_malformed');
  });

  it('a truncated/replaced transcript below the checkpoint degrades as checkpoint_inconsistent', () => {
    ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    fs.writeFileSync(transcriptPath, '{"ordinal":0}\n');
    const result = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') expect(result.reason).toBe('checkpoint_inconsistent');
  });
});

describe('version guard through the real transcript session_meta', () => {
  it('an older unsupported Codex version degrades explicitly without any observation writes', () => {
    fs.copyFileSync(new URL('transcripts/min-version-0.148.0.jsonl', FIXTURES).pathname.replace(/^\/([A-Z]:)/, '$1'), transcriptPath);
    const bytes = readFileSync(new URL('transcripts/min-version-0.148.0.jsonl', FIXTURES), 'utf8');
    fs.writeFileSync(transcriptPath, bytes.replace('"cli_version":"0.148.0"', '"cli_version":"0.147.0"'));
    const result = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') {
      expect(result.reason).toContain('unsupported_codex_version');
      expect(result.nextAction).toContain('contract probe');
    }
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    expect(listed.observations).toHaveLength(0);
  });

  it('a newer unverified Codex version degrades explicitly instead of guessing the schema', () => {
    const bytes = readFileSync(transcriptPath, 'utf8');
    fs.writeFileSync(transcriptPath, bytes.replace('"cli_version":"0.150.1"', '"cli_version":"0.151.0"'));
    const result = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') expect(result.reason).toContain('codex_version_unverified:0.151.0');
  });

  it('the minimum supported version 0.148.0 ingests (no content_item_kinds in that contract)', () => {
    fs.copyFileSync(fs.realpathSync(new URL('transcripts/min-version-0.148.0.jsonl', FIXTURES)), transcriptPath);
    const result = ingestCodexConversation({ ...stopPayload(), turn_id: '01a048b0-8e88-7f21-95ce-e33e19511ad4' }, 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('ok');
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    const kinds = listed.observations.map((row) => row.kind).sort();
    expect(kinds).toEqual(['assistant_turn', 'assistant_turn', 'tool_call', 'user_turn']);
  });
});

describe('degradation contract (SPEC §20)', () => {
  it('transcript_path null degrades neutrally without touching the filesystem', () => {
    const port = { read: () => { throw new Error('must_not_read'); } };
    setCodexTranscriptPortForTest(port);
    const result = ingestCodexConversation(stopPayload({ transcript_path: null }), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') expect(result.reason).toBe('transcript_unavailable');
  });

  it('a path outside the Codex home is refused', () => {
    const result = ingestCodexConversation(stopPayload({ transcript_path: path.join(os.tmpdir(), `outside-${ROLLOUT_UUID}.jsonl`) }), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') expect(result.reason).toBe('transcript_path_invalid');
  });

  it('a configured CODEX_HOME that does not exist degrades explicitly', () => {
    const result = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: path.join(os.tmpdir(), 'pd-codex-home-missing') } });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') expect(result.reason).toBe('codex_home_unavailable');
  });

  it('a missing workspace trajectory.db degrades with an actionable next step', () => {
    fs.rmSync(path.join(workspaceDir, '.state', 'trajectory.db'));
    const result = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') expect(result.reason).toBe('trajectory_db_not_found');
  });

  it('fork rollouts stay isolated: a fork transcript ingests under its own rollout identity with parent lineage', () => {
    const forkUuid = '01a048af-336d-7211-b423-eafa97450ea3';
    const forkPath = path.join(path.dirname(transcriptPath), `rollout-2026-08-28T22-03-56-${forkUuid}.jsonl`);
    fs.copyFileSync(fs.realpathSync(new URL('transcripts/fork.jsonl', FIXTURES)), forkPath);
    const result = ingestCodexConversation(
      { ...stopPayload(), transcript_path: forkPath, session_id: forkUuid, turn_id: '01a048af-3440-7c22-97e9-af8d032ea9b0' },
      'turn_complete',
      { workspaceDir, env: { CODEX_HOME: codexHome } },
    );
    expect(result.status).toBe('ok');
    // Ingest the parent rollout too — fork and parent observations never merge.
    ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    const forkRows = listed.observations.filter((row) => row.rolloutIdentity === forkUuid);
    const parentRows = listed.observations.filter((row) => row.rolloutIdentity === ROLLOUT_UUID);
    expect(forkRows.length).toBeGreaterThan(0);
    expect(parentRows.length).toBeGreaterThan(0);
    for (const row of forkRows) {
      expect(row.rootSessionId).toBe(forkUuid); // fork session_meta: own session id, forked_from records the parent
    }
  });

  it('subagent rollouts stay isolated from the parent rollout (G1 collision trap)', () => {
    const childUuid = '01a048b0-2f1a-7b61-a630-fdfe2d3eedfe';
    const childPath = path.join(path.dirname(transcriptPath), `rollout-2026-08-28T22-05-01-${childUuid}.jsonl`);
    fs.copyFileSync(fs.realpathSync(new URL('transcripts/subagent-child.jsonl', FIXTURES)), childPath);
    const result = ingestCodexConversation(
      { ...stopPayload(), transcript_path: childPath, session_id: '01a048af-f372-7c33-87be-e1c8b2633c9a' },
      'turn_complete',
      { workspaceDir, env: { CODEX_HOME: codexHome } },
    );
    expect(result.status).toBe('ok');
    ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    const childRows = listed.observations.filter((row) => row.rolloutIdentity === childUuid);
    expect(childRows.length).toBe(2); // task prompt + final answer
    // Root lineage is the shared parent thread id, but identities never collide.
    for (const row of childRows) expect(row.rootSessionId).toBe('01a048af-f372-7c33-87be-e1c8b2633c9a');
  });
});

describe('hard privacy invariant: flag-off means zero transcript reads (SPEC §10)', () => {
  it('the ingest entry is never reached when the flag is off — spied port receives zero calls', async () => {
    const { processHookInvocation } = await import('../../src/pd-hook.js');
    const { getDefaultPdConfig } = await import('@principles/core/runtime-v2');
    const flagOffWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-flagoff-'));
    try {
      fs.mkdirSync(path.join(flagOffWorkspace, '.pd'), { recursive: true });
      // A real store target exists, so "no writes" is provable, not vacuous.
      fs.mkdirSync(path.join(flagOffWorkspace, '.state'), { recursive: true });
      fs.writeFileSync(path.join(flagOffWorkspace, '.state', 'trajectory.db'), '');
      const config = getDefaultPdConfig();
      config.features['host.codex'].enabled = true;
      fs.writeFileSync(path.join(flagOffWorkspace, '.pd', 'config.yaml'), JSON.stringify(config));
      // codex_conversation_ingestion is default-off in the registry — no key written.
      expect(config.features['codex_conversation_ingestion']).toMatchObject({ enabled: false });

      const calls: string[] = [];
      setCodexTranscriptPortForTest({
        read: (canonicalPath: string) => { calls.push(canonicalPath); return { bytes: Buffer.alloc(0), fileSize: 0 }; },
      });
      const payload = JSON.stringify({ ...stopPayload(), cwd: flagOffWorkspace });
      const result = await processHookInvocation(payload, { CODEX_HOME: codexHome }, flagOffWorkspace);
      expect(result.stdout).toEqual({});
      expect(result.exitCode).toBe(0);
      // Non-noisy structured fact: exactly one bounded line, Stop-only.
      expect(result.stderr).toHaveLength(1);
      expect(result.stderr[0]).toContain('reason=feature_disabled');
      expect(calls).toEqual([]);
      // No observation side effects either.
      const listed = listGovernanceObservations({ workspaceDir: flagOffWorkspace });
      if (!listed.ok) throw new Error('list failed');
      expect(listed.observations).toHaveLength(0);
    } finally {
      fs.rmSync(flagOffWorkspace, { recursive: true, force: true });
    }
  });

  it('negative control: with the flag explicitly enabled the same payload DOES reach the transcript boundary', async () => {
    const { processHookInvocation } = await import('../../src/pd-hook.js');
    const { getDefaultPdConfig } = await import('@principles/core/runtime-v2');
    const flagOnWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-flagon-'));
    try {
      fs.mkdirSync(path.join(flagOnWorkspace, '.pd'), { recursive: true });
      fs.mkdirSync(path.join(flagOnWorkspace, '.state'), { recursive: true });
      fs.writeFileSync(path.join(flagOnWorkspace, '.state', 'trajectory.db'), '');
      const config = getDefaultPdConfig();
      config.features['host.codex'].enabled = true;
      config.features['codex_conversation_ingestion'] = { category: 'quiet', enabled: true };
      fs.writeFileSync(path.join(flagOnWorkspace, '.pd', 'config.yaml'), JSON.stringify(config));

      const calls: string[] = [];
      const identities: Array<unknown> = [];
      const fixtureBytes = readFileSync(transcriptPath);
      setCodexTranscriptPortForTest({
        read: (request: { canonicalPath: string; expectedIdentity?: { dev: number; ino: number; size: number; mtimeMs: number } }) => {
          const observedPath: string = request.canonicalPath;
          calls.push(observedPath);
          identities.push(request.expectedIdentity);
          return { bytes: fixtureBytes, fileSize: fixtureBytes.length };
        },
      });
      const payload = JSON.stringify({ ...stopPayload(), cwd: flagOnWorkspace });
      const result = await processHookInvocation(payload, { CODEX_HOME: codexHome }, flagOnWorkspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual({}); // Stop: no hookSpecificOutput — empty stdout contract
      const { realpathSync, statSync } = await import('node:fs');
      const expectedCanonical = (() => { try { return realpathSync.native(transcriptPath); } catch { return realpathSync(transcriptPath); } })();
      expect(calls).toEqual([expectedCanonical]);
      // The orchestrator forwards the validator's captured identity to the
      // read boundary (post-open revalidation contract, PR #1455 review P1).
      const forwarded = identities[0] as { dev: number; ino: number; size: number; mtimeMs: number };
      expect(forwarded).toBeDefined();
      const currentStats = statSync(expectedCanonical);
      expect(forwarded.size).toBe(currentStats.size);
      expect(forwarded.ino).toBe(Number(currentStats.ino));
      const listed = listGovernanceObservations({ workspaceDir: flagOnWorkspace });
      if (!listed.ok) throw new Error('list failed');
      expect(listed.observations.length).toBe(6);
    } finally {
      fs.rmSync(flagOnWorkspace, { recursive: true, force: true });
    }
  });

  it('refuses a transcript replaced after validation with a structured transcript_replaced degradation (post-open TOCTOU, PR #1455 review P1)', async () => {
    const { processHookInvocation } = await import('../../src/pd-hook.js');
    const { getDefaultPdConfig } = await import('@principles/core/runtime-v2');
    const { TranscriptReplacedError } = await import('../../src/ingestion/transcript-decoder.js');
    const swappedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-swap-'));
    try {
      fs.mkdirSync(path.join(swappedWorkspace, '.pd'), { recursive: true });
      fs.mkdirSync(path.join(swappedWorkspace, '.state'), { recursive: true });
      fs.writeFileSync(path.join(swappedWorkspace, '.state', 'trajectory.db'), '');
      const config = getDefaultPdConfig();
      config.features['host.codex'].enabled = true;
      config.features['codex_conversation_ingestion'] = { category: 'quiet', enabled: true };
      fs.writeFileSync(path.join(swappedWorkspace, '.pd', 'config.yaml'), JSON.stringify(config));

      // A port that simulates the raced window: by the time it opens the file,
      // the object behind the path is NOT the one the validator approved.
      setCodexTranscriptPortForTest({
        read: () => { throw new TranscriptReplacedError(); },
      });
      const payload = JSON.stringify({ ...stopPayload(), cwd: swappedWorkspace });
      const result = await processHookInvocation(payload, { CODEX_HOME: codexHome }, swappedWorkspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual({});
      expect(result.stderr[0]).toContain('reason=transcript_replaced');
      expect(result.stderr[0]).toContain('nextAction=');
      const listed = listGovernanceObservations({ workspaceDir: swappedWorkspace });
      if (!listed.ok) throw new Error('list failed');
      expect(listed.observations).toHaveLength(0); // zero bytes were ingested from the unproven object
    } finally {
      setCodexTranscriptPortForTest(null);
      fs.rmSync(swappedWorkspace, { recursive: true, force: true });
    }
  });
});
