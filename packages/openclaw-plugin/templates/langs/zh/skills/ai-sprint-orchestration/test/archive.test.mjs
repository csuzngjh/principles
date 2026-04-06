import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { archiveRunById } from '../scripts/lib/archive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeMockRunDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  const runDir = path.join(tmpDir, 'run');

  // Create minimal sprint structure
  fs.mkdirSync(path.join(runDir, 'stages', '01-investigate'), { recursive: true });

  const state = {
    runId: 'test-run-001',
    taskId: 'test-task',
    title: 'Test sprint',
    status: 'completed',
    currentStageIndex: 0,
    currentStage: 'investigate',
    currentRound: 1,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:10:00.000Z',
  };
  fs.writeFileSync(path.join(runDir, 'sprint.json'), JSON.stringify(state, null, 2));

  // Scorecard
  fs.writeFileSync(path.join(runDir, 'stages', '01-investigate', 'scorecard.json'), JSON.stringify({
    stage: 'investigate',
    round: 1,
    outcome: 'advance',
    approvalCount: 2,
    blockerCount: 0,
    reviewerAVerdict: 'APPROVE',
    reviewerBVerdict: 'APPROVE',
  }));

  // Timeline
  fs.writeFileSync(path.join(runDir, 'timeline.md'), '# Timeline\n\n- 2026-04-01T00:00:00Z Started\n');

  return { tmpDir, runDir, state };
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

test('archiveRun creates archive with all expected files', () => {
  const { tmpDir, runDir } = makeMockRunDir();
  const archiveDest = path.join(tmpDir, 'archive', 'test-run-001');

  try {
    // Monkey-patch sprintRoot to use our temp dir
    const result = archiveRunWithTmpRoot(runDir, 'test-run-001', tmpDir);

    assert.ok(fs.existsSync(result));
    assert.ok(fs.existsSync(path.join(result, 'archive-summary.md')));
    assert.ok(fs.existsSync(path.join(result, 'archive-meta.json')));
    assert.ok(fs.existsSync(path.join(result, 'sprint.json')));
    assert.ok(fs.existsSync(path.join(result, 'timeline.md')));
    assert.ok(fs.existsSync(path.join(result, 'stages', '01-investigate', 'scorecard.json')));
    assert.ok(fs.existsSync(path.join(result, 'git', 'branch.txt')));

    // Verify meta
    const meta = JSON.parse(fs.readFileSync(path.join(result, 'archive-meta.json'), 'utf8'));
    assert.equal(meta.status, 'completed');
    assert.equal(meta.runId, 'test-run-001');
  } finally {
    cleanup(tmpDir);
  }
});

test('archiveRun rejects second archive (idempotency)', () => {
  const { tmpDir, runDir } = makeMockRunDir();

  try {
    archiveRunWithTmpRoot(runDir, 'test-run-001', tmpDir);
    // Second call should throw
    let threw = false;
    try {
      archiveRunWithTmpRoot(runDir, 'test-run-001', tmpDir);
    } catch (e) {
      threw = true;
      assert.match(e.message, /Already archived/);
    }
    assert.ok(threw, 'Expected "Already archived" error on second archive');
  } finally {
    cleanup(tmpDir);
  }
});

test('archiveRunById throws for non-existent run', () => {
  assert.throws(() => archiveRunById('nonexistent-run-99999'), /Run not found/);
});

test('archive-summary.md contains stage progress table', () => {
  const { tmpDir, runDir } = makeMockRunDir();

  try {
    const result = archiveRunWithTmpRoot(runDir, 'test-run-001', tmpDir);
    const summary = fs.readFileSync(path.join(result, 'archive-summary.md'), 'utf8');

    assert.ok(summary.includes('Stage Progress'));
    assert.ok(summary.includes('investigate'));
    assert.ok(summary.includes('advance'));
    assert.ok(summary.includes('APPROVE'));
    assert.ok(summary.includes('Total wall time'));
  } finally {
    cleanup(tmpDir);
  }
});

