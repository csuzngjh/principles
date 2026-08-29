import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeTranscriptWindow } from '../../src/ingestion/transcript-decoder.js';

/**
 * Slice A decoder contract tests against the REAL frozen G1 fixtures
 * (packages/codex-adapter/tests/fixtures/g1-contract/). These are the
 * identity traps the SPEC pins: subagent rollout identity, the
 * tool_use_id/call_id bridge, fork lineage, compaction/rollback markers,
 * and the two distinguishable failure modes.
 */

const FIXTURES = new URL('../fixtures/g1-contract/', import.meta.url);

function readTranscriptText(relative: string): string {
  return readFileSync(new URL(relative, FIXTURES), 'utf8');
}

function decodeFull(relative: string, rolloutIdentity = 'rollout-fixture-uuid') {
  const bytes = Buffer.from(readTranscriptText(relative), 'utf8');
  return decodeTranscriptWindow({
    bytes,
    fileOffset: 0,
    byteBoundReached: false,
    rolloutIdentity,
    fallbackRootSessionId: null,
    nowIso: '2026-08-29T12:00:00.000Z',
  });
}

function decodeWindow(text: string, overrides: { fileOffset?: number; byteBoundReached?: boolean; fallbackRootSessionId?: string | null } = {}) {
  return decodeTranscriptWindow({
    bytes: Buffer.from(text, 'utf8'),
    fileOffset: overrides.fileOffset ?? 0,
    byteBoundReached: overrides.byteBoundReached ?? false,
    rolloutIdentity: 'r',
    fallbackRootSessionId: overrides.fallbackRootSessionId ?? null,
    nowIso: '2026-08-29T12:00:00.000Z',
  });
}

const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const TURN_1 = '01a048ae-b344-7eb2-804b-a2fa34302fb3';
const TURN_2 = '01a048af-8935-7060-8b01-c4c5b6a7f5c7';
const TOOL_USE_ID = 'exec-db1bff81-f42e-45f8-91ce-e87480fa15d9';
const MODEL_CALL_ID = 'call_CYLni3uCUFlFtk3fQ3z1pxgJ';

describe('normal + tool + final turn projection (G1 normal-tool-final-turn fixture)', () => {
  const decoded = decodeFull('transcripts/normal-tool-final-turn.jsonl');

  it('projects the visible turns from both user channels, assistant completions, and the tool bridge', () => {
    // User turns arrive twice (response_item user.text + item_completed
    // UserMessage — same logical key, converged at the store); assistant
    // commentary/final come from AgentMessage completions; the tool from the
    // CommandExecution bridge.
    const kinds = decoded.observations.map((observation) => observation.kind).sort();
    expect(kinds).toEqual(['assistant_turn', 'assistant_turn', 'assistant_turn', 'tool_call', 'user_turn', 'user_turn', 'user_turn', 'user_turn']);
  });

  it('excludes host-injected user-role context and keeps only genuine visible user turns', () => {
    const users = decoded.observations.filter((observation) => observation.kind === 'user_turn');
    const distinctTurns = new Set(users.map((observation) => observation.hostTurnId));
    expect(distinctTurns).toEqual(new Set([TURN_1, TURN_2]));
    expect(users[0]?.visibleText).toContain('echo fixture-tool-a');
    for (const user of users) {
      expect(user.visibleText).not.toContain('host-injected');
    }
  });

  it('derives logical keys per SPEC §6 and root lineage from session_meta', () => {
    const user1 = decoded.observations.find((observation) => observation.logicalObservationKey === `codex|rollout-fixture-uuid|${TURN_1}|user`);
    expect(user1).toBeDefined();
    expect(user1?.rootSessionId).toBe(ROOT_SESSION);
    expect(decoded.rolloutMeta.rootSessionId).toBe(ROOT_SESSION);
    expect(decoded.rolloutMeta.cliVersion).toBe('0.150.1');
    const commentary = decoded.observations.find((observation) => observation.logicalObservationKey === `codex|rollout-fixture-uuid|${TURN_1}|msg_0f3aefbe2e7de61f016a919539666087d0926fa1baf3fb9139`);
    expect(commentary?.phase).toBe('commentary');
    expect(commentary?.visibleText).toContain('running the exact command');
  });

  it('bridges the hook tool_use_id space through the item_completed CommandExecution record', () => {
    const tool = decoded.observations.find((observation) => observation.logicalObservationKey === `codex|rollout-fixture-uuid|${TOOL_USE_ID}`);
    expect(tool).toBeDefined();
    expect(tool?.transcriptToolCallId).toBe(MODEL_CALL_ID);
    expect(tool?.hostTurnId).toBe(TURN_1);
    if (tool?.toolFacts && typeof tool.toolFacts === 'object') {
      const facts = tool.toolFacts as { exitCode?: number | null; toolName?: string | null };
      expect(facts.exitCode).toBe(0);
      expect(facts.toolName).toBe('exec');
    }
    // The model-level ids themselves are never observation identity.
    const keys = decoded.observations.map((observation) => observation.logicalObservationKey);
    expect(keys.some((key) => key.includes(MODEL_CALL_ID))).toBe(false);
    expect(keys.some((key) => key.includes('ctc_'))).toBe(false);
  });

  it('consumes the whole fixture and reports EOF', () => {
    expect(decoded.stop).toEqual({ kind: 'eof' });
    expect(decoded.nextByteOffset).toBe(Buffer.byteLength(readTranscriptText('transcripts/normal-tool-final-turn.jsonl'), 'utf8'));
  });
});

