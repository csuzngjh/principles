import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { ensureDir, readJson, writeJson, writeText, fileExists } from './state-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const sprintRoot = path.join(repoRoot, 'ops', 'ai-sprints');
const archiveRoot = path.join(sprintRoot, 'archive');

function nowIso() {
  return new Date().toISOString();
}

/**
 * Archive a completed/halted sprint run by run ID.
 * CLI entry point for --archive <run-id>.
 */
export function archiveRunById(runId) {
  const runDir = path.join(sprintRoot, runId);
  const sprintFile = path.join(runDir, 'sprint.json');
  if (!fileExists(sprintFile)) {
    throw new Error(`Run not found: ${runId}`);
  }
  return archiveRun(runDir, runId);
}

/**
 * Core archive function. Copies all artifacts, captures git info, generates summary.
 * @param {string} runDir - Path to the sprint run directory
 * @param {string} runId - The run ID
 * @returns {string} Path to the archive directory
 */
export function archiveRun(runDir, runId) {
  const destDir = path.join(archiveRoot, runId);

  // Idempotency: check if already successfully archived
  const metaPath = path.join(destDir, 'archive-meta.json');
  if (fileExists(metaPath)) {
    const meta = readJson(metaPath);
    if (meta.status === 'completed') {
      throw new Error(`Already archived: ops/ai-sprints/archive/${runId}/`);
    }
    // Partial/failed archive — clean up and re-run
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  // Read sprint state
  const state = readJson(path.join(runDir, 'sprint.json'));

  // Warn if archiving a live run
  if (state.status === 'running' || state.status === 'paused') {
    console.error(`Warning: run ${runId} has status '${state.status}'. Archiving a live run may produce incomplete artifacts.`);
  }

  // Step 1: Copy all run artifacts recursively
  ensureDir(destDir);
  try {
    fs.cpSync(runDir, destDir, {
      recursive: true,
      filter: (src) => !src.endsWith('orchestrator.lock'),
    });
  } catch {
    // Fallback for Node < 16.7: manual recursive copy
    copyDirRecursive(runDir, destDir);
  }

  // Step 2: Capture git info
  captureGitInfo(destDir, state);

  // Step 3: Generate summary
  generateSummary(destDir, state);

  // Step 4: Write archive metadata (last — marks archive as complete)
  writeJson(metaPath, {
    runId,
    archivedAt: nowIso(),
    status: 'completed',
    sourceStatus: state.status,
  });

  return destDir;
}

/**
 * Capture git information into the archive's git/ directory.
 * Each command is independent — one failure does not block the rest.
 */
function captureGitInfo(destDir, state) {
  const gitDir = path.join(destDir, 'git');
  ensureDir(gitDir);

  const created = state.createdAt || '';
  const updated = state.updatedAt || nowIso();

  const commands = [
    { file: 'branch.txt', args: ['rev-parse', '--abbrev-ref', 'HEAD'] },
    { file: 'status.txt', args: ['status', '--short'] },
    { file: 'modified-files.txt', args: ['diff', '--name-only', 'HEAD'] },
    { file: 'diff.patch', args: ['diff', 'HEAD'] },
    { file: 'log.txt', args: ['log', '--oneline', `--since=${created}`, `--until=${updated}`] },
  ];

  for (const { file, args } of commands) {
    try {
      const result = spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10_000,
      });
      writeText(path.join(gitDir, file), (result.stdout || '').trim() + '\n');
    } catch {
      writeText(path.join(gitDir, file), `# Git command failed: git ${args.join(' ')}\n`);
    }
  }
}

/**
 * Generate a human-readable archive summary.
 */
