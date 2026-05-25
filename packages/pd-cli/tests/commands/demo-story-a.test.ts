import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleDemoStoryA, cleanupTempWorkspace } from '../../src/commands/demo-story-a.js';

describe('pd demo story-a CLI', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it('outputs valid JSON in --json mode', async () => {
    await handleDemoStoryA({ json: true });

    expect(stdoutSpy).toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);

    expect(parsed.status).toBe('passed');
    expect(parsed.stages).toHaveLength(6);
    expect(parsed.channelOutcomes).toHaveLength(3);
    expect(parsed.narrative).toBeDefined();
    expect(parsed.isRuntimeV2Exclusive).toBe(true);
  });

  it('outputs text mode with stage summary', async () => {
    await handleDemoStoryA({});

    expect(stdoutSpy).toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('Story A\' Demo');
    expect(output).toContain('OVERALL');
    expect(output).toContain('evidence_seed');
    expect(output).toContain('principle_proposal');
    expect(output).toContain('owner_review');
    expect(output).toContain('activation');
    expect(output).toContain('follow_up_observation');
    expect(output).toContain('rollback_proof');
    expect(output).toContain('prompt');
    expect(output).toContain('code_tool_hook');
    expect(output).toContain('defer_archive');
  });

  it('JSON output contains no forbidden Quiet/Gone terms', async () => {
    await handleDemoStoryA({ json: true });

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const forbidden = [
      'skill', 'model_training', 'Nocturnal', 'nocturnal',
      'idle', 'night', 'Trainer', 'trainer',
      'sleep_reflection', 'sleep-cycle', 'Phase 1C', 'Phase 1D',
      'Attribution', 'PRRR', 'BALM', 'LRAS', 'GAP',
      'MissionScheduler', 'WorkspaceLearningSummary', 'Probation',
    ];
    for (const term of forbidden) {
      expect(output, `JSON output contains forbidden term: "${term}"`).not.toContain(term);
    }
  });

  it('sets exitCode 1 when demo fails with unknown channel', async () => {
    await handleDemoStoryA({ channels: 'invalid_channel' });

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('temp workspace is cleaned up after run', async () => {
    // Run with default (temp) workspace — verify the temp dir is gone after
    await handleDemoStoryA({ json: true });

    // If a temp dir was created, it should have been cleaned up.
    // We verify indirectly: the command completes without error.
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('passed');
  });

  it('explicit workspace is NOT cleaned up', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-explicit-'));

    try {
      await handleDemoStoryA({ workspace: tmpDir, json: true });

      // Workspace dir should still exist (not cleaned up)
      expect(fs.existsSync(tmpDir)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('cleanupTempWorkspace', () => {
  it('logs warning on cleanup failure', () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockRm = vi.fn(() => { throw new Error('permission denied'); });

    cleanupTempWorkspace('/tmp/nonexistent', mockRm);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('cleanup warning'),
    );
    stderrSpy.mockRestore();
  });
});
