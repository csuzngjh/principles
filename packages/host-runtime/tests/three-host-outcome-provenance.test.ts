/**
 * PRI-1309 characterization: outcome provenance is not interchangeable across
 * the three host families even when the final enum matches. These tests use
 * the real Codex/WorkBuddy decoders where those hosts own the input contract,
 * then dispatch through the real shared production writer. OpenClaw-style
 * envelopes are constructed directly because this test must not edit or depend
 * on OpenClaw plugin files; they mirror the production adapter's outer
 * `{ error, result, durationMs }` normalization envelope and exercise the same
 * classifier/writer boundary. They deliberately omit turnId/toolCallId because
 * the real OpenClaw adapter currently drops both before this writer boundary.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { HostEvent } from '@principles/core/host';
import { applyTrajectorySchemaBase } from '@principles/core/runtime';
import { createProductionHostRuntime } from '../src/index.js';
import { recordVerifiedToolOutcomes } from '../src/production-pain-evidence.js';
import { decodeCodexInput } from '../../codex-adapter/src/codec/input-decoder.js';
import { decodeWorkbuddyInput } from '../../workbuddy-adapter/src/codec/input-decoder.js';

type HostKind = 'openclaw' | 'codex' | 'workbuddy';

const roots: string[] = [];

function provenanceWorkspace(): { workspaceDir: string; projectDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-three-host-provenance-'));
  roots.push(root);
  const workspaceDir = path.join(root, 'governance');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  applyTrajectorySchemaBase(db);
  db.close();
  return { workspaceDir, projectDir };
}

function decodeCodexPost(projectDir: string, toolResponse: unknown, toolUseId: string): HostEvent {
  return decodeCodexInput({
    session_id: 'provenance-codex-session',
    turn_id: 'provenance-codex-turn',
    transcript_path: null,
    cwd: projectDir,
    model: 'gpt-5.6',
    permission_mode: 'default',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'probe-command' },
    tool_response: toolResponse,
    tool_use_id: toolUseId,
  });
}

function decodeWorkbuddyPost(projectDir: string, toolResponse: unknown, callId: string): HostEvent {
  return decodeWorkbuddyInput({
    session_id: 'provenance-workbuddy-session',
    transcript_path: null,
    cwd: projectDir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: path.join(projectDir, 'target.txt') },
    tool_response: toolResponse,
    call_id: callId,
    generation_id: 'provenance-workbuddy-turn',
  });
}

function decodeWorkbuddyPostFailure(projectDir: string, callId: string): HostEvent {
  return decodeWorkbuddyInput({
    session_id: 'provenance-workbuddy-session',
    transcript_path: null,
    cwd: projectDir,
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Write',
    tool_input: { file_path: path.join(projectDir, 'target.txt'), content: 'x' },
    error: 'File has not been read yet: target.txt. Read it first before writing to it.',
    call_id: callId,
    generation_id: 'provenance-workbuddy-turn',
  });
}

function openClawAdapterEnvelope(result: unknown, error?: unknown, durationMs = 12): Record<string, unknown> {
  return { error, result, durationMs };
}

function openClawStyleEvent(workspaceDir: string, toolOutput: unknown): HostEvent {
  return {
    kind: 'after_tool_call',
    context: {
      workspaceDir,
      sessionId: 'provenance-openclaw-session',
      toolName: 'write_file',
      toolInput: { file_path: 'target.txt', content: 'x' },
      toolOutput,
    },
    rawPayload: { host: 'openclaw-style-fixture' },
    source: 'openclaw:after_tool_call',
  };
}

async function dispatchAtWorkspace(event: HostEvent, workspaceDir: string, projectDir: string, hostKind: HostKind) {
  const runtime = createProductionHostRuntime({ hostKind, projectDir });
  return runtime.dispatch({ ...event, context: { ...event.context, workspaceDir } });
}

function storedRows(workspaceDir: string, sessionId: string): Record<string, unknown>[] {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    return db.prepare(`SELECT id, session_id, tool_name, outcome, exit_code, error_type, error_message, params_json, result_preview, tool_use_id, project_dir, host_kind
      FROM tool_calls WHERE session_id = ? ORDER BY id`).all(sessionId) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function oneStoredRow(workspaceDir: string, sessionId: string): Record<string, unknown> {
  const rows = storedRows(workspaceDir, sessionId);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) throw new Error('expected exactly one stored tool_calls row');
  return row;
}

function previewResult(row: Record<string, unknown>): unknown {
  expect(typeof row['result_preview']).toBe('string');
  const parsed = JSON.parse(String(row['result_preview'])) as { result?: unknown };
  return parsed.result;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});

describe('three-host outcome provenance matrix', () => {
  it('codex text-only shell provenance writes unknown/text_only_response; only the Codex transcript-upgrade path can strengthen it', async () => {
    const { workspaceDir, projectDir } = provenanceWorkspace();
    const event = decodeCodexPost(projectDir, 'probe output text: 1 failed, 2 passed', 'codex-text-only-call');
    // Decoder provenance: Codex leaves the shell response as bare text. It is
    // not a structured completion envelope.
    expect(event.context.toolOutput).toBe('probe output text: 1 failed, 2 passed');

    const result = await dispatchAtWorkspace(event, workspaceDir, projectDir, 'codex');
    expect(result.source).toBe('codex:post_tool_use');
    expect(result.metadata).toMatchObject({ outcome: 'unknown', outcomeReason: 'text_only_response', exitCode: null });
    const beforeUpgrade = oneStoredRow(workspaceDir, 'provenance-codex-session');
    expect(beforeUpgrade).toMatchObject({
      tool_name: 'Bash',
      outcome: 'unknown',
      exit_code: null,
      error_message: null,
      tool_use_id: 'codex-text-only-call',
      project_dir: path.resolve(projectDir),
      host_kind: 'codex',
    });
    expect(previewResult(beforeUpgrade)).toBe('probe output text: 1 failed, 2 passed');

    // The production transcript-ingestion orchestration is exhaustively pinned
    // in codex-adapter/tests/ingestion/verified-outcome-upgrade.test.ts. This
    // single direct primitive call characterizes the strength difference at
    // the writer boundary; no equivalent WorkBuddy/OpenClaw verified-transcript
    // provenance is claimed anywhere in this matrix.
    const upgrade = recordVerifiedToolOutcomes({
      workspaceDir,
      sessionId: 'provenance-codex-session',
      hostKind: 'codex',
      outcomes: [{ toolUseId: 'codex-text-only-call', toolName: 'Bash', exitCode: 1, outputPreview: 'verified failure output' }],
    });
    expect(upgrade).toEqual([{ status: 'updated', id: expect.any(Number) }]);
    expect(oneStoredRow(workspaceDir, 'provenance-codex-session')).toMatchObject({
      outcome: 'failure',
      exit_code: 1,
      host_kind: 'codex',
      tool_use_id: 'codex-text-only-call',
    });
  });

  it('workbuddy PostToolUse string completion provenance becomes structured success through the channel contract', async () => {
    const { workspaceDir, projectDir } = provenanceWorkspace();
    const event = decodeWorkbuddyPost(projectDir, '   1→rendered read output\n', 'wb-string-completion-call');
    // Decoder provenance: the rendered string rides inside a non-`result`
    // completion envelope because PostToolUse is the success channel and
    // PostToolUseFailure is the separate failure channel.
    expect(event.context.toolOutput).toEqual({ toolResponse: '   1→rendered read output\n' });

    const result = await dispatchAtWorkspace(event, workspaceDir, projectDir, 'workbuddy');
    expect(result.source).toBe('workbuddy:post_tool_use');
    expect(result.metadata).toMatchObject({ outcome: 'success', exitCode: null, duplicate: false });
    expect(result.metadata).not.toHaveProperty('outcomeReason');
    const row = oneStoredRow(workspaceDir, 'provenance-workbuddy-session');
    expect(row).toMatchObject({
      tool_name: 'Read',
      outcome: 'success',
      exit_code: null,
      error_message: null,
      tool_use_id: 'wb-string-completion-call',
      project_dir: path.resolve(projectDir),
      host_kind: 'workbuddy',
    });
    // The durable preview is sanitized evidence, not a byte-verbatim copy:
    // sanitizeValue trims the rendered text while the decoded envelope above
    // preserves it. Pin that distinction rather than treating the preview as
    // the original payload.
    expect(previewResult(row)).toEqual({ toolResponse: '1→rendered read output' });
  });

  it('workbuddy PostToolUse is_error provenance becomes an explicit failure without fabricating an exit code', async () => {
    const { workspaceDir, projectDir } = provenanceWorkspace();
    const response = { is_error: true, tool_error_code: '1001' };
    const event = decodeWorkbuddyPost(projectDir, response, 'wb-is-error-call');
    expect(event.context.toolOutput).toEqual({
      result: response,
      error: 'workbuddy tool failure: is_error=true tool_error_code=1001',
    });

    const result = await dispatchAtWorkspace(event, workspaceDir, projectDir, 'workbuddy');
    expect(result.source).toBe('workbuddy:post_tool_use');
    expect(result.metadata).toMatchObject({ outcome: 'failure', exitCode: null });
    const row = oneStoredRow(workspaceDir, 'provenance-workbuddy-session');
    expect(row).toMatchObject({
      outcome: 'failure',
      exit_code: null,
      error_message: 'workbuddy tool failure: is_error=true tool_error_code=1001',
      tool_use_id: 'wb-is-error-call',
      host_kind: 'workbuddy',
    });
    expect(previewResult(row)).toEqual(response);
  });

  it('workbuddy PostToolUse integer-exit/error provenance becomes failure with the real exit code', async () => {
    const { workspaceDir, projectDir } = provenanceWorkspace();
    const response = { exitCode: 7, error: 'cat: missing.txt: No such file or directory\n' };
    const event = decodeWorkbuddyPost(projectDir, response, 'wb-exit7-call');
    expect(event.context.toolOutput).toEqual({ result: response, error: response.error });

    const result = await dispatchAtWorkspace(event, workspaceDir, projectDir, 'workbuddy');
    expect(result.source).toBe('workbuddy:post_tool_use');
    expect(result.metadata).toMatchObject({ outcome: 'failure', exitCode: 7 });
    const row = oneStoredRow(workspaceDir, 'provenance-workbuddy-session');
    expect(row).toMatchObject({
      outcome: 'failure',
      exit_code: 7,
      error_message: response.error,
      tool_use_id: 'wb-exit7-call',
      host_kind: 'workbuddy',
    });
    expect(previewResult(row)).toEqual({ ...response, error: 'cat: missing.txt: No such file or directory' });
  });

  it('workbuddy PostToolUseFailure thrown-envelope provenance is failure from a distinct channel', async () => {
    const { workspaceDir, projectDir } = provenanceWorkspace();
    const event = decodeWorkbuddyPostFailure(projectDir, 'wb-thrown-call');
    expect(event.source).toBe('workbuddy:post_tool_use_failure');
    expect(event.context.toolOutput).toMatchObject({
      error: 'File has not been read yet: target.txt. Read it first before writing to it.',
    });

    const result = await dispatchAtWorkspace(event, workspaceDir, projectDir, 'workbuddy');
    expect(result.source).toBe('workbuddy:post_tool_use_failure');
    expect(result.metadata).toMatchObject({ outcome: 'failure', exitCode: null });
    const row = oneStoredRow(workspaceDir, 'provenance-workbuddy-session');
    expect(row).toMatchObject({
      tool_name: 'Write',
      outcome: 'failure',
      exit_code: null,
      error_message: 'File has not been read yet: target.txt. Read it first before writing to it.',
      tool_use_id: 'wb-thrown-call',
      host_kind: 'workbuddy',
    });
    expect(previewResult(row)).toMatchObject({ hook_event_name: 'PostToolUseFailure', tool_name: 'Write' });
  });

  it('openclaw adapter-shaped explicit error-envelope provenance is failure evidence, not inferred shape success', async () => {
    const { workspaceDir, projectDir } = provenanceWorkspace();
    const output = openClawAdapterEnvelope({ detail: 'write rejected' }, 'EACCES permission denied');
    const event = openClawStyleEvent(workspaceDir, output);
    const result = await dispatchAtWorkspace(event, workspaceDir, projectDir, 'openclaw');

    expect(result.source).toBe('openclaw:after_tool_call');
    expect(result.metadata).toMatchObject({ outcome: 'failure', exitCode: null });
    const row = oneStoredRow(workspaceDir, 'provenance-openclaw-session');
    expect(row).toMatchObject({
      outcome: 'failure',
      exit_code: null,
      error_message: 'EACCES permission denied',
      tool_use_id: null,
      host_kind: 'openclaw',
    });
    expect(previewResult(row)).toEqual({ detail: 'write rejected' });
  });

  it.each([
    [0, 'success'],
    [2, 'failure'],
  ] as const)('openclaw adapter-shaped integer exitCode %d provenance classifies as %s', async (exitCode, expectedOutcome) => {
    const { workspaceDir, projectDir } = provenanceWorkspace();
    const output = openClawAdapterEnvelope({ exitCode, output: 'probe process output' });
    const event = openClawStyleEvent(workspaceDir, output);
    const result = await dispatchAtWorkspace(event, workspaceDir, projectDir, 'openclaw');

    expect(result.metadata).toMatchObject({ outcome: expectedOutcome, exitCode });
    const row = oneStoredRow(workspaceDir, 'provenance-openclaw-session');
    expect(row).toMatchObject({
      outcome: expectedOutcome,
      exit_code: exitCode,
      error_message: null,
      tool_use_id: null,
      host_kind: 'openclaw',
    });
    expect(previewResult(row)).toEqual({ exitCode, output: 'probe process output' });
  });

  it('openclaw adapter-shaped text-only result provenance stays unknown/text_only_response (never keyword-guessed)', async () => {
    const { workspaceDir, projectDir } = provenanceWorkspace();
    const output = openClawAdapterEnvelope('probe output mentions both success and failure words');
    const event = openClawStyleEvent(workspaceDir, output);
    const result = await dispatchAtWorkspace(event, workspaceDir, projectDir, 'openclaw');

    expect(result.metadata).toMatchObject({ outcome: 'unknown', outcomeReason: 'text_only_response', exitCode: null });
    const row = oneStoredRow(workspaceDir, 'provenance-openclaw-session');
    expect(row).toMatchObject({
      outcome: 'unknown',
      exit_code: null,
      error_message: null,
      tool_use_id: null,
      host_kind: 'openclaw',
    });
    expect(previewResult(row)).toBe('probe output mentions both success and failure words');
  });

  it.each([
    ['empty object', {}],
    ['content-block array', [{ type: 'text', text: 'structured output' }]],
  ] as const)('openclaw adapter-wrapped %s native result provenance is only live-envelope-shape-inferred success', async (_label, nativeResult) => {
    const { workspaceDir, projectDir } = provenanceWorkspace();
    const event = openClawStyleEvent(workspaceDir, openClawAdapterEnvelope(nativeResult));
    const result = await dispatchAtWorkspace(event, workspaceDir, projectDir, 'openclaw');

    expect(result.metadata).toMatchObject({ outcome: 'success', exitCode: null, duplicate: false });
    expect(result.metadata).not.toHaveProperty('outcomeReason');
    const row = oneStoredRow(workspaceDir, 'provenance-openclaw-session');
    expect(row).toMatchObject({
      outcome: 'success',
      exit_code: null,
      error_message: null,
      tool_use_id: null,
      host_kind: 'openclaw',
    });
    expect(previewResult(row)).toEqual(nativeResult);
  });

  it('openclaw adapter-wrapped missing native result is still envelope-shape-inferred success, proving the inference is weaker than object/array presence', async () => {
    const { workspaceDir, projectDir } = provenanceWorkspace();
    const event = openClawStyleEvent(workspaceDir, openClawAdapterEnvelope(undefined));
    const result = await dispatchAtWorkspace(event, workspaceDir, projectDir, 'openclaw');

    expect(result.metadata).toMatchObject({ outcome: 'success', exitCode: null, duplicate: false });
    expect(result.metadata).not.toHaveProperty('outcomeReason');
    const row = oneStoredRow(workspaceDir, 'provenance-openclaw-session');
    expect(row).toMatchObject({
      outcome: 'success',
      exit_code: null,
      error_message: null,
      tool_use_id: null,
      host_kind: 'openclaw',
    });
    // normalizeOutcome falls back from the nullish native `result` to the
    // adapter envelope itself. The writer's stable preview serializer currently
    // stringifies undefined envelope fields instead of dropping them, so the
    // durable preview visibly records placeholder text rather than a real tool result.
    expect(previewResult(row)).toEqual({ error: 'undefined', result: 'undefined', durationMs: 12 });
  });
});
