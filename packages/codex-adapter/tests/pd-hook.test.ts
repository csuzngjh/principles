import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { processHookInvocation } from '../src/pd-hook.js';

const dirs: string[] = [];
function workspace(enabled = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-hook-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = enabled;
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  return root;
}
function input(root: string, event: Record<string, unknown>): string {
  return JSON.stringify({ session_id: 's-523', turn_id: 't-523', transcript_path: null, cwd: root, model: 'gpt-5.6', permission_mode: 'default', ...event });
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('pd-hook production boundary', () => {
  it('fails open observably for malformed stdin without touching the filesystem', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-malformed-')); dirs.push(root);
    const before = fs.readdirSync(root);
    const result = await processHookInvocation('{bad', {}, root);
    expect(result).toMatchObject({ stdout: {}, exitCode: 0, stderr: [expect.stringMatching(/reason=.*nextAction=/)] });
    expect(fs.readdirSync(root)).toEqual(before);
  });

  it('resolves the nearest ancestor config from Codex cwd', async () => {
    const root = workspace();
    const nested = path.join(root, 'nested', 'project'); fs.mkdirSync(nested, { recursive: true });
    const result = await processHookInvocation(input(nested, { hook_event_name: 'UserPromptSubmit', prompt: 'help' }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  });

  it('host.codex false returns structured skip and performs no business-state writes', async () => {
    const root = workspace(false);
    const before = fs.readdirSync(root, { recursive: true }).map(String).sort();
    const result = await processHookInvocation(input(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'false' }, tool_response: { exitCode: 1 }, tool_use_id: 'c-1' }));
    expect(result).toMatchObject({ stdout: {}, exitCode: 0, stderr: [expect.stringContaining('host.codex_disabled')] });
    expect(fs.readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before);
  });

  it('malformed config fails open before runtime mutation', async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), 'features: [bad');
    const before = fs.readdirSync(root, { recursive: true }).map(String).sort();
    const result = await processHookInvocation(input(root, { hook_event_name: 'UserPromptSubmit', prompt: 'help' }));
    expect(result).toMatchObject({ stdout: {}, exitCode: 0, stderr: [expect.stringMatching(/YAML.*nextAction=/)] });
    expect(fs.readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before);
  });

  it('SessionStart uses health-only supported behavior and exact schema', async () => {
    const root = workspace();
    const result = await processHookInvocation(JSON.stringify({ session_id: 's', transcript_path: null, cwd: root, hook_event_name: 'SessionStart', model: 'gpt-5.6', permission_mode: 'default', source: 'startup' }));
    expect(result).toEqual({ stdout: { hookSpecificOutput: { hookEventName: 'SessionStart' } }, exitCode: 0, stderr: [] });
  });

  it('the built executable emits exactly one JSON object on stdout and bounded diagnostics on stderr', () => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'dist', 'pd-hook.js')], { input: '{bad', encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(['{}']);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toMatch(/reason=.*nextAction=/);
    expect(result.stderr.length).toBeLessThanOrEqual(1_200);
  });
});
