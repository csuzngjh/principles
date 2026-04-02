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
import { fileURLToPath } from 'url';

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
