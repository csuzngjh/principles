import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * G1 contract fixture guard (Codex Governance Closure Slice 0).
 *
 * These tests make the frozen G1 statements executable against the real
 * on-device fixtures captured for codex-cli 0.150.1 and 0.148.0. They are
 * decision evidence: they pin the host contract the Slice A decoder must
 * implement, and they fail loudly if a fixture is edited by hand instead of
 * re-captured from a real probe. See
 * tests/fixtures/g1-contract/README.md and
 * docs/architecture/CODEX_G1_CONTRACT_PROBE_REPORT.md.
 */

const FIXTURES = new URL('./fixtures/g1-contract/', import.meta.url);

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, FIXTURES), 'utf8'));
}

function readTranscript(relative: string): Array<Record<string, unknown>> {
  return readFileSync(new URL(relative, FIXTURES), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function payloadOf(row: Record<string, unknown>): Record<string, unknown> {
  return row.payload as Record<string, unknown>;
}

const REQUIRED_FIELDS: Record<string, string[]> = {
  '01-session-start': ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'source'],
  '02-user-prompt-submit': ['session_id', 'turn_id', 'transcript_path', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'prompt'],
  '03-pre-tool-use': ['session_id', 'turn_id', 'transcript_path', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'tool_name', 'tool_input', 'tool_use_id'],
  '04-post-tool-use': ['session_id', 'turn_id', 'transcript_path', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'tool_name', 'tool_input', 'tool_response', 'tool_use_id'],
  '05-stop': ['session_id', 'turn_id', 'transcript_path', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'stop_hook_active', 'last_assistant_message'],
  '06-subagent-stop': ['session_id', 'turn_id', 'transcript_path', 'agent_transcript_path', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'stop_hook_active', 'agent_id', 'agent_type', 'last_assistant_message'],
  '07-session-end': ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'reason'],
};

const VERSIONS = ['v0.150.1', 'v0.148.0'];

describe('G1 frozen hook payload contract', () => {
  for (const version of VERSIONS) {
    for (const [stem, required] of Object.entries(REQUIRED_FIELDS)) {
      if (version === 'v0.148.0' && stem === '06-subagent-stop') continue; // captured on 0.150.1 only
      const file = `hook-payloads/${version}/${stem}.json`;
      it(`${version} ${stem} carries the real required field set`, () => {
        const payload = readJson(file) as Record<string, unknown>;
        expect(Object.keys(payload).sort()).toEqual([...required].sort());
        expect(payload.hook_event_name).toBeTypeOf('string');
      });
    }
  }

  it('0.148.0 and 0.150.1 agree on the field set for every shared event', () => {
    for (const stem of Object.keys(REQUIRED_FIELDS)) {
      if (stem === '06-subagent-stop') continue; // captured on 0.150.1 only
      const oldKeys = Object.keys(readJson(`hook-payloads/v0.148.0/${stem}.json`) as object).sort();
      const newKeys = Object.keys(readJson(`hook-payloads/v0.150.1/${stem}.json`) as object).sort();
      expect(oldKeys, stem).toEqual(newKeys);
    }
  });
});

