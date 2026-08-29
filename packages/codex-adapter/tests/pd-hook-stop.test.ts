import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { processHookInvocation } from '../src/pd-hook.js';
import { decodeCodexInput, CodexDecoderError } from '../src/codec/index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function workspace(ingestionEnabled: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-stop-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  config.features['codex_conversation_ingestion'] = { category: 'quiet', enabled: ingestionEnabled };
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  return root;
}

function stopPayload(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: '01a048ae-b2a5-71a1-9faf-0226980f98ff',
    turn_id: '01a048ae-b344-7eb2-804b-a2fa34302fb3',
    transcript_path: null,
    cwd: root,
    hook_event_name: 'Stop',
    model: 'gpt-5.6-sol',
    permission_mode: 'default',
    stop_hook_active: false,
    last_assistant_message: 'done',
    ...overrides,
  });
}

describe('Stop decode contract (G1 §2: Stop is the turn-complete event)', () => {
  it('decodes Stop into turn_complete with turn lineage', () => {
    const event = decodeCodexInput(JSON.parse(stopPayload('/workspace')));
    expect(event.kind).toBe('turn_complete');
    expect(event.source).toBe('codex:stop');
    expect(event.context.turnId).toBe('01a048ae-b344-7eb2-804b-a2fa34302fb3');
  });

  it('fails loud when stop_hook_active is missing or malformed', () => {
    expect(() => decodeCodexInput(JSON.parse(stopPayload('/w', { stop_hook_active: undefined })))).toThrow(CodexDecoderError);
    expect(() => decodeCodexInput(JSON.parse(stopPayload('/w', { stop_hook_active: 'no' })))).toThrow(CodexDecoderError);
  });

  it('SessionEnd is NOT decoded as a turn-complete event (SPEC §8: never register both)', () => {
    expect(() => decodeCodexInput(JSON.parse(JSON.stringify({ session_id: 's', transcript_path: null, cwd: '/w', hook_event_name: 'SessionEnd', reason: 'other' })))).toThrow(/unknown hook_event_name "SessionEnd"/);
  });
});

describe('pd-hook Stop behavior', () => {
  it('Stop with flag off and no transcript returns neutral {} with no diagnostics', async () => {
    const root = workspace(false);
    const result = await processHookInvocation(stopPayload(root), {}, root);
    expect(result).toEqual({ stdout: {}, exitCode: 0, stderr: [] });
  });

  it('Stop with flag on but transcript_path null degrades observably as transcript_unavailable', async () => {
    const root = workspace(true);
    const result = await processHookInvocation(stopPayload(root), {}, root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual({});
    expect(result.stderr[0]).toContain('reason=transcript_unavailable');
    expect(result.stderr[0]).toContain('nextAction=');
  });

  it('Stop never dispatches a runtime route — flag on + missing workspace store degrades via ingestion only', async () => {
    const root = workspace(true);
    const bogusTranscript = path.join(os.tmpdir(), 'pd-codex-stop-missing.jsonl');
    const result = await processHookInvocation(stopPayload(root, { transcript_path: bogusTranscript }), {}, root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual({});
    expect(result.stderr.length).toBeLessThanOrEqual(4);
    expect(result.stderr.join(' ')).toMatch(/reason=(transcript_path_invalid|codex_home)/);
  });
});
