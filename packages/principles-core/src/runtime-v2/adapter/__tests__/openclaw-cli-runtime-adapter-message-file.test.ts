/**
 * Tests for OpenClawCliRuntimeAdapter healthCheck message-file lifecycle.
 *
 * Context: commit 89c91854 fixed a bug where healthCheck probe used the deleted
 * MessageFileRef.arg field instead of MessageFileRef.filePath. These tests
 * verify the REAL behavior the original PR claimed to cover but didn't:
 *
 * - The message file is actually created on disk and its path is passed to CLI
 * - The file is cleaned up on BOTH success and failure paths (finally block)
 * - Each probe gets a unique session ID
 * - workspaceDir controls where the temp file lands
 *
 * ERR-088 lesson: the prior version of this file asserted only
 * `expect(adapter).toBeDefined()` and `expect(...).not.toThrow()` while
 * hardcoding `/test/workspace` (which fails on non-root CI and on Windows).
 * A refactor deleting cleanupMessageFile would have left every test green.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OpenClawCliRuntimeAdapter } from '../openclaw-cli-runtime-adapter.js';
import type { CliOutput } from '../../utils/cli-process-runner.js';

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

/** A successful probe-3 envelope: openclaw wraps the agent reply in stderr. */
function successEnvelope(): string {
  return JSON.stringify({ payloads: [{ text: '{"ok":true}' }] });
}

