import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleCodexReconcile } from '../../src/commands/codex-reconcile.js';

let workspace: string;
let exitCode: number | undefined;
let output: string[];

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-reconcile-'));
  fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), 'features: [invalid\n', 'utf8');
  exitCode = process.exitCode;
  process.exitCode = undefined;
  output = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => output.push(args.map(String).join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCode;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('pd codex reconcile config consent gate', () => {
  it('fails closed without creating runtime state when the ingestion flag cannot be read', async () => {
    await handleCodexReconcile({ workspace, json: true });

    expect(process.exitCode).toBe(1);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('pd_config_invalid:'),
      nextAction: expect.any(String),
      tasksEnsured: 0,
    });
    expect(fs.existsSync(path.join(workspace, '.state', 'trajectory.db'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.pd', 'state.db'))).toBe(false);
  });
});
