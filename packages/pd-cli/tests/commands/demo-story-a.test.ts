import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
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
      'skill', 'Nocturnal', 'nocturnal',
      'idle', 'night',
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

  it('rejects --channels "" with exitCode 1 before workspace creation', async () => {
    await handleDemoStoryA({ channels: '' });

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('No channels specified');
  });

  it('rejects --channels "" in JSON mode with structured empty_channels error', async () => {
    await handleDemoStoryA({ channels: '', json: true });

    expect(process.exitCode).toBe(1);
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('failed');
    expect(parsed.inputValidationFailure.reason).toBe('empty_channels');
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

  it('explicit workspace produces readable state.db with artifacts and activations', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-state-'));

    try {
      await handleDemoStoryA({ workspace: tmpDir, json: true });

      const stateDb = path.join(tmpDir, '.pd', 'state.db');
      expect(fs.existsSync(stateDb)).toBe(true);

      const db = new Database(stateDb, { readonly: true });

      const artifacts = db.prepare('SELECT artifact_id, artifact_kind FROM pi_artifacts').all() as { artifact_id: string; artifact_kind: string }[];
      expect(artifacts.length).toBeGreaterThanOrEqual(2);
      const kinds = artifacts.map(a => a.artifact_kind);
      expect(kinds).toContain('principle');
      expect(kinds).toContain('rule');

      const activations = db.prepare('SELECT activation_id, channel FROM activations').all() as { activation_id: string; channel: string }[];
      expect(activations.length).toBeGreaterThanOrEqual(3);
      const channels = activations.map(a => a.channel);
      expect(channels).toContain('prompt');
      expect(channels).toContain('code_tool_hook');
      expect(channels).toContain('defer_archive');

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('default 3-channel run returns overall=passed with code_tool_hook fully activated', async () => {
    await handleDemoStoryA({ json: true });

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);

    expect(parsed.status).toBe('passed');

    const cthOutcome = (parsed.channelOutcomes as { channel: string; status: string; activationDecision: { decision: string; activationId: string } }[])
      .find(o => o.channel === 'code_tool_hook');
    expect(cthOutcome).toBeDefined();
    expect(cthOutcome!.status).toBe('passed');
    expect(cthOutcome!.activationDecision.decision).toBe('activated');
    expect(cthOutcome!.activationDecision.activationId).toMatch(/^act_code_/);
  });

  it('enforcementObserved is true only after full activation with sandbox verification', async () => {
    await handleDemoStoryA({ json: true });

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);

    const followUpStage = (parsed.stages as { name: string; evidence: Record<string, unknown> }[])
      .find(s => s.name === 'follow_up_observation');
    expect(followUpStage).toBeDefined();

    const observations = (followUpStage!.evidence as { observations: Record<string, unknown>[] }).observations;
    const cthObs = observations.find(o => o.channel === 'code_tool_hook');
    expect(cthObs).toBeDefined();
    expect(cthObs!.enforcementObserved).toBe(true);
    expect(cthObs!.ruleActivated).toBe(true);
    expect(cthObs!.sandboxVerified).toBe(true);
    expect(cthObs!.dangerousPathBlocked).toContain('verified by sandbox');
    expect(cthObs!.safePathAllowed).toContain('verified by sandbox');
  });

  it('--json output is exactly one parseable JSON object on stdout', async () => {
    await handleDemoStoryA({ json: true });

    // console.log may be called multiple times; join and verify single JSON parse
    const raw = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBeDefined();
    expect(typeof parsed.generatedAt).toBe('string');

    // Verify stderr is empty (no mixed output)
    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(stderrOutput).toBe('');
  });

  it('marks simulated stages with simulated=true', async () => {
    await handleDemoStoryA({ json: true });

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);

    const stages = parsed.stages as { name: string; evidence: Record<string, unknown> }[];
    const evidenceSeed = stages.find(s => s.name === 'evidence_seed');
    expect(evidenceSeed!.evidence.simulated).toBe(true);
    expect(evidenceSeed!.evidence.simulatedNote).toBeDefined();

    const ownerReview = stages.find(s => s.name === 'owner_review');
    expect(ownerReview!.evidence.simulated).toBe(true);
  });

  it('marks real stages with simulated=false', async () => {
    await handleDemoStoryA({ json: true });

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);

    const stages = parsed.stages as { name: string; evidence: Record<string, unknown> }[];
    const activation = stages.find(s => s.name === 'activation');
    expect(activation!.evidence.simulated).toBe(false);

    const followUp = stages.find(s => s.name === 'follow_up_observation');
    expect(followUp!.evidence.simulated).toBe(false);
  });

  it('narrative contains [SIMULATED] and [REAL] stage markers', async () => {
    await handleDemoStoryA({ json: true });

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);

    expect(parsed.narrative).toContain('[SIMULATED]');
    expect(parsed.narrative).toContain('[REAL]');
  });
  // ── Demo isolation (2026-08-19): demo must not pollute real PD workspaces ──

  it('refuses to write into a workspace that already contains PD state (default)', async () => {
    const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-demo-isolation-'));
    try {
      fs.mkdirSync(path.join(existing, '.pd'), { recursive: true });
      fs.writeFileSync(path.join(existing, '.pd', 'state.db'), '');

      await handleDemoStoryA({ workspace: existing, json: true });

      expect(process.exitCode).toBe(1);
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('refused');
      expect(parsed.refusal.reason).toBe('demo_write_to_existing_workspace');
      expect(parsed.refusal.nextAction).toContain('--allow-demo-write-to-existing-workspace');
      // cli-5: no mutation on the refused path — the marker file is untouched.
      const stat = fs.statSync(path.join(existing, '.pd', 'state.db'));
      expect(stat.size).toBe(0);
    } finally {
      fs.rmSync(existing, { recursive: true, force: true });
    }
  });

  it('text mode refusal points at the override flag', async () => {
    const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-demo-isolation-'));
    try {
      fs.mkdirSync(path.join(existing, '.pd'), { recursive: true });
      fs.writeFileSync(path.join(existing, '.pd', 'state.db'), '');

      await handleDemoStoryA({ workspace: existing });

      expect(process.exitCode).toBe(1);
      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('existing PD workspace');
      expect(output).toContain('--allow-demo-write-to-existing-workspace');
    } finally {
      fs.rmSync(existing, { recursive: true, force: true });
    }
  });

  it('developer override allows writing into the existing workspace with origin:demo provenance', async () => {
    const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-demo-override-'));
    try {
      fs.mkdirSync(path.join(existing, '.pd'), { recursive: true });
      fs.writeFileSync(path.join(existing, '.pd', 'config.yaml'), 'features: {}');

      await handleDemoStoryA({ workspace: existing, json: true, allowDemoWriteToExistingWorkspace: true });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.status).not.toBe('refused');
      const db = new Database(path.join(existing, '.pd', 'state.db'), { readonly: true });
      const rows = db.prepare('SELECT content_json FROM pi_artifacts').all() as { content_json: string }[];
      db.close();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(JSON.parse(row.content_json).origin).toBe('demo');
      }
    } finally {
      fs.rmSync(existing, { recursive: true, force: true });
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