function generateSummary(destDir, state) {
  const lines = [];

  // Identity
  lines.push(`# Sprint Archive: ${state.title || state.taskId}`);
  lines.push('');
  lines.push('## Identity');
  lines.push(`- Run ID: ${state.runId}`);
  lines.push(`- Task: ${state.taskId}`);
  lines.push(`- Status: ${state.status}`);
  lines.push(`- Archived at: ${nowIso()}`);
  lines.push('');

  // Timeline
  const created = state.createdAt || '';
  const updated = state.updatedAt || '';
  const elapsedMs = created ? (Date.parse(updated) || Date.now()) - Date.parse(created) : 0;
  const elapsedMin = (elapsedMs / 60_000).toFixed(1);
  lines.push('## Timeline');
  lines.push(`- Created: ${created}`);
  lines.push(`- Updated: ${updated}`);
  lines.push(`- Total wall time: ${elapsedMin} minutes`);
  lines.push(`- Final stage: ${state.currentStage} (index ${state.currentStageIndex})`);
  lines.push(`- Final round: ${state.currentRound}`);
  lines.push('');

  // Stage progress table from scorecards
  lines.push('## Stage Progress');
  const stagesDir = path.join(destDir, 'stages');
  const stageEntries = [];
  if (fileExists(stagesDir)) {
    const dirs = fs.readdirSync(stagesDir).sort();
    for (const dir of dirs) {
      const scorecardPath = path.join(stagesDir, dir, 'scorecard.json');
      if (fileExists(scorecardPath)) {
        const sc = readJson(scorecardPath);
        stageEntries.push({
          dir,
          outcome: sc.outcome || '?',
          round: sc.round || '?',
          approvals: sc.approvalCount ?? '?',
          blockers: sc.blockerCount ?? 0,
          reviewerA: sc.reviewerAVerdict || '?',
          reviewerB: sc.reviewerBVerdict || '?',
        });
      }
    }
  }

  if (stageEntries.length > 0) {
    lines.push('| Stage | Outcome | Round | Approvals | Blockers | Reviewer A | Reviewer B |');
    lines.push('|-------|---------|-------|-----------|----------|-----------|-----------|');
    for (const s of stageEntries) {
      lines.push(`| ${s.dir} | ${s.outcome} | ${s.round} | ${s.approvals}/2 | ${s.blockers} | ${s.reviewerA} | ${s.reviewerB} |`);
    }
  } else {
    lines.push('No stage scorecards found.');
  }
  lines.push('');

  // Git context
  lines.push('## Git Context');
  const gitDir = path.join(destDir, 'git');
  if (fileExists(path.join(gitDir, 'branch.txt'))) {
    lines.push(`- Branch: ${fs.readFileSync(path.join(gitDir, 'branch.txt'), 'utf8').trim()}`);
  }
  if (fileExists(path.join(gitDir, 'log.txt'))) {
    const log = fs.readFileSync(path.join(gitDir, 'log.txt'), 'utf8').trim();
    if (log && !log.startsWith('#')) {
      lines.push('');
      lines.push('### Commits');
      for (const line of log.split('\n').filter(Boolean)) {
        lines.push(`- ${line}`);
      }
    }
  }
  if (fileExists(path.join(gitDir, 'modified-files.txt'))) {
    const files = fs.readFileSync(path.join(gitDir, 'modified-files.txt'), 'utf8').trim();
    if (files && !files.startsWith('#')) {
      lines.push('');
      lines.push('### Modified Files');
      for (const f of files.split('\n').filter(Boolean)) {
        lines.push(`- ${f}`);
      }
    }
  }
  lines.push('');

  // Halt reason
  if (state.haltReason) {
    lines.push('## Halt Reason');
    lines.push(`- Type: ${state.haltReason.type}`);
    lines.push(`- Details: ${state.haltReason.details}`);
    if (state.haltReason.blockers?.length) {
      lines.push('### Blockers');
      for (const b of state.haltReason.blockers) {
        lines.push(`- ${b}`);
      }
    }
    lines.push('');
  }

  // Open risks from verify producer
  const verifyDirs = stageEntries.filter((s) => s.dir.includes('verify'));
  if (verifyDirs.length > 0) {
    const verifyDir = path.join(stagesDir, verifyDirs[verifyDirs.length - 1].dir);
    const producerPath = path.join(verifyDir, 'producer.md');
    if (fileExists(producerPath)) {
      const producerText = fs.readFileSync(producerPath, 'utf8');
      const risksSection = extractSection(producerText, 'OPEN_RISKS');
      if (risksSection) {
        lines.push('## Open Risks (from verify producer)');
        lines.push(risksSection);
        lines.push('');
      }
    }
  }

  writeText(path.join(destDir, 'archive-summary.md'), lines.join('\n') + '\n');
}

/**
 * Extract a markdown section body by heading name.
 */
function extractSection(text, heading) {
  const pattern = new RegExp(`^##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=^##\\s|$(?!\\n))`, 'm');
  const match = text.match(pattern);
  return match ? match[1].trim() : null;
}

/**
 * Fallback recursive directory copy for Node < 16.7.
 */
function copyDirRecursive(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.name === 'orchestrator.lock') continue;
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
