/**
 * WorkBuddy transcript-decoder contract tests (PRI-1171 P2; tech design
 * §5.2–§5.4, §10 test matrix).
 *
 * The variant baseline fixture freezes the cross-period forensic shape
 * census (docs/plans/2026-08-28-workbuddy-session-transcript-access.md §8.1)
 * plus the 2026-11-11 `session-meta` head record: every recorded variant
 * must decode with the mapped observation semantics and NO silent skips.
 * Byte-level windows (malformed / incomplete tail / tail-at-EOF / oversized
 * / batch bound) are constructed inline for exact checkpoint math.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeWorkbuddyTranscriptWindow, type DecodeWorkbuddyWindowInput } from '../../src/ingestion/transcript-decoder.js';
import { CONVERSATION_INGESTION_MAX_BATCH_RECORDS } from '@principles/host-runtime';

const SESSION = '11111111-2222-4333-8444-555555555555';
const NOW_ISO = '2026-11-11T00:00:00.000Z';
const FIXTURE = readFileSync(new URL('../fixtures/ingestion/variant-baseline.jsonl', import.meta.url));

function decodeFixture(): ReturnType<typeof decodeWorkbuddyTranscriptWindow> {
  return decodeWorkbuddyTranscriptWindow({
    bytes: FIXTURE,
    fileOffset: 0,
    byteBoundReached: false,
    sessionIdentity: SESSION,
    startOrdinal: 0,
    nowIso: NOW_ISO,
  });
}

function line(record: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
}

describe('variant baseline fixture (§8.1 census + session-meta)', () => {
  const delta = decodeFixture();

  it('decodes to eof with every record consumed', () => {
    expect(delta.stop).toEqual({ kind: 'eof' });
    expect(delta.nextByteOffset).toBe(FIXTURE.length);
    expect(delta.lastOrdinal).toBe(17); // 18 non-blank records, ordinals 0..17
  });

  it('projects user and assistant messages (all five §8.1 variants)', () => {
    const users = delta.observations.filter((o) => o.kind === 'user_turn');
    const assistants = delta.observations.filter((o) => o.kind === 'assistant_turn');
    expect(users.map((o) => o.visibleText)).toEqual([
      'synthetic user turn one',
      'synthetic user turn four (status variant)',
      'synthetic user turn five (message-field variant)',
      'synthetic compaction summary (append-only marker)',
    ]);
    expect(assistants).toHaveLength(2);
    // providerData.messageId is the host turn container; model lands in facts.
    expect(assistants[0]).toMatchObject({ hostTurnId: 'msg-0002', assistantItemId: 'aaaaaaaa-0000-4000-8000-000000000002', completeness: 'complete', toolFacts: { model: 'synth-model-3' } });
    // logicalParentId legacy variant: tolerated, ignored, assistant still complete.
    expect(assistants[1]).toMatchObject({ hostTurnId: 'aaaaaaaa-0000-4000-8000-000000000003', completeness: 'complete' });
    // Record without providerData falls back to its own id as the turn container.
    expect(users[0]?.hostTurnId).toBe('aaaaaaaa-0000-4000-8000-000000000001');
  });

  it('maps timestamps epoch-ms → ISO observedAt', () => {
    expect(delta.observations[0]?.observedAt).toBe(new Date(1780000001000).toISOString());
  });

  it('attributes reasoning via the in-window parentId chain and never guesses (§4.8)', () => {
    const reasoning = delta.observations.filter((o) => o.kind === 'reasoning');
    expect(reasoning).toHaveLength(2);
    expect(reasoning[0]).toMatchObject({
      assistantItemId: 'aaaaaaaa-0000-4000-8000-000000000002',
      visibleText: 'synthetic reasoning six owned by assistant two',
      completeness: 'complete',
    });
    // No parentId + text recovered from rawContent (content was an empty array):
    // partial + phase unattributed — attribution is never fabricated.
    expect(reasoning[1]).toMatchObject({
      visibleText: 'synthetic reasoning seven from rawContent, no parent',
      completeness: 'partial',
      phase: 'unattributed',
    });
    expect(reasoning[1]?.assistantItemId).toBeUndefined();
  });

  it('pairs tool results by callId and marks the unpaired sides partial (§5.3)', () => {
    const tools = delta.observations.filter((o) => o.kind === 'tool_call');
    expect(tools).toHaveLength(4);
    const paired = tools.find((o) => o.toolUseId === 'chatcmpl-tool-0008');
    expect(paired).toMatchObject({
      completeness: 'complete',
      toolFacts: { toolName: 'Bash', params: '{"command":"synth --version"}', model: 'synth-model-3', resultStatus: 'completed', output: 'synth 1.0.0' },
    });
    // In-flight calls (no result yet) stay partial — one observation per
    // execution, anchored on the callId-derived logical key so a result in a
    // later window can complete the same row.
    expect(tools.filter((o) => o.completeness === 'partial').map((o) => o.toolUseId).sort()).toEqual(
      ['chatcmpl-tool-0010', 'chatcmpl-tool-0009'].sort(),
    );
    const orphan = tools.find((o) => o.logicalObservationKey === `wb|${SESSION}|call:chatcmpl-tool-9999`);
    expect(orphan).toMatchObject({ toolUseId: 'chatcmpl-tool-9999', completeness: 'complete', toolFacts: { toolName: 'Grep', resultStatus: 'failed', output: 'synthetic orphan result' } });
  });

  it('builds logical keys from callId for tool calls and record ids otherwise', () => {
    for (const observation of delta.observations) {
      expect(observation.logicalObservationKey).toMatch(new RegExp(`^wb\\|${SESSION}\\|(?:call:[\\w-]+|[0-9a-f-]{36})$`));
      expect(observation.transcriptRecordKey).toMatch(new RegExp(`^wb\\|${SESSION}\\|\\d+$`));
      expect(observation.hostKind).toBe('workbuddy');
      expect(observation.rolloutIdentity).toBe(SESSION);
      expect(observation.rootSessionId).toBe(SESSION);
      expect(observation.source).toBe('transcript');
    }
  });

  it('skips structural types with counted warnings — never silently (rc-9)', () => {
    expect(delta.warnings).toEqual([
      'wb_skipped:session-meta:1',
      'wb_skipped:file-history-snapshot:1',
      'wb_skipped:ai-title:1',
      'wb_fork_notice:1',
      'wb_compaction_marker:1',
      'wb_unknown_record_type:future-record:1',
      'wb_unpaired_tool_result:1',
    ]);
  });
});

describe('byte-level windows (seam stop taxonomy)', () => {
  const base = { sessionIdentity: SESSION, nowIso: NOW_ISO };

  it('holds the checkpoint at an unparseable unterminated tail at EOF (transient flush boundary)', () => {
    const good = line({ id: 'aaaaaaaa-0000-4000-8000-000000000021', timestamp: 1780000021000, type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] });
    const tail = Buffer.from('{"id":"broken","type":"mess', 'utf8'); // no trailing newline, unparseable — host mid-write
    const bytes = Buffer.concat([good, tail]);
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes, fileOffset: 0, byteBoundReached: false, startOrdinal: 0 });
    expect(delta.stop).toEqual({ kind: 'incomplete_tail' });
    expect(delta.observations).toHaveLength(1);
    expect(delta.nextByteOffset).toBe(good.length);
  });

  it('stops at a newline-terminated unparseable line mid-file as stable malformed', () => {
    const first = line({ id: 'aaaaaaaa-0000-4000-8000-000000000023', timestamp: 1780000023000, type: 'message', role: 'user', content: [{ type: 'input_text', text: 'committed before the malformed line' }] });
    const merged = Buffer.from(`{"id":"broken","type":"mess${JSON.stringify({ id: 'aaaaaaaa-0000-4000-8000-000000000024', type: 'message', role: 'user' })}\n`, 'utf8');
    const after = line({ id: 'aaaaaaaa-0000-4000-8000-000000000025', timestamp: 1780000025000, type: 'ai-title', aiTitle: 'a' });
    const bytes = Buffer.concat([first, merged, after]);
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes, fileOffset: 0, byteBoundReached: false, startOrdinal: 0 });
    expect(delta.stop).toEqual({ kind: 'malformed', ordinal: 1 });
    // Records BEFORE the malformed line commit; the checkpoint parks at it.
    expect(delta.observations).toHaveLength(1);
    expect(delta.nextByteOffset).toBe(first.length);
  });

  it('stops at a newline-terminated unparseable line as malformed with its would-be ordinal', () => {
    const good = line({ id: 'aaaaaaaa-0000-4000-8000-000000000031', timestamp: 1780000031000, type: 'ai-title', aiTitle: 't' });
    const bad = Buffer.from('not-json-at-all\n', 'utf8');
    const bytes = Buffer.concat([good, bad]);
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes, fileOffset: 0, byteBoundReached: false, startOrdinal: 5 });
    expect(delta.stop).toEqual({ kind: 'malformed', ordinal: 6 });
    expect(delta.nextByteOffset).toBe(good.length);
    expect(delta.lastOrdinal).toBe(5);
  });

  it('treats a type-less JSON line as malformed (flat envelope contract)', () => {
    const bytes = Buffer.from('{"id":"x","timestamp":1}\n', 'utf8');
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes, fileOffset: 0, byteBoundReached: false, startOrdinal: 0 });
    expect(delta.stop.kind).toBe('malformed');
    expect(delta.observations).toHaveLength(0);
  });

  it('consumes a parseable final line without a trailing newline and advances to EOF', () => {
    const terminated = line({ id: 'aaaaaaaa-0000-4000-8000-000000000041', timestamp: 1780000041000, type: 'ai-title', aiTitle: 'a' });
    const flush = Buffer.from(JSON.stringify({ id: 'aaaaaaaa-0000-4000-8000-000000000042', timestamp: 1780000042000, type: 'ai-title', aiTitle: 'b' }), 'utf8');
    const bytes = Buffer.concat([terminated, flush]);
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes, fileOffset: 0, byteBoundReached: false, startOrdinal: 0 });
    expect(delta.stop).toEqual({ kind: 'eof' });
    expect(delta.nextByteOffset).toBe(bytes.length);
    expect(delta.warnings).toEqual(['wb_skipped:ai-title:2']);
  });

  it('reports bounded lag when the window is cut mid-line by the byte bound', () => {
    const first = line({ id: 'aaaaaaaa-0000-4000-8000-000000000051', timestamp: 1780000051000, type: 'ai-title', aiTitle: 'a' });
    const secondHalf = Buffer.from(JSON.stringify({ id: 'aaaaaaaa-0000-4000-8000-000000000052', timestamp: 1780000052000, type: 'ai-title', aiTitle: 'b' }).slice(0, 20), 'utf8');
    const bytes = Buffer.concat([first, secondHalf]);
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes, fileOffset: 0, byteBoundReached: true, startOrdinal: 0 });
    expect(delta.stop).toEqual({ kind: 'byte_bound' });
    expect(delta.nextByteOffset).toBe(first.length);
  });

  it('reports oversized_record when the whole window holds no newline', () => {
    const bytes = Buffer.from('{"id":"huge","type":"message","role":"user","content":[{"type":"input_text","text":"x'.padEnd(64, 'y'), 'utf8');
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes, fileOffset: 10, byteBoundReached: true, startOrdinal: 0 });
    expect(delta.stop).toEqual({ kind: 'oversized_record' });
    expect(delta.nextByteOffset).toBe(10); // nothing consumed
  });

  it('stops at the batch record bound and holds the checkpoint at the next record', () => {
    const one = line({ id: 'aaaaaaaa-0000-4000-8000-000000000061', timestamp: 1780000061000, type: 'ai-title', aiTitle: 't' });
    const bytes = Buffer.concat(Array.from({ length: CONVERSATION_INGESTION_MAX_BATCH_RECORDS + 5 }, () => one));
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes, fileOffset: 0, byteBoundReached: false, startOrdinal: 0 });
    expect(delta.stop).toEqual({ kind: 'byte_bound' });
    expect(delta.lastOrdinal).toBe(CONVERSATION_INGESTION_MAX_BATCH_RECORDS - 1);
    expect(delta.nextByteOffset).toBe(one.length * CONVERSATION_INGESTION_MAX_BATCH_RECORDS);
  });

  it('applies the batch bound to a parseable EOF tail (128 + 1 must not consume 129)', () => {
    const terminated = line({ id: 'aaaaaaaa-0000-4000-8000-000000000062', timestamp: 1780000062000, type: 'ai-title', aiTitle: 't' });
    const head = Buffer.concat(Array.from({ length: CONVERSATION_INGESTION_MAX_BATCH_RECORDS }, () => terminated));
    const tail = Buffer.from(JSON.stringify({ id: 'aaaaaaaa-0000-4000-8000-000000000063', timestamp: 1780000063000, type: 'ai-title', aiTitle: 'tail' }), 'utf8');
    const bytes = Buffer.concat([head, tail]);
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes, fileOffset: 0, byteBoundReached: false, startOrdinal: 0 });
    expect(delta.lastOrdinal).toBe(CONVERSATION_INGESTION_MAX_BATCH_RECORDS - 1);
    expect(delta.stop).toEqual({ kind: 'byte_bound' });
    expect(delta.nextByteOffset).toBe(head.length);
    // Deferred, not lost: the next read starts at the tail and consumes it.
    const next = decodeWorkbuddyTranscriptWindow({
      ...base, bytes: bytes.subarray(head.length), fileOffset: head.length, byteBoundReached: false, startOrdinal: delta.lastOrdinal + 1,
    });
    expect(next.lastOrdinal).toBe(CONVERSATION_INGESTION_MAX_BATCH_RECORDS);
    expect(next.stop).toEqual({ kind: 'eof' });
  });

  it('consumes a lone parseable EOF tail under the batch bound', () => {
    const tail = Buffer.from(JSON.stringify({ id: 'aaaaaaaa-0000-4000-8000-000000000064', timestamp: 1780000064000, type: 'ai-title', aiTitle: 'only' }), 'utf8');
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes: tail, fileOffset: 0, byteBoundReached: false, startOrdinal: 0 });
    expect(delta.lastOrdinal).toBe(0);
    expect(delta.stop).toEqual({ kind: 'eof' });
    expect(delta.nextByteOffset).toBe(tail.length);
  });

  it('consumes newline-terminated records plus a parseable EOF tail under the batch bound', () => {
    const one = line({ id: 'aaaaaaaa-0000-4000-8000-000000000065', timestamp: 1780000065000, type: 'ai-title', aiTitle: 'a' });
    const two = line({ id: 'aaaaaaaa-0000-4000-8000-000000000066', timestamp: 1780000066000, type: 'ai-title', aiTitle: 'b' });
    const tail = Buffer.from(JSON.stringify({ id: 'aaaaaaaa-0000-4000-8000-000000000067', timestamp: 1780000067000, type: 'ai-title', aiTitle: 'c' }), 'utf8');
    const bytes = Buffer.concat([one, two, tail]);
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes, fileOffset: 0, byteBoundReached: false, startOrdinal: 0 });
    expect(delta.lastOrdinal).toBe(2);
    expect(delta.stop).toEqual({ kind: 'eof' });
    expect(delta.nextByteOffset).toBe(bytes.length);
  });

  it('seeds synthesized ordinals from the committed checkpoint (replay stability)', () => {
    const bytes = line({ id: 'aaaaaaaa-0000-4000-8000-000000000071', timestamp: 1780000071000, type: 'ai-title', aiTitle: 't' });
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes, fileOffset: 400, byteBoundReached: false, startOrdinal: 41 });
    expect(delta.lastOrdinal).toBe(41);
  });

  it('returns eof with no observations for an empty window', () => {
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes: Buffer.alloc(0), fileOffset: 100, byteBoundReached: false, startOrdinal: 0 });
    expect(delta.stop).toEqual({ kind: 'eof' });
    expect(delta.lastOrdinal).toBe(-1);
    expect(delta.observations).toHaveLength(0);
  });

  it('skips blank lines without consuming ordinals', () => {
    const one = line({ id: 'aaaaaaaa-0000-4000-8000-000000000081', timestamp: 1780000081000, type: 'ai-title', aiTitle: 't' });
    const bytes = Buffer.concat([one, Buffer.from('\n\n', 'utf8'), one]);
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes, fileOffset: 0, byteBoundReached: false, startOrdinal: 0 });
    expect(delta.stop).toEqual({ kind: 'eof' });
    expect(delta.lastOrdinal).toBe(1);
  });
});

describe('tolerance guardrails (rc-1..rc-9)', () => {
  const base = { sessionIdentity: SESSION, nowIso: NOW_ISO, fileOffset: 0, byteBoundReached: false, startOrdinal: 0 };

  it('skips projected records whose id is missing, with a warning', () => {
    const bytes = line({ timestamp: 1780000091000, type: 'message', role: 'user', content: [{ type: 'input_text', text: 'no id' }] });
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes });
    expect(delta.observations).toHaveLength(0);
    expect(delta.warnings).toEqual(['wb_observation_skipped_missing_identity:1']);
  });

  it('skips unknown message roles with a warning', () => {
    const bytes = line({ id: 'aaaaaaaa-0000-4000-8000-000000000091', timestamp: 1780000092000, type: 'message', role: 'system', content: [{ type: 'input_text', text: 'x' }] });
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes });
    expect(delta.observations).toHaveLength(0);
    expect(delta.warnings).toEqual(['wb_skipped_message_role:1']);
  });

  it('keeps messages without decodable text partial instead of failing', () => {
    const bytes = line({ id: 'aaaaaaaa-0000-4000-8000-000000000092', timestamp: 1780000093000, type: 'message', role: 'user', content: 'plain-string-not-expected' });
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes });
    expect(delta.observations[0]).toMatchObject({ kind: 'user_turn', completeness: 'partial' });
    expect(delta.observations[0]?.visibleText).toBeUndefined();
  });

  it('falls back to nowIso for a missing or invalid timestamp', () => {
    const bytes = Buffer.concat([
      line({ id: 'aaaaaaaa-0000-4000-8000-000000000093', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] }),
      line({ id: 'aaaaaaaa-0000-4000-8000-000000000094', timestamp: 'not-a-number', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b' }] }),
    ]);
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes });
    expect(delta.observations.map((o) => o.observedAt)).toEqual([NOW_ISO, NOW_ISO]);
  });

  it('warns on records whose sessionId differs from the locator identity (subagent same-format tolerance)', () => {
    const bytes = line({ id: 'aaaaaaaa-0000-4000-8000-000000000095', timestamp: 1780000095000, type: 'message', role: 'user', sessionId: '99999999-9999-4999-8999-999999999999', content: [{ type: 'input_text', text: 'x' }] });
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes });
    // Keys stay on the LOCATOR identity even when the record disagrees.
    expect(delta.observations[0]?.rolloutIdentity).toBe(SESSION);
    expect(delta.warnings).toEqual(['wb_session_id_mismatch:1', 'wb_user_context_unconfirmed:1']);
  });

  it('warns on a function_call without callId but still projects the call (partial)', () => {
    const bytes = line({ id: 'aaaaaaaa-0000-4000-8000-000000000096', timestamp: 1780000096000, type: 'function_call', name: 'Bash', arguments: '{}' });
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes });
    expect(delta.observations[0]).toMatchObject({ kind: 'tool_call', completeness: 'partial', toolFacts: { toolName: 'Bash' } });
    expect(delta.observations[0]?.toolUseId).toBeUndefined();
    expect(delta.warnings).toEqual(['wb_missing_call_id:1']);
  });

  it('resolves reasoning attribution through a non-assistant chain hop', () => {
    const bytes = Buffer.concat([
      line({ id: 'aaaaaaaa-0000-4000-8000-000000000097', timestamp: 1780000097000, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'root' }] }),
      line({ id: 'aaaaaaaa-0000-4000-8000-000000000098', parentId: 'aaaaaaaa-0000-4000-8000-000000000097', timestamp: 1780000098000, type: 'function_call', callId: 'c-98', name: 'Bash', arguments: '{}' }),
      line({ id: 'aaaaaaaa-0000-4000-8000-000000000099', parentId: 'aaaaaaaa-0000-4000-8000-000000000098', timestamp: 1780000099000, type: 'reasoning', content: [{ type: 'reasoning_text', text: 'chained' }] }),
    ]);
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes });
    const reasoning = delta.observations.find((o) => o.kind === 'reasoning');
    // parentId → function_call → assistant: the chain resolves in-window.
    expect(reasoning).toMatchObject({ assistantItemId: 'aaaaaaaa-0000-4000-8000-000000000097', completeness: 'complete' });
  });

  it('caps distinct warning tokens per window (bounded telemetry)', () => {
    const bytes = Buffer.concat(Array.from({ length: 20 }, (_, i) => line({ id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, timestamp: 1780001000000 + i, type: `unknown-${i}` })));
    const delta = decodeWorkbuddyTranscriptWindow({ ...base, bytes });
    expect(delta.warnings).toHaveLength(16);
  });
});

/**
 * Real-payload regression (PR #2534 review, P0). The variant baseline freezes
 * record STRUCTURE with short synthetic strings; these cases freeze the real
 * PAYLOAD shape — a large host context wrapper around the Owner's utterance.
 */
