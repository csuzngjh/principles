/**
 * PRI-633 — OpenClawCliRuntimeAdapter systemPrompt fold-back.
 *
 * PD prompt builders now deliver role/protocol instructions via
 * StartRunInput.systemPrompt (split out of the payload JSON). The OpenClaw
 * CLI path must keep delivering them through the MESSAGE channel (the host
 * owns its own agent system prompt — DPB-07), so the adapter folds the base
 * layer back into the message file after the payload JSON. These tests pin:
 *   - fold behavior (systemPrompt present → appended after the JSON)
 *   - byte-identical file content when systemPrompt is absent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OpenClawCliRuntimeAdapter } from '../openclaw-cli-runtime-adapter.js';
import type { CliOutput } from '../../utils/cli-process-runner.js';
import type { StartRunInput } from '../../runtime-protocol.js';

// Mock runCliProcess so no real openclaw binary is needed; the filesystem
// (writeMessageFile / cleanupMessageFile) runs for real against a temp dir.
vi.mock('../../utils/cli-process-runner.js', () => ({
  runCliProcess: vi.fn(),
}));

import { runCliProcess } from '../../utils/cli-process-runner.js';

const mockRunCliProcess = runCliProcess as ReturnType<typeof vi.fn>;

function makeCliOutput(overrides: Partial<CliOutput> = {}): CliOutput {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 100,
    ...overrides,
  };
}

/** OpenClaw CLI success envelope (stderr-wrapped agent reply). */
function successEnvelope(): string {
  return JSON.stringify({ payloads: [{ text: '{"ok":true}' }] });
}

describe('OpenClawCliRuntimeAdapter systemPrompt fold-back (PRI-633)', () => {
  let tempWorkspace: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fold-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
  });

  /** Run startRun once and capture the message-file content while the CLI runs. */
  async function captureMessageFile(input: StartRunInput): Promise<string> {
    let captured = '';
    mockRunCliProcess.mockImplementationOnce((opts: { args: string[] }) => {
      const idx = opts.args.indexOf('--message-file');
      const filePath = opts.args[idx + 1];
      if (typeof filePath !== 'string') throw new Error('--message-file path missing in args');
      captured = fs.readFileSync(filePath, 'utf8');
      return Promise.resolve(makeCliOutput({ exitCode: 0, stderr: successEnvelope() }));
    });
    const adapter = new OpenClawCliRuntimeAdapter({
      runtimeMode: 'local',
      agentId: 'main',
      workspaceDir: tempWorkspace,
    });
    await adapter.startRun(input);
    return captured;
  }

  it('folds StartRunInput.systemPrompt into the message file after the payload JSON', async () => {
    const content = await captureMessageFile({
      agentSpec: { agentId: 'main', schemaVersion: 'v1' },
      inputPayload: '{"taskId":"t1"}',
      contextItems: [],
      timeoutMs: 60_000,
      systemPrompt: 'You are a root cause analysis expert.',
    });
    expect(content).toBe('{"taskId":"t1"}\n\nYou are a root cause analysis expert.');
  });

  it('keeps the message file byte-identical when systemPrompt is absent', async () => {
    const content = await captureMessageFile({
      agentSpec: { agentId: 'main', schemaVersion: 'v1' },
      inputPayload: '{"taskId":"t1"}',
      contextItems: [],
      timeoutMs: 60_000,
    });
    expect(content).toBe('{"taskId":"t1"}');
  });
});
