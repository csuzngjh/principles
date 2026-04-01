/**
 * run.mjs git/worktree/merge-gate tests.
 *
 * Tests P1-1 (merge gate feature-branch comparison), P1-2 (worktree legal git params),
 * and P2 (cleanupWorktree correct cwd) via source analysis of command construction.
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
const SOURCE = fs.readFileSync(runMjsPath, 'utf8');

function getFuncBody(funcName) {
  const start = SOURCE.indexOf(`function ${funcName}`);
  if (start === -1) throw new Error(`Function ${funcName} not found`);
  const end = SOURCE.indexOf('\nfunction ', start + 1);
  return SOURCE.slice(start, end === -1 ? SOURCE.length : end);
}

test('P1-1: merge gate does NOT compare against origin/HEAD', () => {
  const body = getFuncBody('runMergeGateCheck');

  // The old broken code used: git rev-parse ${remote}/HEAD
  // which resolves to the remote's default branch, not our feature branch
  const hasOriginHead = /rev-parse.*`\$\{remote\}\/HEAD`|rev-parse.*origin\/HEAD/.test(body);
  assert.equal(hasOriginHead, false,
    'merge gate must NOT compare against origin/HEAD — use feature branch ref instead');
});

test('P1-1: merge gate uses branchName to construct remote ref', () => {
  const body = getFuncBody('runMergeGateCheck');

  // Must use branchName (from state.worktree) to build the remote ref
  assert.ok(/branchName/.test(body), 'must use branchName to identify remote branch');

  // Must construct refs/remotes/origin/<branchName> or equivalent
  const constructsRemoteRef = /refs\/remotes|remoteRef|remote\/.*branchName/.test(body);
  assert.ok(constructsRemoteRef, 'must construct a remote branch ref using branchName');
});

test('P1-1: merge gate halt reason uses branchName, not generic "remote HEAD"', () => {
  // Find the advanceState halt reason construction
  const haltReasonIdx = SOURCE.indexOf("type: fetchFailed ? 'merge_gate_branch_not_on_remote'");
  assert.ok(haltReasonIdx !== -1, 'halt reason must distinguish fetchFailed from sha mismatch');

  const section = SOURCE.slice(haltReasonIdx, haltReasonIdx + 600);

  // Must NOT say "remote HEAD" in the details — that's the P1-1 bug
  const mentionsRemoteHead = /remote\s+HEAD/.test(section);
  assert.equal(mentionsRemoteHead, false,
    'halt details must use the specific branch name, not "remote HEAD"');
});

test('P1-1: merge gate result object includes branchName field', () => {
  const body = getFuncBody('runMergeGateCheck');
  // Find: const result = { ... }
  const resultMatch = body.match(/const result\s*=\s*\{[^}]+\}/);
  assert.ok(resultMatch, 'should find result object in runMergeGateCheck');
  assert.ok(/branchName/.test(resultMatch[0]), 'result must include branchName');
});

test('P1-1: merge gate uses distinct halt types for fetch-failed vs sha-mismatch', () => {
  const haltMatch = SOURCE.match(/type:\s*fetchFailed\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/);
  assert.ok(haltMatch, 'should find distinct halt type expression');
  const [, fetchFailedType, mismatchType] = haltMatch;
  assert.notEqual(fetchFailedType, mismatchType, 'types must be distinct');
  assert.equal(fetchFailedType, 'merge_gate_branch_not_on_remote');
  assert.equal(mismatchType, 'merge_gate_sha_mismatch');
});

test('P1-2: ensureWorktree worktree add uses baseRef (git ref), not baseWorkspace (path)', () => {
  const body = getFuncBody('ensureWorktree');

  // baseRef must be defined as the base git ref (not a path)
  assert.ok(/const baseRef\s*=\s*baseBranch/.test(body),
    'must define baseRef = baseBranch (a git ref string, not a path)');

  // The worktree add command args: ['worktree', 'add', '-b', branchName, worktreePath, baseRef]
  // The last argument before the closing ] must be baseRef, NOT baseWorkspace
  // Find the args array content (between '[' and matching ']')
  const argsMatch = body.match(/worktree',\s*'add'[^;]*?\](?:\s*,|\s*\{)/);
  if (argsMatch) {
    const argsStr = argsMatch[0];
    // baseWorkspace must NOT appear in the args array (before the options object)
    assert.equal(/baseWorkspace/.test(argsStr), false,
      'git worktree add args must not include baseWorkspace (path); use baseRef (git ref)');
  }
  // Also verify that baseRef appears as the final arg in the worktree add call
  assert.ok(/worktree.*add.*-b.*baseRef/.test(body) ||
             /baseRef.*\]/.test(body.slice(body.indexOf('worktree add'))),
    'git worktree add should use baseRef as the starting-point (commit-ish) argument');
});

test('P1-2: ensureWorktree has NO illegal fallback "git worktree add <path> <branchName>"', () => {
  const body = getFuncBody('ensureWorktree');

  // The broken fallback was: git worktree add <worktreePath> <branchName>
  // This is wrong because branchName is the NEW branch (created by -b), not an existing local branch
  // The correct behavior: if first attempt fails, the whole worktree creation fails — no fallback needed
  const hasIllegalFallback = /git.*worktree.*add.*\$worktreePath.*\$branchName/.test(body) ||
                              /git.*worktree.*add.*worktreePath.*branchName[^A-Z]/.test(body);
  assert.equal(hasIllegalFallback, false,
    'must not have fallback "git worktree add <path> <branchName>" — branchName does not exist locally yet');
});

test('P1-2: ensureWorktree worktreeInfo includes baseWorkspace for cleanup', () => {
  const body = getFuncBody('ensureWorktree');

  const infoMatch = body.match(/const worktreeInfo\s*=\s*\{[\s\S]*?\};/);
  assert.ok(infoMatch, 'should find worktreeInfo object');
  const infoStr = infoMatch[0];

  assert.ok(/baseWorkspace/.test(infoStr),
    'worktreeInfo must include baseWorkspace field (needed for cleanupWorktree git cwd)');
});

test('P2: cleanupWorktree does NOT use path.dirname(worktreePath) as cwd', () => {
  const body = getFuncBody('cleanupWorktree');

  // The P2 bug: using the worktree's parent dir as git cwd
  // Correct: use baseWorkspace (the repo root) as cwd
  const usesDirnameWorktreePath = /cwd:\s*path\.dirname\(worktreePath\)/.test(body);
  assert.equal(usesDirnameWorktreePath, false,
    'cleanupWorktree must NOT use path.dirname(worktreePath) as git cwd — may not be the repo root');
});

test('P2: cleanupWorktree uses baseWorkspace as git cwd', () => {
  const body = getFuncBody('cleanupWorktree');

  // Must destructure baseWorkspace and use it as cwd
  const destructuresBaseWorkspace = /\{[^}]*worktreePath[^}]*baseWorkspace[^}]*\}/.test(body) ||
                                    /baseWorkspace.*worktree/.test(body);
  assert.ok(destructuresBaseWorkspace || /baseWorkspace/.test(body),
    'cleanupWorktree must use baseWorkspace from state.worktree as git cwd');

  // And use it in the git worktree remove call's cwd
  const gitCwdUsesBaseWorkspace = /cwd:\s*gitCwd/.test(body) ||
                                   /cwd:\s*baseWorkspace/.test(body) ||
                                   /gitCwd.*baseWorkspace/.test(body);
  assert.ok(gitCwdUsesBaseWorkspace,
    'git worktree remove must use baseWorkspace as cwd, not worktree parent dir');
});

test('captureGitStatus: remoteBranch is derived from branchName, not hardcoded null', () => {
  const body = getFuncBody('captureGitStatus');

  const infoMatch = body.match(/const gitStatus\s*=\s*\{[\s\S]*?\};/);
  assert.ok(infoMatch, 'should find gitStatus object');
  const infoStr = infoMatch[0];

  // remoteBranch: null was the old broken value
  const hasHardcodedNull = /remoteBranch:\s*null(?!,)/.test(infoStr);
  assert.equal(hasHardcodedNull, false,
    'remoteBranch should be set to origin/<branchName>, not hardcoded null');
});

test('merge gate fetches specific branch refspec, not all origin', () => {
  const body = getFuncBody('runMergeGateCheck');

  // Should fetch the specific branch using a refspec: git fetch origin refs/heads/branch:refs/remotes/origin/branch
  // or equivalently target the specific remote branch
  const fetchesAllOrigin = /git.*fetch.*,\s*remote\s*\+\s*['"]origin['"]/.test(body) &&
                            !/refs\/heads/.test(body) &&
                            !/branchName/.test(body);
  // Actually we check that the fetch uses branchName somehow
  const usesBranchInFetch = /fetch.*branchName|refspec|refs\/heads/.test(body);
  assert.ok(usesBranchInFetch, 'git fetch should target the specific branch (branchName), not all of origin');
});