describe('G1 Stop event is the turn-complete contract', () => {
  const stop = readJson('hook-payloads/v0.150.1/05-stop.json') as Record<string, unknown>;
  const rows = readTranscript('transcripts/normal-tool-final-turn.jsonl');

  it('the transcript already contains the final assistant turn for the Stop turn', () => {
    // The fixture rollout also contains the later resumed turn; select the
    // final message belonging to the Stop payload's own turn.
    const finalsForTurn = rows.filter((r) => {
      const p = payloadOf(r);
      return r.type === 'response_item' && p.type === 'message' && p.role === 'assistant' && p.phase === 'final_answer' &&
        (p.internal_chat_message_metadata_passthrough as { turn_id?: string } | undefined)?.turn_id === stop.turn_id;
    });
    expect(finalsForTurn).toHaveLength(1);
    const finalPayload = payloadOf(finalsForTurn[0]) as { content?: Array<{ type: string; text: string }> };
    const text = (finalPayload.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
    expect(text).toBe(stop.last_assistant_message);
  });

  it('Stop and the live tool events share one session and one turn', () => {
    const postToolUse = readJson('hook-payloads/v0.150.1/04-post-tool-use.json') as Record<string, unknown>;
    expect(stop.session_id).toBe(postToolUse.session_id);
    expect(stop.turn_id).toBe(postToolUse.turn_id);
  });

  it('hook tool_use_id joins the transcript through the item_completed bridge, not through call_id', () => {
    const postToolUse = readJson('hook-payloads/v0.150.1/04-post-tool-use.json') as Record<string, unknown>;
    const calls = rows.filter((r) => r.type === 'response_item' && payloadOf(r).type === 'custom_tool_call');
    const outputs = rows.filter((r) => r.type === 'response_item' && payloadOf(r).type === 'custom_tool_call_output');
    const completions = rows.filter((r) => r.type === 'event_msg' && payloadOf(r).type === 'item_completed');
    // Model-level ids: call/output pair joins on call_id...
    const pairCallId = payloadOf(calls[0]).call_id;
    expect(payloadOf(outputs[0]).call_id).toBe(pairCallId);
    // ...which is a DIFFERENT id space from the hook's tool_use_id.
    expect(pairCallId).not.toBe(postToolUse.tool_use_id);
    // The bridge: event_msg item_completed wraps a CommandExecution whose id
    // equals the hook tool_use_id and carries the same turn.
    const bridge = completions.map((r) => payloadOf(r)).find((p) => {
      const item = p.item as { id?: string } | undefined;
      return item?.id === postToolUse.tool_use_id;
    }) as { turn_id?: string; item?: { id?: string; exit_code?: number } } | undefined;
    expect(bridge).toBeDefined();
    expect(bridge?.turn_id).toBe(postToolUse.turn_id);
    expect(bridge?.item?.exit_code).toBe(0);
  });
});

describe('G1 lineage contracts', () => {
  const normal = readTranscript('transcripts/normal-tool-final-turn.jsonl');
  const baseSessionId = payloadOf(normal[0]).session_id;

  it('fork gets a new session id, records the parent, and continues ordinals', () => {
    const fork = readTranscript('transcripts/fork.jsonl');
    const meta = payloadOf(fork[0]);
    expect(meta.session_id).not.toBe(baseSessionId);
    expect(meta.forked_from_id).toBe(baseSessionId);
    // Ordinals continue the parent's logical history instead of restarting;
    // the inherited records themselves are not copied into the fork file.
    expect(fork[0].ordinal).toBeGreaterThan(0);
  });

  it('resume appends a second turn to the same rollout and session', () => {
    // Run C (codex exec resume) wrote into run A's rollout file; the fixture
    // therefore carries two genuine user.text turns with distinct turn ids.
    const resumed = readTranscript('transcripts/normal-tool-final-turn.jsonl');
    expect(payloadOf(resumed[0]).session_id).toBe(baseSessionId);
    const userTurns = resumed.filter((r) => {
      const p = payloadOf(r);
      return r.type === 'response_item' && p.type === 'message' && p.role === 'user' &&
        (p.internal_chat_message_metadata_passthrough as { content_item_kinds?: string[] } | undefined)?.content_item_kinds?.[0] === 'user.text';
    });
    expect(userTurns.length).toBeGreaterThanOrEqual(2);
    const turnIds = new Set(userTurns.map((r) => (payloadOf(r).internal_chat_message_metadata_passthrough as { turn_id?: string }).turn_id));
    expect(turnIds.size).toBe(userTurns.length);
  });

  it('subagent rollout keeps parent lineage and its own ordinal space', () => {
    const parent = readTranscript('transcripts/subagent-parent.jsonl');
    const child = readTranscript('transcripts/subagent-child.jsonl');
    const parentSession = payloadOf(parent[0]).session_id;
    const childMeta = payloadOf(child[0]);
    expect(childMeta.thread_source).toBe('subagent');
    expect(childMeta.parent_thread_id).toBe(parentSession);
    expect(childMeta.forked_from_id).toBe(parentSession);
    expect(child[0].ordinal).toBe(0);
    // Collision trap: the child file's session_meta.session_id is the PARENT
    // thread id, not the agent id; rollout identity must come from the file's
    // own uuid / agent_id, never from session_meta.session_id alone.
    expect(childMeta.session_id).toBe(parentSession);
    const subagentStop = readJson('hook-payloads/v0.150.1/06-subagent-stop.json') as Record<string, unknown>;
    expect(subagentStop.agent_id).not.toBe(subagentStop.session_id);
    expect(subagentStop.agent_transcript_path).not.toBe(subagentStop.transcript_path);
  });
});

describe('G1 transcript failure modes are distinguishable', () => {
  it('malformed-line has exactly one permanently invalid record', () => {
    const text = readFileSync(new URL('transcripts/malformed-line.jsonl', FIXTURES), 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    const bad = lines.filter((l) => {
      try { JSON.parse(l); return false; } catch { return true; }
    });
    expect(bad).toHaveLength(1);
  });

  it('incomplete-tail is a retryable cut final line without a trailing newline', () => {
    const text = readFileSync(new URL('transcripts/incomplete-tail.jsonl', FIXTURES), 'utf8');
    expect(text.endsWith('\n')).toBe(false);
    const lines = text.split('\n');
    const last = lines[lines.length - 1];
    expect(() => JSON.parse(last)).toThrow();
    for (const line of lines.slice(0, -1)) {
      if (line.length > 0) expect(() => JSON.parse(line), line.slice(0, 40)).not.toThrow();
    }
  });

  it('compacted records replace history through replacement_history', () => {
    const rows = readTranscript('transcripts/compacted-marker.jsonl');
    expect(rows).toHaveLength(1);
    const p = payloadOf(rows[0]);
    expect(rows[0].type).toBe('compacted');
    expect(Array.isArray(p.replacement_history)).toBe(true);
  });
});

describe('G1 fixtures exclude hidden and host-injected content', () => {
  const transcriptFiles = [
    'normal-tool-final-turn.jsonl', 'fork.jsonl',
    'subagent-parent.jsonl', 'subagent-child.jsonl', 'min-version-0.148.0.jsonl',
  ];
  for (const file of transcriptFiles) {
    it(`${file} contains no hidden reasoning, system prompts, or host-injected user context`, () => {
      const rows = readTranscript(`transcripts/${file}`);
      for (const row of rows) {
        const p = payloadOf(row);
        if (row.type === 'session_meta') {
          expect(Object.hasOwn(p, 'base_instructions')).toBe(false);
        }
        if (row.type === 'world_state' || row.type === 'inter_agent_communication_metadata') {
          throw new Error(`forbidden record type ${row.type} in ${file}`);
        }
        if (row.type === 'response_item') {
          expect(p.type).not.toBe('reasoning');
          if (p.type === 'message') {
            expect(['user', 'assistant']).toContain(p.role);
          }
        }
      }
      const raw = readFileSync(new URL(`transcripts/${file}`, FIXTURES), 'utf8');
      expect(raw.includes('gAAAAAB'), file).toBe(false);
      expect(raw.includes('Administrator'), file).toBe(false);
    });
  }
});