describe('lineage traps (G1 fixtures)', () => {
  it('subagent rollout: root lineage is the parent thread id; agent identity and depth are captured; ordinals restart in the child space', () => {
    const decoded = decodeFull('transcripts/subagent-child.jsonl', 'child-rollout-uuid');
    expect(decoded.rolloutMeta.rootSessionId).toBe('01a048af-f372-7c33-87be-e1c8b2633c9a'); // parent thread id — the collision trap
    expect(decoded.rolloutMeta.parentRolloutIdentity).toBe('01a048af-f372-7c33-87be-e1c8b2633c9a');
    expect(decoded.rolloutMeta.agentIdentity).toBe('Hume');
    expect(decoded.rolloutMeta.agentDepth).toBe(1);
    // Physical record keys use the child rollout identity — never shared with the parent.
    for (const observation of decoded.observations) {
      expect(observation.transcriptRecordKey?.startsWith('codex|child-rollout-uuid|')).toBe(true);
    }
    // The subagent task prompt (user.text in the child file) and its final
    // answer are both projected; host-injected records are not.
    const users = decoded.observations.filter((observation) => observation.kind === 'user_turn');
    expect(users).toHaveLength(1);
    expect(users[0]?.visibleText).toContain('spawn_agent');
    const assistants = decoded.observations.filter((observation) => observation.kind === 'assistant_turn');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.phase).toBe('final_answer');
  });

  it('fork rollout: parent recorded via forked_from_id; ordinals continue the parent sequence', () => {
    const decoded = decodeFull('transcripts/fork.jsonl', 'fork-rollout-uuid');
    expect(decoded.rolloutMeta.parentRolloutIdentity).toBe(ROOT_SESSION);
    const ordinals = decoded.observations.map((observation) => Number(observation.transcriptRecordKey?.split('|')[2]));
    expect(Math.min(...ordinals)).toBeGreaterThanOrEqual(20);
  });

  it('minimum supported version transcript (0.148.0) decodes with the same contract', () => {
    const decoded = decodeFull('transcripts/min-version-0.148.0.jsonl', 'min-rollout-uuid');
    expect(decoded.rolloutMeta.cliVersion).toBe('0.148.0');
    expect(decoded.observations.some((observation) => observation.kind === 'user_turn')).toBe(true);
  });
});

describe('marker records (G1 §6)', () => {
  it('a compacted marker never re-imports replacement_history as new turns', () => {
    const decoded = decodeFull('transcripts/compacted-marker.jsonl');
    expect(decoded.observations).toHaveLength(0);
    expect(decoded.compactionTimestamp).not.toBeNull();
  });

  it('a ThreadRolledBack marker yields a rollback-turns signal', () => {
    const marker = JSON.stringify({ timestamp: '2026-08-28T14:10:00.000Z', ordinal: 30, type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 3 } });
    const decoded = decodeWindow(`${marker}\n`);
    expect(decoded.rollbackTurns).toEqual([3]);
    expect(decoded.observations).toHaveLength(0);
    expect(decoded.stop).toEqual({ kind: 'eof' });
  });
});