describe('OpenClawCliRuntimeAdapter healthCheck message-file lifecycle', () => {
  let tempWorkspace: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-msgfile-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
  });

  // Helper: stub the first two probes (version + agents-list) to succeed so
  // probe 3 (the message-file path) is reached.
  function stubFirstTwoProbes(agentId = 'diag') {
    mockRunCliProcess
      .mockResolvedValueOnce(makeCliOutput({ exitCode: 0, stdout: 'openclaw version' }))
      .mockResolvedValueOnce(makeCliOutput({ exitCode: 0, stdout: `[{"id":"${agentId}"}]` }));
  }

  describe('message file is created and passed to the CLI', () => {
    it('creates the message file on disk under <workspace>/.pd/tmp and passes its real path', async () => {
      const adapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: 'local',
        agentId: 'diag',
        workspaceDir: tempWorkspace,
      });
      stubFirstTwoProbes();

      // Capture the file path + content WHILE the probe runs (before cleanup
      // in the finally block removes it). The mock implementation reads the
      // file off disk and stashes it for assertion after healthCheck returns.
      let capturedPath = '';
      let capturedContent = '';
      mockRunCliProcess.mockImplementationOnce((opts: { args: string[] }) => {
        const msgIdx = opts.args.indexOf('--message-file');
        const filePath = opts.args[msgIdx + 1];
        if (typeof filePath !== 'string') throw new Error('--message-file path missing in probe args');
        capturedPath = filePath;
        capturedContent = fs.readFileSync(capturedPath, 'utf8');
        return Promise.resolve(makeCliOutput({ exitCode: 0, stderr: successEnvelope() }));
      });

      await adapter.healthCheck();

      // Must use --message-file (the bug fix), not the deleted --message.
      expect(capturedPath).not.toBe('');

      // The path must live under the real workspace .pd/tmp dir.
      expect(capturedPath).toContain(path.join('.pd', 'tmp'));
      expect(capturedPath.startsWith(tempWorkspace)).toBe(true);

      // ERR-088: assert the file content is the probe payload, proving the
      // created file actually carries the message (not just a path string).
      expect(capturedContent).toContain('pd-runtime-v2');
      expect(capturedContent).toContain('reply with');

      // The args must still contain --message-file (belt-and-suspenders).
      const probe3Call = mockRunCliProcess.mock.calls[2]?.[0] as unknown as { args: string[] };
      expect(probe3Call.args).toContain('--message-file');
      expect(probe3Call.args).not.toContain('--message');
    });

    it('falls back to os.tmpdir() when no workspaceDir is configured', async () => {
      const adapter = new OpenClawCliRuntimeAdapter({ runtimeMode: 'local', agentId: 'diag' });
      stubFirstTwoProbes();
      mockRunCliProcess.mockResolvedValueOnce(makeCliOutput({ exitCode: 0, stderr: successEnvelope() }));

      await adapter.healthCheck();

      const probe3Call = mockRunCliProcess.mock.calls[2]?.[0] as unknown as { args: string[] } | undefined;
      if (!probe3Call) throw new Error('expected probe3 call');
      const filePath = probe3Call.args[probe3Call.args.indexOf('--message-file') + 1] as string;

      // Without workspaceDir, the temp file must NOT be under any .pd/tmp.
      expect(filePath).not.toContain(path.join('.pd', 'tmp'));
      // It should still match the msg-*.json naming convention.
      expect(path.basename(filePath)).toMatch(/^msg-.*\.json$/);
    });
  });

  describe('cleanup runs on BOTH success and failure (finally block)', () => {
    it('deletes the message file after a SUCCESSFUL probe', async () => {
      const adapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: 'local',
        agentId: 'diag',
        workspaceDir: tempWorkspace,
      });
      stubFirstTwoProbes();
      mockRunCliProcess.mockResolvedValueOnce(makeCliOutput({ exitCode: 0, stderr: successEnvelope() }));

      await adapter.healthCheck();

      const probe3Call = mockRunCliProcess.mock.calls[2]?.[0] as unknown as { args: string[] };
      const filePath = probe3Call.args[probe3Call.args.indexOf('--message-file') + 1] as string;

      // ERR-088: the prior test only asserted result.healthy — removing
      // cleanupMessageFile left it green. Now assert the file is GONE.
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('deletes the message file after a TIMED-OUT probe', async () => {
      const adapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: 'local',
        agentId: 'diag',
        workspaceDir: tempWorkspace,
      });
      stubFirstTwoProbes();
      // Capture the file path before the probe runs so we can check cleanup
      // after the early-return on timeout.
      let createdFilePath = '';
      mockRunCliProcess.mockResolvedValueOnce(
        makeCliOutput({ timedOut: true, exitCode: null }),
      );
      // We need the path; intercept by reading it from the mock call args.
      // healthCheck calls writeMessageFile (real) then runCliProcess (mocked).
      // The path is in the 3rd runCliProcess call's args.
      const result = await adapter.healthCheck();

      expect(result.healthy).toBe(false);

      const probe3Call = mockRunCliProcess.mock.calls[2]?.[0] as unknown as { args: string[] };
      createdFilePath = probe3Call.args[probe3Call.args.indexOf('--message-file') + 1] as string;

      // Even on timeout, the finally block must clean up.
      expect(fs.existsSync(createdFilePath)).toBe(false);
    });

    it('deletes the message file after a probe with non-zero exit code', async () => {
      const adapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: 'local',
        agentId: 'diag',
        workspaceDir: tempWorkspace,
      });
      stubFirstTwoProbes();
      mockRunCliProcess.mockResolvedValueOnce(
        makeCliOutput({ exitCode: 1, stderr: 'PluginLoadFailureError' }),
      );

      await adapter.healthCheck();

      const probe3Call = mockRunCliProcess.mock.calls[2]?.[0] as unknown as { args: string[] };
      const filePath = probe3Call.args[probe3Call.args.indexOf('--message-file') + 1] as string;

      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  describe('each probe gets a unique session ID', () => {
    it('generates a distinct --session-id across two consecutive healthChecks', async () => {
      const adapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: 'local',
        agentId: 'diag',
        workspaceDir: tempWorkspace,
      });

      const sessionIds: string[] = [];
      for (let i = 0; i < 2; i++) {
        stubFirstTwoProbes();
        mockRunCliProcess.mockResolvedValueOnce(makeCliOutput({ exitCode: 0, stderr: successEnvelope() }));
        await adapter.healthCheck();

        const probe3Call = mockRunCliProcess.mock.calls[mockRunCliProcess.mock.calls.length - 1]?.[0] as unknown as { args: string[] };
        const sid = probe3Call.args[probe3Call.args.indexOf('--session-id') + 1] as string;
        sessionIds.push(sid);
      }

      // ERR-088: the prior test ran healthCheck ONCE and asserted the prefix,
      // which a hardcoded `pd-runtime-probe-*` ID would also satisfy. Two runs
      // must yield two distinct IDs.
      expect(sessionIds).toHaveLength(2);
      expect(sessionIds[0]).not.toBe(sessionIds[1]);
      expect(sessionIds.every((s) => s.startsWith('pd-runtime-probe-'))).toBe(true);
    });
  });
});
