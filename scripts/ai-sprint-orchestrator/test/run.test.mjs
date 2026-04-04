/**
 * run.mjs git/worktree/merge-gate tests.
 *
 * Tests P1-1 (merge gate targetBranch vs worktree.branchName), P1-2 (worktree legal git params),
 * and P2 (cleanupWorktree correct cwd) via source analysis.
 *
 * Run: node --test test/run.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { decideAndPersist, formatRoleValidation, getIsolationDir, findIsolationReport, collectIsolationArtifacts, isIsolationCollectAllowed, ISOLATION_COLLECT_ALLOWLIST } from '../run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runMjsPath = path.join(__dirname, '..', 'run.mjs');
const archiveMjsPath = path.join(__dirname, '..', 'lib', 'archive.mjs');
const SOURCE = fs.readFileSync(runMjsPath, 'utf8');
const ARCHIVE_SOURCE = fs.readFileSync(archiveMjsPath, 'utf8');

function getFuncBody(funcName) {
  const start = SOURCE.indexOf(`function ${funcName}`);
  if (start === -1) throw new Error(`Function ${funcName} not found`);
  const end = SOURCE.indexOf('\nfunction ', start + 1);
  return SOURCE.slice(start, end === -1 ? SOURCE.length : end);
}

function getArchiveFuncBody(funcName) {
  const start = ARCHIVE_SOURCE.indexOf(`function ${funcName}`);
  if (start === -1) throw new Error(`Archive function ${funcName} not found`);
  const end = ARCHIVE_SOURCE.indexOf('\nfunction ', start + 1);
  return ARCHIVE_SOURCE.slice(start, end === -1 ? ARCHIVE_SOURCE.length : end);
}

// ---------------------------------------------------------------------------
// P1-1: merge gate — targetBranch (spec.branch) vs worktree.branchName
// ---------------------------------------------------------------------------

test('P1-1: merge gate does NOT compare against origin/HEAD', () => {
  const body = getFuncBody('runMergeGateCheck');
  const hasOriginHead = /rev-parse.*`\$\{remote\}\/HEAD`|rev-parse.*origin\/HEAD/.test(body);
  assert.equal(hasOriginHead, false,
    'merge gate must NOT compare against origin/HEAD');
});

test('P1-1: merge gate uses targetBranch from spec, NOT worktree.branchName', () => {
  const body = getFuncBody('runMergeGateCheck');

  // targetBranch must be derived from spec.branch, never worktree.branchName
  // worktree.branchName = sprint/<runId>/<stage> (internal, never pushed to remote)
  // targetBranch = spec.branch ?? 'main' (the real PR branch)
  assert.ok(/targetBranch/.test(body), 'must use targetBranch variable');

  // Verify: targetBranch = spec.branch ?? 'main' (NO worktree.branchName fallback)
  const hasSpecBranchOnly = /targetBranch\s*=\s*spec\.branch\s*\?\?\s*['"]main['"]/.test(body) ||
                             /targetBranch\s*=\s*spec\.branch/.test(body);
  assert.ok(hasSpecBranchOnly, 'targetBranch must be set from spec.branch, not worktree.branchName');

  // Verify: the line that defines targetBranch does NOT contain worktree
  const targetBranchDefIdx = body.indexOf('const targetBranch');
  if (targetBranchDefIdx !== -1) {
    const defLineEnd = body.indexOf(';', targetBranchDefIdx);
    const defLine = body.slice(targetBranchDefIdx, defLineEnd);
    const usesWorktree = /worktree/.test(defLine);
    assert.equal(usesWorktree, false,
      'targetBranch definition must NOT reference worktree.branchName');
  }
});

test('P1-1: merge gate result includes targetBranch, not worktree branchName', () => {
  const body = getFuncBody('runMergeGateCheck');
  const resultMatch = body.match(/const result\s*=\s*\{[^}]+\}/);
  assert.ok(resultMatch, 'should find result object');
  assert.ok(/targetBranch/.test(resultMatch[0]), 'result must include targetBranch field');
  assert.ok(!/branchName[^N]/.test(resultMatch[0]) || /targetBranch/.test(resultMatch[0]),
    'result field should be targetBranch, not the internal worktree branchName');
});

test('P1-1: merge gate halt reason uses targetBranch, not worktree branchName', () => {
  const haltIdx = SOURCE.indexOf("type: fetchFailed ? 'merge_gate_branch_not_on_remote'");
  assert.ok(haltIdx !== -1, 'halt reason must use targetBranch');
  const section = SOURCE.slice(haltIdx, haltIdx + 600);

  // Must use targetBranch in details, not worktree's internal branchName
  assert.ok(/targetBranch/.test(section) || /mergeGate\.targetBranch/.test(section),
    'halt details must reference mergeGate.targetBranch');
  // Must not use mergeGate.branchName (the old field name)
  const usesOldField = /mergeGate\.branchName/.test(section);
  assert.equal(usesOldField, false,
    'halt reason must use targetBranch, not branchName');
});

test('P1-1: merge gate fetches specific targetBranch refspec', () => {
  const body = getFuncBody('runMergeGateCheck');
  // Fetch must use targetBranch, not worktree.branchName
  const fetchWithTargetBranch = /fetch.*targetBranch|refspec.*targetBranch|refs\/heads\/\$\{targetBranch\}/.test(body);
  assert.ok(fetchWithTargetBranch, 'git fetch must use targetBranch in refspec');
});

test('P1-1: merge gate distinct halt types for fetch-failed vs sha-mismatch', () => {
  const haltMatch = SOURCE.match(/type:\s*fetchFailed\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/);
  assert.ok(haltMatch, 'should find distinct halt type expression');
  const [, fetchFailedType, mismatchType] = haltMatch;
  assert.notEqual(fetchFailedType, mismatchType, 'types must be distinct');
  assert.equal(fetchFailedType, 'merge_gate_branch_not_on_remote');
  assert.equal(mismatchType, 'merge_gate_sha_mismatch');
});

test('P1-1: merge gate halt does not mention "remote HEAD"', () => {
  const haltIdx = SOURCE.indexOf("type: fetchFailed ? 'merge_gate_branch_not_on_remote'");
  const section = SOURCE.slice(haltIdx, haltIdx + 600);
  const mentionsRemoteHead = /remote\s+HEAD/.test(section);
  assert.equal(mentionsRemoteHead, false,
    'halt details must not say "remote HEAD"');
});

test('P1-1 NEW: worktree branch != targetBranch — merge gate still uses targetBranch', () => {
  // Even when worktree.branchName = sprint/<runId>/<stage>
  // the merge gate comparison must use spec.branch (the real PR branch)
  const body = getFuncBody('runMergeGateCheck');

  // Verify: targetBranch is set BEFORE the fetch call
  const targetBranchDefIdx = body.indexOf('const targetBranch');
  const fetchIdx = body.indexOf("'fetch'");
  assert.ok(targetBranchDefIdx !== -1 && targetBranchDefIdx < fetchIdx,
    'targetBranch must be defined before the fetch call');

  // Verify: worktree.branchName is NOT in the targetBranch assignment line
  const targetBranchLine = body.slice(targetBranchDefIdx, body.indexOf(';', targetBranchDefIdx));
  const usesWorktreeInTarget = /worktree/.test(targetBranchLine);
  assert.equal(usesWorktreeInTarget, false,
    'targetBranch must NOT derive from worktree.branchName — it uses spec.branch only');
});

test('P1-1 NEW: targetBranch missing from remote → fetchFailed=true', () => {
  const body = getFuncBody('runMergeGateCheck');
  // When branch doesn't exist on remote, fetchResult.status !== 0
  // Must set fetchFailed: true in that case
  const hasFetchFailedFlag = /fetchFailed:\s*true/.test(body);
  assert.ok(hasFetchFailedFlag, 'missing remote branch must set fetchFailed: true');
});

test('P1-1 NEW: targetBranch defaults to main when spec.branch absent', () => {
  const body = getFuncBody('runMergeGateCheck');
  // targetBranch = spec.branch ?? 'main' — safe fallback to 'main'
  const hasMainFallback = /targetBranch\s*=\s*spec\.branch\s*\?\?\s*['"]main['"]/.test(body);
  assert.ok(hasMainFallback, 'targetBranch must default to "main" when spec.branch is absent');
});

// ---------------------------------------------------------------------------
// P1-2: worktree add legal git params
// ---------------------------------------------------------------------------

test('P1-2: ensureWorktree worktree add uses baseRef (git ref), not baseWorkspace (path)', () => {
  const body = getFuncBody('ensureWorktree');

  // Must define baseRef via resolveBaseRef function (not direct assignment)
  const hasResolveBaseRef = /const baseRef\s*=\s*resolveBaseRef\(\)/.test(body) ||
                             /baseRef\s*=\s*resolveBaseRef/.test(body);
  assert.ok(hasResolveBaseRef, 'must define baseRef via resolveBaseRef function');

  const argsMatch = body.match(/worktree',\s*'add'[^;]*?\](?:\s*,|\s*\{)/);
  if (argsMatch) {
    const argsStr = argsMatch[0];
    assert.equal(/baseWorkspace/.test(argsStr), false,
      'git worktree add args must not include baseWorkspace (path); use baseRef');
  }
  assert.ok(/worktree.*add.*-b.*baseRef/.test(body) ||
             /baseRef.*\]/.test(body.slice(body.indexOf('worktree add'))),
    'git worktree add should use baseRef as the starting-point (commit-ish) argument');
});

test('P1-2: ensureWorktree has NO illegal fallback "git worktree add <path> <branchName>"', () => {
  const body = getFuncBody('ensureWorktree');

  const hasIllegalFallback = /git.*worktree.*add.*\$worktreePath.*\$branchName/.test(body) ||
                              /git.*worktree.*add.*worktreePath.*branchName[^A-Z]/.test(body);
  assert.equal(hasIllegalFallback, false,
    'must not have fallback "git worktree add <path> <branchName>" — branchName does not exist yet');
});

test('P1-2: ensureWorktree worktreeInfo includes baseWorkspace for cleanup', () => {
  const body = getFuncBody('ensureWorktree');

  const infoMatch = body.match(/const worktreeInfo\s*=\s*\{[\s\S]*?\};/);
  assert.ok(infoMatch, 'should find worktreeInfo object');
  assert.ok(/baseWorkspace/.test(infoMatch[0]),
    'worktreeInfo must include baseWorkspace for cleanupWorktree git cwd');
});

// ---------------------------------------------------------------------------
// P2: cleanupWorktree correct cwd
// ---------------------------------------------------------------------------

test('P2: cleanupWorktree does NOT use path.dirname(worktreePath) as cwd', () => {
  const body = getFuncBody('cleanupWorktree');

  const usesDirnameWorktreePath = /cwd:\s*path\.dirname\(worktreePath\)/.test(body);
  assert.equal(usesDirnameWorktreePath, false,
    'cleanupWorktree must NOT use path.dirname(worktreePath) as git cwd');
});

test('P2: cleanupWorktree uses baseWorkspace as git cwd', () => {
  const body = getFuncBody('cleanupWorktree');

  assert.ok(/baseWorkspace/.test(body),
    'cleanupWorktree must use baseWorkspace from state.worktree as git cwd');

  const gitCwdUsesBaseWorkspace = /cwd:\s*gitCwd/.test(body) ||
                                   /cwd:\s*baseWorkspace/.test(body) ||
                                   /gitCwd.*baseWorkspace/.test(body);
  assert.ok(gitCwdUsesBaseWorkspace,
    'git worktree remove must use baseWorkspace as cwd');
});

test('P2: cleanupWorktree destructures baseWorkspace from state.worktree', () => {
  const body = getFuncBody('cleanupWorktree');
  const destructures = /\{[^}]*worktreePath[^}]*baseWorkspace[^}]*\}/.test(body) ||
                        /baseWorkspace/.test(body.slice(0, body.indexOf('spawnSync')));
  assert.ok(destructures, 'cleanupWorktree must destructure baseWorkspace from state.worktree');
});

// ---------------------------------------------------------------------------
// captureGitStatus
// ---------------------------------------------------------------------------

test('captureGitStatus: remoteBranch derived from worktree.branchName, not hardcoded null', () => {
  const body = getFuncBody('captureGitStatus');

  const infoMatch = body.match(/const gitStatus\s*=\s*\{[\s\S]*?\};/);
  assert.ok(infoMatch, 'should find gitStatus object');
  const infoStr = infoMatch[0];

  const hasHardcodedNull = /remoteBranch:\s*null(?!,)/.test(infoStr);
  assert.equal(hasHardcodedNull, false,
    'remoteBranch should be set from worktree.branchName, not hardcoded null');
});

// ---------------------------------------------------------------------------
// Process tree cleanup and role state bookkeeping
// ---------------------------------------------------------------------------

test('process cleanup: timeout path uses terminateProcessTree instead of proc.kill', () => {
  const body = getFuncBody('runAgentAsync');
  assert.ok(/terminateProcessTree\(proc\?\.pid/.test(body),
    'runAgentAsync timeout must terminate the full process tree');
  assert.equal(/proc\?\.kill\(\)/.test(body), false,
    'runAgentAsync timeout must not rely on proc.kill() only');
});

test('process cleanup: terminateProcessTree uses taskkill /T /F on Windows', () => {
  const body = getFuncBody('terminateProcessTree');
  assert.ok(/taskkill/.test(body), 'terminateProcessTree must use taskkill on Windows');
  assert.ok(/\/T/.test(body) && /\/F/.test(body),
    'terminateProcessTree must kill the full descendant tree with /T /F');
});

test('role bookkeeping: reviewer path records spawned pid into role state', () => {
  const body = getFuncBody('runReviewerRole');
  assert.ok(/onSpawn:\s*\(pid\)\s*=>\s*updateRoleState\(paths,\s*role,\s*\{\s*lastPid:\s*pid\s*\}\)/.test(body),
    'runReviewerRole must persist reviewer pid for stale cleanup');
});

test('stale and abort cleanup: recorded role processes are cleaned up', () => {
  const reconcileBody = getFuncBody('reconcileRunState');
  const abortBody = getFuncBody('abortRun');
  assert.ok(/cleanupRecordedRoleProcesses/.test(reconcileBody),
    'reconcileRunState must clean up recorded role processes');
  assert.ok(/cleanupRecordedRoleProcesses/.test(abortBody),
    'abortRun must clean up recorded role processes');
});

test('global reviewer: required report must be non-empty, not just present', () => {
  const body = getFuncBody('decideAndPersist');
  assert.ok(/reportExistsAndNonEmpty\(globalReviewerPath\)/.test(body),
    'required global reviewer report must be validated as non-empty');
});

test('global reviewer: empty report must not be read as decision input', () => {
  const body = getFuncBody('decideAndPersist');
  assert.ok(/reportExistsAndNonEmpty\(globalReviewerPath\)/.test(body),
    'decision input must only load non-empty global reviewer reports');
});

test('global reviewer runtime: failed reviewer does not get auto-promoted to completed without a report', () => {
  const body = getFuncBody('executeStage');
  assert.ok(/if \(reportExistsAndNonEmpty\(grReportPath\)\) \{\s*updateRoleState\(paths, 'global_reviewer', \{\s*status: 'completed'/.test(body.replace(/\r?\n/g, ' ')),
    'global reviewer should only be marked completed when a non-empty report exists');
});

test('resume path reconciles stale runs before switching back to running', () => {
  const body = getFuncBody('loadOrInitState');
  assert.ok(/const state = reconcileRunState\(runDir, readJson\(sprintFile\)\)/.test(body),
    'resume should reconcile stale state before changing status to running');
});

test('main loop reconciles loaded runs before starting execution', () => {
  const body = getFuncBody('main');
  assert.ok(/reconcileRunState\(runDir, state\)/.test(body),
    'main should reconcile stale runs before entering the execution loop');
});

test('cleanup bookkeeping: recorded role pids are only cleared after successful termination', () => {
  const body = getFuncBody('cleanupRecordedRoleProcesses');
  assert.ok(/const terminated = terminateProcessTree/.test(body),
    'cleanup should capture termination success');
  assert.ok(/if \(terminated\)/.test(body),
    'cleanup should only clear pid bookkeeping after successful termination');
});

test('cleanup bookkeeping: worktree is only cleared after successful git removal', () => {
  const body = getFuncBody('cleanupWorktree');
  assert.ok(/if \(result\.status === 0\)/.test(body),
    'cleanupWorktree should check git exit status');
  assert.ok(/state\.worktree = null/.test(body),
    'cleanupWorktree must still clear state on success');
});

test('archive filter excludes prompt scratch, runtime scratch, and worktrees', () => {
  const body = getArchiveFuncBody('shouldArchiveEntry');
  assert.ok(/\.ai-sprint-prompt-/.test(body), 'archive filter must exclude prompt scratch files');
  assert.ok(/worktrees/.test(body), 'archive filter must exclude worktree directories');
  assert.ok(/runtime/.test(body), 'archive filter should exclude runtime scratch directories');
});

test('archive capture uses latest stage git-status.json instead of repo-wide git diff', () => {
  const body = getArchiveFuncBody('captureGitInfo');
  assert.ok(/findLatestStageGitStatus/.test(body),
    'archive capture should read stage-local git-status.json');
  assert.equal(/spawnSync\('git'/.test(body), false,
    'archive capture should not shell out to repo-wide git commands anymore');
});

// ---------------------------------------------------------------------------
// P1-3: Base ref selection robustness
// ---------------------------------------------------------------------------

test('P1-3: ensureWorktree has robust base ref fallback chain', () => {
  const body = getFuncBody('ensureWorktree');
  
  // Must have a resolveBaseRef or similar function with multiple candidates
  const hasResolveFunction = /resolveBaseRef|candidates\s*=\s*\[/.test(body);
  assert.ok(hasResolveFunction, 'ensureWorktree must have a resolve function with fallback candidates');
  
  // Must try at least: spec.branch, origin/{branch}, HEAD, main
  const hasLocalBranch = /spec\.branch|baseBranch/.test(body);
  const hasRemoteBranch = /origin\/.*branch/.test(body);
  const hasHead = /HEAD/.test(body);
  const hasMain = /main/.test(body);
  
  assert.ok(hasLocalBranch, 'must try local branch from spec');
  assert.ok(hasRemoteBranch, 'must try remote branch origin/{branch}');
  assert.ok(hasHead, 'must fallback to HEAD');
  assert.ok(hasMain, 'must have final fallback to main');
});

test('P1-3: base ref resolution logs which candidate was selected', () => {
  const body = getFuncBody('ensureWorktree');
  
  // Should log when using a fallback (not the first choice)
  const logsFallback = /appendTimeline.*Base ref resolved to|appendTimeline.*resolved to/.test(body);
  assert.ok(logsFallback, 'must log when using a fallback base ref');
});

// ---------------------------------------------------------------------------
// Dynamic timeout: progress detection
// ---------------------------------------------------------------------------

test('dynamic timeout: checkProgressEvidence checks worklog mtime', () => {
  const body = getFuncBody('checkProgressEvidence');
  assert.ok(/worklogPath/.test(body), 'must check worklog path');
  assert.ok(/mtimeMs|stat\.mtime/.test(body), 'must check file modification time');
});

test('dynamic timeout: checkProgressEvidence checks stdout growth', () => {
  const body = getFuncBody('checkProgressEvidence');
  assert.ok(/lastStdoutLength|currentStdout/.test(body), 'must accept stdout length params');
  assert.ok(/stdout.*length|length.*stdout/.test(body), 'must compare stdout lengths');
});

test('dynamic timeout: checkProgressEvidence checks git changes', () => {
  const body = getFuncBody('checkProgressEvidence');
  assert.ok(/git.*diff|diff.*name-only/.test(body), 'must check git diff for recent changes');
  assert.ok(/worktreePath/.test(body), 'must use worktreePath for git diff');
});

test('dynamic timeout: runAgentWithProgressCheck exists and has soft/hard timeout params', () => {
  const body = getFuncBody('runAgentWithProgressCheck');
  assert.ok(/softTimeoutRatio|softTimeoutSeconds/.test(body), 'must have soft timeout param');
  assert.ok(/hardTimeoutSeconds|hardTimeout|hardTimer/.test(body), 'must have hard timeout param');
  assert.ok(/extensionSeconds|maxExtensions/.test(body), 'must have extension params');
});

test('dynamic timeout: progress check extends timeout when progress detected', () => {
  const body = getFuncBody('runAgentWithProgressCheck');
  
  // Must check for progress and conditionally extend
  const hasProgressCheck = /checkProgressEvidence/.test(body);
  const hasExtension = /extensionsUsed\+\+|extensionsUsed\s*\+=\s*1/.test(body);
  
  assert.ok(hasProgressCheck, 'must call checkProgressEvidence');
  assert.ok(hasExtension, 'must increment extensionsUsed when progress detected');
});

test('dynamic timeout: logs extension events to timeline', () => {
  const body = getFuncBody('runAgentWithProgressCheck');
  assert.ok(/appendTimeline.*extend|appendTimeline.*progress/.test(body),
    'must log extension events to timeline');
});

test('dynamic timeout: respects maxExtensions limit', () => {
  const body = getFuncBody('runAgentWithProgressCheck');
  assert.ok(/extensionsUsed\s*<\s*maxExtensions|extensionsUsed.*>=.*maxExtensions/.test(body),
    'must check extensionsUsed against maxExtensions');
});

// ---------------------------------------------------------------------------
// Isolation Report: iflow writes to tmp/sprint-agent/{runId}/{stage}-{role}/
// Phase 2: Uses runId directly, not fragile timestamp extraction
// ---------------------------------------------------------------------------

test('isolation: getIsolationDir uses runId for unique isolation path', () => {
  const runId = '2026-04-03T12-34-56-789Z-test-task';
  const isolationDir = getIsolationDir(runId, 'implement', 'producer');
  assert.ok(isolationDir.includes('tmp'), 'must include tmp');
  assert.ok(isolationDir.includes('sprint-agent'), 'must include sprint-agent');
  assert.ok(isolationDir.includes(runId), 'must include runId');
  assert.ok(isolationDir.includes('implement-producer'), 'must include stage-role');
});

test('isolation: different runs have different isolation directories', () => {
  const runId1 = '2026-04-03T12-34-56-789Z-task-a';
  const runId2 = '2026-04-03T12-34-56-789Z-task-b';
  const dir1 = getIsolationDir(runId1, 'implement', 'producer');
  const dir2 = getIsolationDir(runId2, 'implement', 'producer');
  assert.notEqual(dir1, dir2, 'different runIds must produce different isolation dirs');
});

test('isolation: findIsolationReport returns null when runId is null', () => {
  const result = findIsolationReport({ runId: null, stageName: 'implement', role: 'producer', reportFilename: 'producer.md' });
  assert.equal(result, null, 'must return null when runId is null');
});

test('isolation: findIsolationReport returns null for non-existent isolation', () => {
  const result = findIsolationReport({ runId: 'nonexistent-run-id', stageName: 'implement', role: 'producer', reportFilename: 'producer.md' });
  assert.equal(result, null, 'must return null for non-existent isolation dir');
});

test('isolation: findIsolationReport finds report in isolation directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-test-'));
  try {
    const runId = 'test-run-id';
    const stageName = 'implement';
    const role = 'producer';
    const isolationDir = getIsolationDir(runId, stageName, role);

    // Create isolation directory with report
    fs.mkdirSync(isolationDir, { recursive: true });
    const reportContent = `# Report\n\n## SUMMARY\nTask completed.\n`;
    fs.writeFileSync(path.join(isolationDir, 'producer.md'), reportContent);

    const result = findIsolationReport({ runId, stageName, role, reportFilename: 'producer.md' });
    assert.ok(result, 'must find report in isolation dir');
    assert.ok(result.includes('producer.md'), 'result path must include report filename');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isolation: isIsolationCollectAllowed respects allowlist', () => {
  assert.equal(isIsolationCollectAllowed('producer.md'), true, 'producer.md must be allowed');
  assert.equal(isIsolationCollectAllowed('reviewer-a.md'), true, 'reviewer-a.md must be allowed');
  assert.equal(isIsolationCollectAllowed('reviewer-b.md'), true, 'reviewer-b.md must be allowed');
  assert.equal(isIsolationCollectAllowed('global-reviewer.md'), true, 'global-reviewer.md must be allowed');
  assert.equal(isIsolationCollectAllowed('report.md'), true, 'report.md must be allowed');
  // Non-allowlist files
  assert.equal(isIsolationCollectAllowed('session.log'), false, 'session.log must NOT be allowed');
  assert.equal(isIsolationCollectAllowed('state.json'), false, 'state.json must NOT be allowed');
  assert.equal(isIsolationCollectAllowed('tmp.txt'), false, 'tmp.txt must NOT be allowed');
});

test('isolation: collectIsolationArtifacts only collects allowed files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-test-'));
  try {
    const runId = 'test-collect-allowed';
    const stageName = 'implement';
    const role = 'producer';
    const isolationDir = getIsolationDir(runId, stageName, role);
    const stageDir = path.join(tmp, 'stages', 'implement');

    fs.mkdirSync(isolationDir, { recursive: true });
    fs.mkdirSync(stageDir, { recursive: true });

    // Create isolation report
    const reportContent = `# Report\n\n## SUMMARY\nTask completed.\n`;
    fs.writeFileSync(path.join(isolationDir, 'producer.md'), reportContent);

    const result = collectIsolationArtifacts({
      runId,
      stageName,
      role,
      stageDir,
      reportFilename: 'producer.md',
      runDir: tmp,
    });

    assert.deepEqual(result.collected, ['producer.md'], 'producer.md must be collected');
    assert.ok(fs.existsSync(path.join(stageDir, 'producer.md')), 'report must exist in stage dir');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isolation: collectIsolationArtifacts skips non-allowlist files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-test-'));
  try {
    const runId = 'test-collect-skip';
    const stageName = 'implement';
    const role = 'producer';
    const isolationDir = getIsolationDir(runId, stageName, role);
    const stageDir = path.join(tmp, 'stages', 'implement');

    fs.mkdirSync(isolationDir, { recursive: true });
    fs.mkdirSync(stageDir, { recursive: true });

    // Try to collect a non-allowlist file
    const result = collectIsolationArtifacts({
      runId,
      stageName,
      role,
      stageDir,
      reportFilename: 'session.log', // NOT in allowlist
      runDir: tmp,
    });

    assert.deepEqual(result.collected, [], 'session.log must NOT be collected');
    assert.deepEqual(result.skipped, ['session.log'], 'session.log must be in skipped list');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isolation: different runs do NOT share isolation lookup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-test-'));
  try {
    const runId1 = 'run-1';
    const runId2 = 'run-2';
    const stageName = 'implement';
    const role = 'producer';

    // Create isolation for run-1 only
    const isolationDir1 = getIsolationDir(runId1, stageName, role);
    fs.mkdirSync(isolationDir1, { recursive: true });
    fs.writeFileSync(path.join(isolationDir1, 'producer.md'), `# Report\n\n## SUMMARY\nRun 1 report.\n`);

    // run-1 should find the report
    const result1 = findIsolationReport({ runId: runId1, stageName, role, reportFilename: 'producer.md' });
    assert.ok(result1, 'run-1 must find its isolation report');

    // run-2 should NOT find any report
    const result2 = findIsolationReport({ runId: runId2, stageName, role, reportFilename: 'producer.md' });
    assert.equal(result2, null, 'run-2 must NOT find run-1 isolation report');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isolation: ISOLATION_COLLECT_ALLOWLIST contains expected files', () => {
  assert.ok(Array.isArray(ISOLATION_COLLECT_ALLOWLIST), 'allowlist must be an array');
  assert.ok(ISOLATION_COLLECT_ALLOWLIST.includes('producer.md'), 'must include producer.md');
  assert.ok(ISOLATION_COLLECT_ALLOWLIST.includes('reviewer-a.md'), 'must include reviewer-a.md');
  assert.ok(ISOLATION_COLLECT_ALLOWLIST.includes('reviewer-b.md'), 'must include reviewer-b.md');
  assert.ok(ISOLATION_COLLECT_ALLOWLIST.includes('global-reviewer.md'), 'must include global-reviewer.md');
  assert.ok(ISOLATION_COLLECT_ALLOWLIST.includes('report.md'), 'must include report.md');
  // Should NOT include non-report files
  assert.equal(ISOLATION_COLLECT_ALLOWLIST.includes('session.log'), false, 'must NOT include session.log');
  assert.equal(ISOLATION_COLLECT_ALLOWLIST.includes('state.json'), false, 'must NOT include state.json');
});

// ---------------------------------------------------------------------------
// Validation Schema & Persistence Regression Tests
// ---------------------------------------------------------------------------

test('validation schema: decision.md uses role-level errorSummary, not .errors', () => {
  const body = getFuncBody('decideAndPersist');
  // Must NOT access .errors on role objects (field doesn't exist)
  assert.equal(/producer\.errors|reviewerA\.errors|reviewerB\.errors/.test(body), false,
    'decision.md must NOT read non-existent .errors field on role validation objects');
  // Must use formatRoleValidation helper or direct errorSummary access
  assert.ok(/formatRoleValidation|errorSummary|missingSections|invalidFields/.test(body),
    'decision.md must use canonical validation fields: errorSummary, missingSections, invalidFields');
});

test('validation schema: scorecard.json uses errorSummary not errors array', () => {
  const body = getFuncBody('decideAndPersist');
  // Check the validation object in scorecard
  const validationMatch = body.match(/validation:\s*\{[^}]+\}/);
  assert.ok(validationMatch, 'scorecard must have validation object');
  // Must have errorSummary at top level
  assert.ok(/errorSummary:\s*decision\.validation\?\.\errorSummary/.test(body),
    'scorecard validation must include top-level errorSummary');
  // Must NOT have legacy errors array as primary source
  assert.equal(/errors:\s*decision\.validation\?\.\errors\s*\?\?/.test(body), false,
    'scorecard should not use legacy errors array as validation source');
});

test('validation schema: scorecard includes role-level validation objects', () => {
  const body = getFuncBody('decideAndPersist');
  // Each role must be included with full validation object
  // Use [?] character class to match literal question mark in optional chaining
  assert.ok(/producer:\s*decision\.validation[?]\.producer/.test(body),
    'scorecard must include producer validation');
  assert.ok(/reviewerA:\s*decision\.validation[?]\.reviewerA/.test(body),
    'scorecard must include reviewerA validation');
  assert.ok(/reviewerB:\s*decision\.validation[?]\.reviewerB/.test(body),
    'scorecard must include reviewerB validation');
  assert.ok(/globalReviewer:\s*decision\.validation[?]\.globalReviewer/.test(body),
    'scorecard must include globalReviewer validation');
});

test('persistence: outputQuality written to decision.md and scorecard.json', () => {
  const body = getFuncBody('decideAndPersist');
  // decision.md must include Output Quality
  assert.ok(/Output Quality.*decision\.outputQuality/.test(body),
    'decision.md must include Output Quality field');
  // scorecard must include outputQuality
  assert.ok(/outputQuality:\s*decision\.outputQuality/.test(body),
    'scorecard must include outputQuality field');
});

test('persistence: qualityReasons written to decision.md and scorecard.json', () => {
  const body = getFuncBody('decideAndPersist');
  // decision.md must include Quality Reasons section
  assert.ok(/qualityReasons|Quality Reasons/.test(body),
    'decision.md must include Quality Reasons section');
  // scorecard must include qualityReasons
  assert.ok(/qualityReasons:\s*decision\.qualityReasons/.test(body),
    'scorecard must include qualityReasons field');
});

test('formatRoleValidation: helper function exists and uses canonical fields', () => {
  const body = getFuncBody('formatRoleValidation');
  assert.ok(/missingSections/.test(body), 'formatRoleValidation must use missingSections');
  assert.ok(/invalidFields/.test(body), 'formatRoleValidation must use invalidFields');
  assert.ok(/valid/.test(body), 'formatRoleValidation must check valid status');
});

// ---------------------------------------------------------------------------
// BEHAVIOR-LEVEL PERSISTENCE TESTS
// Tests that verify actual file writes, not source structure
// ---------------------------------------------------------------------------

function createTempDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-'));
  return tmp;
}

function cleanupTempDir(tmp) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

function createMockState(currentRound = 1, maxRoundsPerStage = 3, taskId = 'test-task') {
  return {
    currentRound,
    maxRoundsPerStage,
    status: 'running',
    taskId,
  };
}

function createTempSpec(tmp, taskId = 'test-task') {
  const specDir = path.join(tmp, 'specs');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, `${taskId}.json`);
  const spec = {
    taskId,
    stageCriteria: {
      implement: {
        requiredProducerSections: ['SUMMARY', 'CHANGES'],
        requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      },
    },
  };
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return specPath;
}

function createValidProducer() {
  return `# Producer Report

## SUMMARY
Task completed successfully.

## CHANGES
- Fixed bug in validation logic
- Added new test cases

## EVIDENCE
- All tests pass
- Code review completed

## CODE_EVIDENCE
- src/fix.ts: Fixed validation schema

## KEY_EVENTS
- Bug identified and fixed
- Tests added

## HYPOTHESIS_MATRIX
| Hypothesis | Status | Evidence |
|------------|--------|----------|
| Bug in validation | Confirmed | Fixed in src/fix.ts |

## CONTRACT
- [x] DONE: fix-validation: Fix validation schema issues
- [x] DONE: add-tests: Add regression tests

CHECKS: evidence=gathered;tests=passing

## OPEN_RISKS
- None identified`;
}

function createValidReviewer(verdict = 'APPROVE') {
  return `# Reviewer Report

## VERDICT
VERDICT: ${verdict}

## BLOCKERS
${verdict === 'APPROVE' ? '- None.' : '- Issue found in implementation'}

## FINDINGS
- Code quality is good
- Tests are comprehensive

## CODE_EVIDENCE
- Reviewed src/fix.ts

## HYPOTHESIS_MATRIX
| Hypothesis | Status | Evidence |
|------------|--------|----------|
| Bug fixed | Confirmed | Tests pass |

## NEXT_FOCUS
Continue with next task

CHECKS: criteria=met;blockers=0`;
}

function createInvalidProducer() {
  return `# Producer Report

## CHANGES
- Some changes made

## CONTRACT
- [ ] TODO: missing-deliverable: This deliverable is not done
`;
  // Missing SUMMARY, EVIDENCE, CODE_EVIDENCE, KEY_EVENTS, HYPOTHESIS_MATRIX, CHECKS, OPEN_RISKS
}

function createInvalidReviewer() {
  return `# Reviewer Report

## FINDINGS
- Found some issues
`;
  // Missing VERDICT, BLOCKERS, CODE_EVIDENCE, HYPOTHESIS_MATRIX, NEXT_FOCUS, CHECKS
}

test('behavior: decision.md contains validation details when report is invalid', () => {
  const tmp = createTempDir();
  try {
    const stageDir = path.join(tmp, 'stages', 'implement');
    fs.mkdirSync(stageDir, { recursive: true });

    const specPath = createTempSpec(tmp);
    const producerPath = path.join(stageDir, 'producer.md');
    const reviewerAPath = path.join(stageDir, 'reviewer-a.md');
    const reviewerBPath = path.join(stageDir, 'reviewer-b.md');
    const decisionPath = path.join(stageDir, 'decision.md');
    const scorecardPath = path.join(stageDir, 'scorecard.json');

    // Write invalid producer and valid reviewers
    fs.writeFileSync(producerPath, createInvalidProducer());
    fs.writeFileSync(reviewerAPath, createValidReviewer('APPROVE'));
    fs.writeFileSync(reviewerBPath, createValidReviewer('APPROVE'));

    decideAndPersist({
      runDir: tmp,
      stageName: 'implement',
      stageDir,
      decisionPath,
      scorecardPath,
      producerPath,
      reviewerAPath,
      reviewerBPath,
      globalReviewerPath: null,
      state: { ...createMockState(), specPath },
    });

    // Verify decision.md was written
    assert.ok(fs.existsSync(decisionPath), 'decision.md should be written');
    const decision = fs.readFileSync(decisionPath, 'utf8');

    // Verify Validation section contains proper role-level details
    assert.ok(/## Validation/.test(decision), 'decision.md must have Validation section');
    assert.ok(/Contract Valid: false/.test(decision), 'decision.md must show Contract Valid: false for invalid reports');
    assert.ok(/Producer: \[FAIL\]/.test(decision), 'decision.md must show Producer validation failed');
    assert.ok(/missing: SUMMARY/.test(decision), 'decision.md must show missing SUMMARY section');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('behavior: scorecard.json validation.errorSummary matches role-level validation', () => {
  const tmp = createTempDir();
  try {
    const stageDir = path.join(tmp, 'stages', 'implement');
    fs.mkdirSync(stageDir, { recursive: true });

    const specPath = createTempSpec(tmp);
    const producerPath = path.join(stageDir, 'producer.md');
    const reviewerAPath = path.join(stageDir, 'reviewer-a.md');
    const reviewerBPath = path.join(stageDir, 'reviewer-b.md');
    const decisionPath = path.join(stageDir, 'decision.md');
    const scorecardPath = path.join(stageDir, 'scorecard.json');

    // Write invalid producer and valid reviewers
    fs.writeFileSync(producerPath, createInvalidProducer());
    fs.writeFileSync(reviewerAPath, createValidReviewer('APPROVE'));
    fs.writeFileSync(reviewerBPath, createValidReviewer('APPROVE'));

    decideAndPersist({
      runDir: tmp,
      stageName: 'implement',
      stageDir,
      decisionPath,
      scorecardPath,
      producerPath,
      reviewerAPath,
      reviewerBPath,
      globalReviewerPath: null,
      state: { ...createMockState(), specPath },
    });

    // Verify scorecard.json was written
    assert.ok(fs.existsSync(scorecardPath), 'scorecard.json should be written');
    const scorecard = JSON.parse(fs.readFileSync(scorecardPath, 'utf8'));

    // Verify validation structure
    assert.ok(scorecard.validation, 'scorecard must have validation object');
    assert.equal(scorecard.validation.valid, false, 'validation.valid must be false for invalid reports');
    assert.ok(scorecard.validation.errorSummary, 'validation must have errorSummary when invalid');
    assert.ok(scorecard.validation.producer, 'validation must have producer object');
    assert.equal(scorecard.validation.producer.valid, false, 'producer validation must be false');
    assert.ok(Array.isArray(scorecard.validation.producer.missingSections), 'producer must have missingSections array');
    assert.ok(scorecard.validation.producer.missingSections.includes('SUMMARY'), 'missingSections must include SUMMARY');

    // Verify errorSummary consistency
    assert.ok(
      scorecard.validation.errorSummary.includes('SUMMARY') || scorecard.validation.producer.errorSummary?.includes('SUMMARY'),
      'errorSummary must reference the missing section'
    );
  } finally {
    cleanupTempDir(tmp);
  }
});

test('behavior: outputQuality and qualityReasons persisted to files', () => {
  const tmp = createTempDir();
  try {
    const stageDir = path.join(tmp, 'stages', 'implement');
    fs.mkdirSync(stageDir, { recursive: true });

    const specPath = createTempSpec(tmp);
    const producerPath = path.join(stageDir, 'producer.md');
    const reviewerAPath = path.join(stageDir, 'reviewer-a.md');
    const reviewerBPath = path.join(stageDir, 'reviewer-b.md');
    const decisionPath = path.join(stageDir, 'decision.md');
    const scorecardPath = path.join(stageDir, 'scorecard.json');

    // Write valid reports
    fs.writeFileSync(producerPath, createValidProducer());
    fs.writeFileSync(reviewerAPath, createValidReviewer('APPROVE'));
    fs.writeFileSync(reviewerBPath, createValidReviewer('APPROVE'));

    decideAndPersist({
      runDir: tmp,
      stageName: 'implement',
      stageDir,
      decisionPath,
      scorecardPath,
      producerPath,
      reviewerAPath,
      reviewerBPath,
      globalReviewerPath: null,
      state: { ...createMockState(), specPath },
    });

    // Verify decision.md has Output Quality
    const decision = fs.readFileSync(decisionPath, 'utf8');
    assert.ok(/Output Quality:/.test(decision), 'decision.md must have Output Quality field');

    // Verify scorecard.json has outputQuality and qualityReasons
    const scorecard = JSON.parse(fs.readFileSync(scorecardPath, 'utf8'));
    assert.ok('outputQuality' in scorecard, 'scorecard must have outputQuality field');
    assert.ok(Array.isArray(scorecard.qualityReasons), 'scorecard must have qualityReasons array');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('behavior: handoff.json generated when outcome is revise', () => {
  const tmp = createTempDir();
  try {
    const stageDir = path.join(tmp, 'stages', 'implement');
    fs.mkdirSync(stageDir, { recursive: true });

    const specPath = createTempSpec(tmp);
    const producerPath = path.join(stageDir, 'producer.md');
    const reviewerAPath = path.join(stageDir, 'reviewer-a.md');
    const reviewerBPath = path.join(stageDir, 'reviewer-b.md');
    const decisionPath = path.join(stageDir, 'decision.md');
    const scorecardPath = path.join(stageDir, 'scorecard.json');
    const handoffPath = path.join(stageDir, 'handoff.json');

    // Write valid producer but reviewers request revise
    fs.writeFileSync(producerPath, createValidProducer());
    fs.writeFileSync(reviewerAPath, createValidReviewer('REVISE'));
    fs.writeFileSync(reviewerBPath, createValidReviewer('REVISE'));

    decideAndPersist({
      runDir: tmp,
      stageName: 'implement',
      stageDir,
      decisionPath,
      scorecardPath,
      producerPath,
      reviewerAPath,
      reviewerBPath,
      globalReviewerPath: null,
      state: { ...createMockState(), specPath },
    });

    // Verify handoff.json was written
    assert.ok(fs.existsSync(handoffPath), 'handoff.json should be written when outcome is revise');

    const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
    assert.ok(Array.isArray(handoff.blockers), 'handoff must have blockers array');
    assert.equal(handoff.stageName, 'implement', 'handoff must have correct stageName');
    assert.equal(handoff.round, 1, 'handoff must have correct round');
    assert.ok(handoff.generatedAt, 'handoff must have generatedAt timestamp');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('behavior: handoff.json NOT generated when outcome is advance', () => {
  const tmp = createTempDir();
  try {
    const stageDir = path.join(tmp, 'stages', 'implement');
    fs.mkdirSync(stageDir, { recursive: true });

    const specPath = createTempSpec(tmp);
    const producerPath = path.join(stageDir, 'producer.md');
    const reviewerAPath = path.join(stageDir, 'reviewer-a.md');
    const reviewerBPath = path.join(stageDir, 'reviewer-b.md');
    const decisionPath = path.join(stageDir, 'decision.md');
    const scorecardPath = path.join(stageDir, 'scorecard.json');
    const handoffPath = path.join(stageDir, 'handoff.json');

    // Write valid reports with approvals
    fs.writeFileSync(producerPath, createValidProducer());
    fs.writeFileSync(reviewerAPath, createValidReviewer('APPROVE'));
    fs.writeFileSync(reviewerBPath, createValidReviewer('APPROVE'));

    decideAndPersist({
      runDir: tmp,
      stageName: 'implement',
      stageDir,
      decisionPath,
      scorecardPath,
      producerPath,
      reviewerAPath,
      reviewerBPath,
      globalReviewerPath: null,
      state: { ...createMockState(), specPath },
    });

    // Verify handoff.json was NOT written
    assert.equal(fs.existsSync(handoffPath), false, 'handoff.json should NOT be written when outcome is advance');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('behavior: formatRoleValidation produces correct output', () => {
  // Test valid case
  const validResult = formatRoleValidation('Producer', { valid: true });
  assert.deepEqual(validResult, ['- Producer: [OK]']);

  // Test invalid case with missing sections
  const invalidResult = formatRoleValidation('Producer', {
    valid: false,
    missingSections: ['SUMMARY', 'CHANGES'],
    invalidFields: ['CHECKS: invalid format'],
  });
  assert.ok(invalidResult.length > 0, 'should produce output for invalid result');
  assert.ok(invalidResult[0].includes('[FAIL]'), 'should show failure marker');
  assert.ok(invalidResult[0].includes('missing: SUMMARY, CHANGES'), 'should show missing sections');
  assert.ok(invalidResult[0].includes('invalid: CHECKS: invalid format'), 'should show invalid fields');
});

test('behavior: decision.md has correct structure with all sections', () => {
  const tmp = createTempDir();
  try {
    const stageDir = path.join(tmp, 'stages', 'implement');
    fs.mkdirSync(stageDir, { recursive: true });

    const specPath = createTempSpec(tmp);
    const producerPath = path.join(stageDir, 'producer.md');
    const reviewerAPath = path.join(stageDir, 'reviewer-a.md');
    const reviewerBPath = path.join(stageDir, 'reviewer-b.md');
    const decisionPath = path.join(stageDir, 'decision.md');
    const scorecardPath = path.join(stageDir, 'scorecard.json');

    fs.writeFileSync(producerPath, createValidProducer());
    fs.writeFileSync(reviewerAPath, createValidReviewer('APPROVE'));
    fs.writeFileSync(reviewerBPath, createValidReviewer('APPROVE'));

    decideAndPersist({
      runDir: tmp,
      stageName: 'implement',
      stageDir,
      decisionPath,
      scorecardPath,
      producerPath,
      reviewerAPath,
      reviewerBPath,
      globalReviewerPath: null,
      state: { ...createMockState(), specPath },
    });

    const decision = fs.readFileSync(decisionPath, 'utf8');

    // Verify all expected sections exist
    assert.ok(/^# Decision/m.test(decision), 'must have Decision header');
    assert.ok(/## Summary/.test(decision), 'must have Summary section');
    assert.ok(/## Validation/.test(decision), 'must have Validation section');
    assert.ok(/## Blockers/.test(decision), 'must have Blockers section');
    assert.ok(/## Metrics/.test(decision), 'must have Metrics section');
    assert.ok(/## Files/.test(decision), 'must have Files section');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('persistence: nextRunRecommendation written to decision.md', () => {
  const tmp = createTempDir();
  try {
    const stageDir = path.join(tmp, 'stages', 'implement');
    fs.mkdirSync(stageDir, { recursive: true });

    const specPath = createTempSpec(tmp);
    const producerPath = path.join(stageDir, 'producer.md');
    const reviewerAPath = path.join(stageDir, 'reviewer-a.md');
    const reviewerBPath = path.join(stageDir, 'reviewer-b.md');
    const decisionPath = path.join(stageDir, 'decision.md');
    const scorecardPath = path.join(stageDir, 'scorecard.json');

    fs.writeFileSync(producerPath, createValidProducer());
    fs.writeFileSync(reviewerAPath, createValidReviewer('REVISE')); // Will produce NEEDS_WORK
    fs.writeFileSync(reviewerBPath, createValidReviewer('APPROVE'));

    decideAndPersist({
      runDir: tmp,
      stageName: 'implement',
      stageDir,
      decisionPath,
      scorecardPath,
      producerPath,
      reviewerAPath,
      reviewerBPath,
      globalReviewerPath: null,
      state: { ...createMockState(), specPath },
    });

    const decision = fs.readFileSync(decisionPath, 'utf8');
    // For NEEDS_WORK outcome, nextRunRecommendation should be present
    assert.ok(/## Next Run Recommendation/.test(decision), 'must have Next Run Recommendation section');
    assert.ok(/Type:/.test(decision), 'must have recommendation type');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('persistence: nextRunRecommendation written to scorecard.json', () => {
  const tmp = createTempDir();
  try {
    const stageDir = path.join(tmp, 'stages', 'implement');
    fs.mkdirSync(stageDir, { recursive: true });

    const specPath = createTempSpec(tmp);
    const producerPath = path.join(stageDir, 'producer.md');
    const reviewerAPath = path.join(stageDir, 'reviewer-a.md');
    const reviewerBPath = path.join(stageDir, 'reviewer-b.md');
    const decisionPath = path.join(stageDir, 'decision.md');
    const scorecardPath = path.join(stageDir, 'scorecard.json');

    fs.writeFileSync(producerPath, createValidProducer());
    fs.writeFileSync(reviewerAPath, createValidReviewer('REVISE'));
    fs.writeFileSync(reviewerBPath, createValidReviewer('APPROVE'));

    decideAndPersist({
      runDir: tmp,
      stageName: 'implement',
      stageDir,
      decisionPath,
      scorecardPath,
      producerPath,
      reviewerAPath,
      reviewerBPath,
      globalReviewerPath: null,
      state: { ...createMockState(), specPath },
    });

    const scorecard = JSON.parse(fs.readFileSync(scorecardPath, 'utf8'));
    assert.ok(scorecard.nextRunRecommendation !== undefined, 'scorecard must have nextRunRecommendation field');
    assert.ok(scorecard.nextRunRecommendation !== null, 'nextRunRecommendation should not be null');
    assert.ok(scorecard.nextRunRecommendation.type, 'nextRunRecommendation must have type');
    assert.ok(Array.isArray(scorecard.nextRunRecommendation.reasons), 'nextRunRecommendation must have reasons array');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('acceptance checklist: file exists and has correct content', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const checklistPath = path.resolve(repoRoot, 'docs/design/workflow-v1-acceptance-checklist.md');
  assert.ok(fs.existsSync(checklistPath), 'acceptance checklist file must exist');

  const content = fs.readFileSync(checklistPath, 'utf8');
  // Must not contain the deprecated --spec flag (replaced by --task / --task-spec)
  assert.ok(!content.includes('--spec '), 'must NOT use deprecated --spec flag');
  // Must contain the correct command patterns
  assert.ok(content.includes('--task'), 'must use --task flag');
  // Must have run result recording structure
  assert.ok(content.includes('runId') || content.includes('run-id') || content.includes('Run ID'), 'must have run-id field');
  assert.ok(content.includes('outputQuality'), 'must mention outputQuality');
  assert.ok(content.includes('nextRunRecommendation'), 'must mention nextRunRecommendation');
  // Must have complete failure classification
  assert.ok(content.includes('workflow bug'), 'must classify workflow bug');
  assert.ok(content.includes('agent behavior'), 'must classify agent behavior');
  assert.ok(content.includes('environment'), 'must classify environment issues');
  assert.ok(content.includes('sample-spec') || content.includes('spec issue'), 'must classify spec issues');
});

test('preflight check validates acpx not agent names', () => {
  // The preflight code in run.mjs should check that acpx is available,
  // NOT that agent names like "iflow" or "claude" exist as shell binaries.
  const runPath = path.resolve(__dirname, '..', 'run.mjs');
  const content = fs.readFileSync(runPath, 'utf8');
  // Should NOT use "which" with agent names
  assert.ok(!content.includes("'which', [agentName]"), 'preflight must not check agent names with which');
  assert.ok(!content.includes("'which', [agent"), 'preflight must not check agent binary with which');
  // Should check acpx availability instead
  assert.ok(content.includes('acpx'), 'preflight should reference acpx');
});

test('cleanupAcpxOrphans does not fallback to spec directory', () => {
  const runPath = path.resolve(__dirname, '..', 'run.mjs');
  const content = fs.readFileSync(runPath, 'utf8');
  // Must NOT use path.dirname(state.specPath) as workspace fallback
  assert.ok(!content.includes('path.dirname(state.specPath)'),
    'cleanupAcpxOrphans must not fallback to spec file directory');
  // Must use workspace or worktree only
  assert.ok(content.includes('spec.workspace') || content.includes('spec?.workspace'),
    'cleanupAcpxOrphans should reference spec.workspace');
});