describe('failure modes are distinguishable (SPEC §14)', () => {
  it('a stable malformed completed record stops decoding at it without advancing', () => {
    const text = readTranscriptText('transcripts/malformed-line.jsonl');
    const decoded = decodeWindow(text);
    expect(decoded.stop.kind).toBe('malformed');
    // Everything before the malformed line was projected and the cursor
    // stops exactly at the malformed line start (decoder-consistent byte
    // accounting over the raw lines).
    const lines = text.split('\n');
    const badIndex = lines.findIndex((line) => {
      if (line.trim().length === 0) return false;
      try { JSON.parse(line); return false; } catch { return true; }
    });
    expect(badIndex).toBeGreaterThan(0);
    const malformedStart = Buffer.byteLength(lines.slice(0, badIndex).map((line) => `${line}\n`).join(''), 'utf8');
    expect(decoded.nextByteOffset).toBe(malformedStart);
    expect(decoded.observations.length).toBeGreaterThan(0);
  });

  it('an incomplete final line is a transient tail: no advance past the previous record', () => {
    const text = readTranscriptText('transcripts/incomplete-tail.jsonl');
    const decoded = decodeWindow(text);
    expect(decoded.stop.kind).toBe('incomplete_tail');
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    expect(decoded.nextByteOffset).toBe(Buffer.byteLength(complete, 'utf8'));

    // Retry after the append completes (close the cut string + both open
    // objects): the same window now reaches EOF.
    const completed = `${text}"}}\n`;
    const retry = decodeWindow(completed, { fileOffset: decoded.nextByteOffset, fallbackRootSessionId: 'root' });
    expect(retry.stop.kind).toBe('eof');
  });

  it('a byte-bound cut mid-line leaves the partial line wholly unread as bounded lag', () => {
    const text = readTranscriptText('transcripts/normal-tool-final-turn.jsonl');
    const cutBytes = Buffer.from(text, 'utf8').subarray(0, Math.floor(Buffer.byteLength(text, 'utf8') * 0.6));
    const decoded = decodeTranscriptWindow({
      bytes: cutBytes,
      fileOffset: 0,
      byteBoundReached: true,
      rolloutIdentity: 'r',
      fallbackRootSessionId: null,
      nowIso: '2026-08-29T12:00:00.000Z',
    });
    expect(decoded.stop.kind).toBe('byte_bound');
    const cutText = cutBytes.toString('utf8');
    const consumed = cutText.slice(0, cutText.lastIndexOf('\n') + 1);
    expect(decoded.nextByteOffset).toBe(Buffer.byteLength(consumed, 'utf8'));
  });

  it('a single record larger than the window is an explicit oversized degradation, never an infinite stall past it', () => {
    const huge = `{"padding":"${'x'.repeat(256)}"}}`;
    const decoded = decodeWindow(huge, { byteBoundReached: true });
    expect(decoded.stop.kind).toBe('oversized_record');
    expect(decoded.nextByteOffset).toBe(0);
  });

  it('an unknown record type is skipped with a bounded warning and DOES advance', () => {
    const unknown = JSON.stringify({ timestamp: '2026-08-28T14:00:00.000Z', ordinal: 5, type: 'some_future_record', payload: { anything: true } });
    const text = `${unknown}\n`;
    const decoded = decodeWindow(text);
    expect(decoded.observations).toHaveLength(0);
    expect(decoded.warnings).toContain('unknown_record_type_skipped:some_future_record');
    expect(decoded.stop).toEqual({ kind: 'eof' });
    expect(decoded.nextByteOffset).toBe(Buffer.byteLength(text, 'utf8'));
  });
});

describe('privacy boundary (SPEC §12)', () => {
  it('hidden reasoning and developer-role records are never projected', () => {
    const reasoning = JSON.stringify({ timestamp: '2026-08-28T14:00:00.000Z', ordinal: 3, type: 'response_item', payload: { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAAAAB-secret-blob' } });
    const developer = JSON.stringify({ timestamp: '2026-08-28T14:00:01.000Z', ordinal: 4, type: 'response_item', payload: { type: 'message', id: 'msg_dev', role: 'developer', content: [{ type: 'input_text', text: 'system directive' }], internal_chat_message_metadata_passthrough: { turn_id: 't1', content_item_kinds: ['generic.developer_instructions'] } } });
    const world = JSON.stringify({ timestamp: '2026-08-28T14:00:02.000Z', ordinal: 6, type: 'world_state', payload: { environment: 'snapshot' } });
    const text = `${reasoning}\n${developer}\n${world}\n`;
    const decoded = decodeWindow(text);
    expect(decoded.observations).toHaveLength(0);
    expect(decoded.warnings).toHaveLength(0); // world_state is silently dropped, not warned
  });

  it('a user message without turn identity is skipped with a bounded warning (identity before content)', () => {
    const orphan = JSON.stringify({ timestamp: '2026-08-28T14:00:00.000Z', ordinal: 9, type: 'response_item', payload: { type: 'message', id: 'msg_orphan', role: 'user', content: [{ type: 'input_text', text: 'orphan text' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } });
    const decoded = decodeWindow(`${orphan}\n`);
    expect(decoded.observations).toHaveLength(0);
    expect(decoded.warnings[0]).toContain('observation_skipped_missing_identity');
  });
});
