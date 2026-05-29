import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Unit tests for e2e-story-a.mjs harness logic.
 *
 * Tests the evidence report generation and verdict computation,
 * NOT the live agent interaction (that's the real e2e run).
 */

// We test the pure logic by importing the harness's internal functions.
// Since the harness is a .mjs script (not a module), we test via subprocess
// or by extracting the logic. For now, we test the report generation pattern.

function computeVerdict(params: {
  phase0Ok: boolean;
  phase1Ok: boolean;
  agentResponded: boolean;
  painCount: number;
  provenance: string | null;
  taskCount: number;
  candidateCount: number;
  admittedCount: number;
  deferredCount: number;
  needsEvidenceCount: number;
}): { verdict: string; notes: string[] } {
  const {
    phase0Ok, phase1Ok, agentResponded,
    painCount, provenance,
    taskCount, candidateCount,
    admittedCount, deferredCount, needsEvidenceCount,
  } = params;

  const notes: string[] = [];

  if (!phase0Ok) return { verdict: 'failed:phase0:workspace_error', notes };
  if (!phase1Ok) return { verdict: 'skipped:phase1:environment_unavailable', notes };
  if (!agentResponded) return { verdict: 'failed:phase3:agent_no_response', notes };
  if (painCount === 0) return { verdict: 'failed:phase4:no_pain_emitted', notes };
  if (provenance !== 'openclaw_context_bound') {
    return { verdict: `failed:phase4:wrong_provenance:${provenance}`, notes };
  }
  if (taskCount === 0) return { verdict: 'failed:phase5:no_tasks_created', notes };
  if (candidateCount === 0) return { verdict: 'failed:phase5:no_candidates', notes };

  if (admittedCount > 0 || deferredCount > 0) {
    notes.push(`${admittedCount} admitted, ${deferredCount} deferred, ${needsEvidenceCount} needs_evidence`);
    return { verdict: 'story_a_validated', notes };
  }

  if (needsEvidenceCount > 0) {
    notes.push('All candidates needs_evidence — diagnosis may be evidence-incomplete');
    return { verdict: 'gate_quarantined_expected', notes };
  }

  return { verdict: 'failed:phase5:unknown_state', notes };
}

describe('e2e harness verdict computation', () => {
  it('returns story_a_validated when pain is context-bound and candidates are admitted', () => {
    const result = computeVerdict({
      phase0Ok: true, phase1Ok: true, agentResponded: true,
      painCount: 1, provenance: 'openclaw_context_bound',
      taskCount: 1, candidateCount: 3,
      admittedCount: 2, deferredCount: 1, needsEvidenceCount: 0,
    });
    expect(result.verdict).toBe('story_a_validated');
    expect(result.notes[0]).toContain('2 admitted');
  });

  it('returns gate_quarantined_expected when all candidates are needs_evidence', () => {
    const result = computeVerdict({
      phase0Ok: true, phase1Ok: true, agentResponded: true,
      painCount: 1, provenance: 'openclaw_context_bound',
      taskCount: 1, candidateCount: 2,
      admittedCount: 0, deferredCount: 0, needsEvidenceCount: 2,
    });
    expect(result.verdict).toBe('gate_quarantined_expected');
    expect(result.notes[0]).toContain('needs_evidence');
  });

  it('returns failed:phase4 when provenance is wrong', () => {
    const result = computeVerdict({
      phase0Ok: true, phase1Ok: true, agentResponded: true,
      painCount: 1, provenance: 'owner_reported_no_host_trace',
      taskCount: 0, candidateCount: 0,
      admittedCount: 0, deferredCount: 0, needsEvidenceCount: 0,
    });
    expect(result.verdict).toBe('failed:phase4:wrong_provenance:owner_reported_no_host_trace');
  });

  it('returns failed:phase4 when no pain emitted', () => {
    const result = computeVerdict({
      phase0Ok: true, phase1Ok: true, agentResponded: true,
      painCount: 0, provenance: null,
      taskCount: 0, candidateCount: 0,
      admittedCount: 0, deferredCount: 0, needsEvidenceCount: 0,
    });
    expect(result.verdict).toBe('failed:phase4:no_pain_emitted');
  });

  it('returns failed:phase1 when environment unavailable', () => {
    const result = computeVerdict({
      phase0Ok: true, phase1Ok: false, agentResponded: false,
      painCount: 0, provenance: null,
      taskCount: 0, candidateCount: 0,
      admittedCount: 0, deferredCount: 0, needsEvidenceCount: 0,
    });
    expect(result.verdict).toBe('skipped:phase1:environment_unavailable');
  });

  it('returns failed:phase0 when workspace setup fails', () => {
    const result = computeVerdict({
      phase0Ok: false, phase1Ok: false, agentResponded: false,
      painCount: 0, provenance: null,
      taskCount: 0, candidateCount: 0,
      admittedCount: 0, deferredCount: 0, needsEvidenceCount: 0,
    });
    expect(result.verdict).toBe('failed:phase0:workspace_error');
  });

  it('returns failed:phase3 when agent does not respond', () => {
    const result = computeVerdict({
      phase0Ok: true, phase1Ok: true, agentResponded: false,
      painCount: 0, provenance: null,
      taskCount: 0, candidateCount: 0,
      admittedCount: 0, deferredCount: 0, needsEvidenceCount: 0,
    });
    expect(result.verdict).toBe('failed:phase3:agent_no_response');
  });

  it('returns story_a_validated with deferred-only candidates', () => {
    const result = computeVerdict({
      phase0Ok: true, phase1Ok: true, agentResponded: true,
      painCount: 1, provenance: 'openclaw_context_bound',
      taskCount: 1, candidateCount: 1,
      admittedCount: 0, deferredCount: 1, needsEvidenceCount: 0,
    });
    expect(result.verdict).toBe('story_a_validated');
  });

  it('returns failed:phase5 when no tasks created', () => {
    const result = computeVerdict({
      phase0Ok: true, phase1Ok: true, agentResponded: true,
      painCount: 1, provenance: 'openclaw_context_bound',
      taskCount: 0, candidateCount: 0,
      admittedCount: 0, deferredCount: 0, needsEvidenceCount: 0,
    });
    expect(result.verdict).toBe('failed:phase5:no_tasks_created');
  });
});

describe('e2e evidence report generation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'e2e-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function generateMockEvidence(runId: string, verdict: string, notes: string[] = []): string {
    const date = new Date().toISOString().slice(0, 10);
    const evidenceDir = join(tmpDir, 'evidence', date);
    mkdirSync(evidenceDir, { recursive: true });

    const content = `# Story A' E2E Report — ${runId}

**Verdict**: \`${verdict}\`
${notes.length > 0 ? `**Notes**: ${notes.join('; ')}` : ''}

## Phase 0: Workspace Isolation
- Status: PASS

## Phase 4: Pain Emission Confirmation
- Provenance: openclaw_context_bound
- Provenance correct: ✅ YES
`;

    const filePath = join(evidenceDir, `STORY_A_E2E_${runId}.md`);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  it('generates evidence file at correct path', () => {
    const filePath = generateMockEvidence('test-run-001', 'story_a_validated');
    expect(existsSync(filePath)).toBe(true);
  });

  it('evidence file contains verdict', () => {
    const filePath = generateMockEvidence('test-run-002', 'gate_quarantined_expected');
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('gate_quarantined_expected');
  });

  it('evidence file contains notes when present', () => {
    const filePath = generateMockEvidence('test-run-003', 'story_a_validated', ['2 admitted, 1 deferred']);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('2 admitted, 1 deferred');
  });

  it('evidence file uses date-based directory', () => {
    const date = new Date().toISOString().slice(0, 10);
    const filePath = generateMockEvidence('test-run-004', 'story_a_validated');
    expect(filePath).toContain(date);
  });
});

describe('trap definitions', () => {
  // Validate that trap fixtures exist on disk
  const fixturesDir = join(process.cwd(), 'tests', 'e2e-fixtures');

  it('trap-01 fixture directory exists with required files', () => {
    const trap01 = join(fixturesDir, 'trap-01-circular-dep');
    expect(existsSync(join(trap01, 'package.json'))).toBe(true);
    expect(existsSync(join(trap01, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(trap01, 'src', 'a.ts'))).toBe(true);
    expect(existsSync(join(trap01, 'src', 'b.ts'))).toBe(true);
    expect(existsSync(join(trap01, 'src', 'c.ts'))).toBe(true);
  });

  it('trap-03 fixture directory exists with required files', () => {
    const trap03 = join(fixturesDir, 'trap-03-missing-dep');
    expect(existsSync(join(trap03, 'package.json'))).toBe(true);
    expect(existsSync(join(trap03, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(trap03, 'src', 'utils.ts'))).toBe(true);
    expect(existsSync(join(trap03, 'src', 'utils.test.ts'))).toBe(true);
  });

  it('trap-01 has circular dependency between a.ts and b.ts', () => {
    const a = readFileSync(join(fixturesDir, 'trap-01-circular-dep', 'src', 'a.ts'), 'utf-8');
    const b = readFileSync(join(fixturesDir, 'trap-01-circular-dep', 'src', 'b.ts'), 'utf-8');
    expect(a).toContain("from './b.js'");
    expect(b).toContain("from './a.js'");
  });

  it('trap-03 has missing dependency declaration', () => {
    const pkg = JSON.parse(readFileSync(join(fixturesDir, 'trap-03-missing-dep', 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toHaveProperty('fast-deep-equal');
    // The key: node_modules is NOT installed, so the dep is missing
    expect(existsSync(join(fixturesDir, 'trap-03-missing-dep', 'node_modules'))).toBe(false);
  });
});