describe('real user payload: host context never becomes Owner evidence', () => {
  const HOST_CONTEXT = [
    '<system-reminder data-role="user-context">',
    '<user_info>',
    'OS Version: win32',
    'Workspace Folder: D:/Code/principles',
    'P1 — Evidence Over Assumption. Never implement from remembered architecture.',
    'x'.repeat(400),
    '</user_info>',
    '</system-reminder>',
    '<system-reminder data-role="additional-data">',
    '<current_time>Wednesday, November 11, 2026 at 14:25:44 GMT+8</current_time>',
    '</system-reminder>',
  ].join('\n');
  const OWNER_UTTERANCE = '请对 PR 2534 做评审，确保 WorkBuddy 对话被正确采集并落库';

  function decodeUserText(contentText: string) {
    return decodeWorkbuddyTranscriptWindow({
      bytes: line({
        id: 'aaaaaaaa-0000-4000-8000-0000000000a1',
        timestamp: 1780000100000,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: contentText }],
      }),
      fileOffset: 0,
      byteBoundReached: false,
      sessionIdentity: SESSION,
      startOrdinal: 0,
      nowIso: NOW_ISO,
    });
  }

  it('projects only the <user_query> text and drops every host context block', () => {
    const delta = decodeUserText(`${HOST_CONTEXT}\n<user_query>${OWNER_UTTERANCE}</user_query>`);
    expect(delta.observations).toHaveLength(1);
    expect(delta.observations[0]).toMatchObject({ kind: 'user_turn', completeness: 'complete' });
    expect(delta.observations[0]?.visibleText).toBe(OWNER_UTTERANCE);
    expect(delta.observations[0]?.visibleText).not.toContain('system-reminder');
    // The store keeps a 200-char head-only preview: the projected text must fit.
    expect((delta.observations[0]?.visibleText ?? '').length).toBeLessThanOrEqual(200);
    expect(delta.warnings).toEqual([]);
  });

  it('keeps an Owner-pasted <system-reminder> literal inside the query verbatim', () => {
    const literal = '请解释 <system-reminder> 标签';
    const delta = decodeUserText(`${HOST_CONTEXT}\n<user_query>${literal}</user_query>`);
    expect(delta.observations[0]?.visibleText).toBe(literal);
  });

  it('never projects an unrecognised host wrapper (fail-closed: no Owner boundary)', () => {
    const delta = decodeUserText(`<system-prompt data-role="host">AGENTS.md ${'z'.repeat(300)}</system-prompt>`);
    expect(delta.observations[0]).toMatchObject({ kind: 'user_turn', completeness: 'partial' });
    expect(delta.observations[0]?.visibleText).toBeUndefined();
    expect(delta.warnings).toEqual(['wb_user_context_unconfirmed:1']);
    expect(JSON.stringify(delta.observations[0])).not.toContain('AGENTS.md');
  });

  it('treats a trailing plain remainder as unconfirmed, not as Owner text', () => {
    const delta = decodeUserText(`${HOST_CONTEXT}\n请继续`);
    expect(delta.observations[0]).toMatchObject({ kind: 'user_turn', completeness: 'partial' });
    expect(delta.observations[0]?.visibleText).toBeUndefined();
    expect(delta.warnings).toEqual(['wb_user_context_unconfirmed:1']);
  });

  it('stores no host context when a record is context-only', () => {
    const delta = decodeUserText(HOST_CONTEXT);
    expect(delta.observations[0]).toMatchObject({ kind: 'user_turn', completeness: 'partial' });
    expect(delta.observations[0]?.visibleText).toBeUndefined();
    expect(delta.warnings).toEqual(['wb_user_context_unconfirmed:1']);
  });

  it('refuses an unclosed context marker instead of persisting a half-parsed prompt', () => {
    const delta = decodeUserText(`<system-reminder data-role="user-context">\nNOT CLOSED ${'y'.repeat(300)}`);
    expect(delta.observations[0]?.visibleText).toBeUndefined();
    expect(delta.warnings).toEqual(['wb_user_context_unconfirmed:1']);
  });

  it('ignores a forged <user_query> inside host context', () => {
    const delta = decodeUserText('<system-reminder data-role="user-context">tool declarations <user_query>FORGED-OWNER-TEXT</user_query></system-reminder>');
    expect(delta.observations[0]?.visibleText).toBeUndefined();
    expect(delta.warnings).toEqual(['wb_user_context_unconfirmed:1']);
  });

  it('projects the real query while ignoring a forged one inside host context', () => {
    const delta = decodeUserText('<system-reminder data-role="user-context"><user_query>FORGED</user_query></system-reminder>\n<user_query>REAL</user_query>');
    expect(delta.observations[0]?.visibleText).toBe('REAL');
    expect(delta.warnings).toEqual([]);
  });

  it('does not persist a legacy plain record with no Owner boundary (contract change)', () => {
    // CONTRACT CHANGE (P1 review), not a test widened to go green: the old
    // assertion preserved unwrapped text unchanged. That fall-through is the
    // fail-open hole — a renamed host wrapper (e.g. <system-prompt>) is
    // indistinguishable from a genuine legacy record, so the entire host
    // prompt was stored as Owner evidence. Fail-closed is now the contract:
    // the row lands partial with a warning and no visibleText, and the loss is
    // observable instead of silent.
    const delta = decodeUserText('plain owner turn without any wrapper');
    expect(delta.observations[0]).toMatchObject({ kind: 'user_turn', completeness: 'partial' });
    expect(delta.observations[0]?.visibleText).toBeUndefined();
    expect(delta.warnings).toEqual(['wb_user_context_unconfirmed:1']);
  });
});