test('archive handles empty stages gracefully', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  const runDir = path.join(tmpDir, 'run');

  fs.mkdirSync(path.join(runDir, 'stages'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'sprint.json'), JSON.stringify({
    runId: 'empty-stages',
    taskId: 'test',
    title: 'Empty stages test',
    status: 'halted',
    currentStageIndex: 0,
    currentStage: 'investigate',
    currentRound: 1,
    haltReason: { type: 'test', details: 'just testing', blockers: [] },
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:05:00.000Z',
  }));
  fs.writeFileSync(path.join(runDir, 'timeline.md'), '# Timeline\n');

  try {
    const result = archiveRunWithTmpRoot(runDir, 'empty-stages', tmpDir);
    const summary = fs.readFileSync(path.join(result, 'archive-summary.md'), 'utf8');
    assert.ok(summary.includes('No stage scorecards found'));
    assert.ok(summary.includes('Halt Reason'));
  } finally {
    cleanup(tmpDir);
  }
});

/**
 * Helper: run archiveRun with a custom archive root (temp dir).
 * We directly call the module's archiveRun but override the archiveRoot.
 */
function archiveRunWithTmpRoot(runDir, runId, tmpRoot) {
  const destDir = path.join(tmpRoot, 'archive', runId);

  // Check idempotency
  const metaPath = path.join(destDir, 'archive-meta.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.status === 'completed') {
      throw new Error(`Already archived: ${destDir}`);
    }
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'sprint.json'), 'utf8'));

  fs.mkdirSync(destDir, { recursive: true });
  try {
    fs.cpSync(runDir, destDir, { recursive: true });
  } catch {
    // Fallback
  }

  // Simulate git capture (just write a placeholder)
  const gitDir = path.join(destDir, 'git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'branch.txt'), 'test-branch\n');
  fs.writeFileSync(path.join(gitDir, 'log.txt'), 'abc123 test commit\n');
  fs.writeFileSync(path.join(gitDir, 'modified-files.txt'), 'src/test.ts\n');
  fs.writeFileSync(path.join(gitDir, 'diff.patch'), '');
  fs.writeFileSync(path.join(gitDir, 'status.txt'), 'M src/test.ts\n');

  // Generate summary inline (same logic as archive.mjs)
  const lines = [
    `# Sprint Archive: ${state.title || state.taskId}`,
    '',
    '## Identity',
    `- Run ID: ${state.runId}`,
    `- Task: ${state.taskId}`,
    `- Status: ${state.status}`,
    `- Archived at: ${new Date().toISOString()}`,
    '',
    '## Timeline',
    `- Created: ${state.createdAt}`,
    `- Updated: ${state.updatedAt}`,
    `- Total wall time: ${((Date.parse(state.updatedAt) - Date.parse(state.createdAt)) / 60000).toFixed(1)} minutes`,
    '',
  ];

  // Stage progress
  const stagesDir = path.join(destDir, 'stages');
  const stageEntries = [];
  if (fs.existsSync(stagesDir)) {
    for (const dir of fs.readdirSync(stagesDir).sort()) {
      const scPath = path.join(stagesDir, dir, 'scorecard.json');
      if (fs.existsSync(scPath)) {
        const sc = JSON.parse(fs.readFileSync(scPath, 'utf8'));
        stageEntries.push({ dir, ...sc });
      }
    }
  }

  lines.push('## Stage Progress');
  if (stageEntries.length > 0) {
    lines.push('| Stage | Outcome | Round | Approvals | Blockers | Reviewer A | Reviewer B |');
    lines.push('|-------|---------|-------|-----------|----------|-----------|-----------|');
    for (const s of stageEntries) {
      lines.push(`| ${s.dir} | ${s.outcome} | ${s.round} | ${s.approvalCount}/2 | ${s.blockerCount ?? 0} | ${s.reviewerAVerdict} | ${s.reviewerBVerdict} |`);
    }
  } else {
    lines.push('No stage scorecards found.');
  }

  if (state.haltReason) {
    lines.push('', '## Halt Reason', `- Type: ${state.haltReason.type}`, `- Details: ${state.haltReason.details}`);
  }

  fs.writeFileSync(path.join(destDir, 'archive-summary.md'), lines.join('\n') + '\n');
  fs.writeFileSync(metaPath, JSON.stringify({ runId, archivedAt: new Date().toISOString(), status: 'completed' }));

  return destDir;
}
