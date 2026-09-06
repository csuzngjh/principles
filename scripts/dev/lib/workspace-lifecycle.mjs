// Workspace lifecycle state: derivation + collection (PRI-691).
//
// Stateless by design (see docs/architecture/workspace-lifecycle-guard-analysis.md):
// every status below is derived per run from git + GitHub (and the existing
// git-9 lease files). Nothing is persisted — "Git itself stays the ownership
// registry" is the recorded stance of this tool tree.
//
// Classification (per worktree / task-branch record):
//   PRIMARY / BARE / MAIN_CHECKOUT — never cleanup candidates
//   ACTIVE        — branch exists and its PR is OPEN
//   CLEANUP_PENDING — completion proven but a blocker remains (grace period,
//                    dirty worktree, active write lease, unknown age)
//   CLEANUP_READY — completion proven + grace exceeded + clean + unleased
//   ORPHAN        — no completion evidence, or broken metadata (report only)
//
// Completion evidence = GitHub PR MERGED, or ancestry to origin/main. Both
// are Owner-controlled authorities and each independently establishes
// "merged content is in origin/main" (PR MERGED covers squash merges where
// the branch tip can never be an ancestor).

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listWorktrees, runGit, sameGitPath } from './git.mjs';
import { leasePhase, readLease } from './workspace-lease.mjs';

const execFileAsync = promisify(execFile);

export const GRACE_DAYS_DEFAULT = 7;
export const TASK_BRANCH_PREFIX = 'ai/';
export const GITHUB_PR_LIMIT = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
// `git status --porcelain` XY codes that mean an unresolved merge conflict.
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

// ---------------------------------------------------------------------------
// Pure classification (no I/O — unit-testable against synthetic records)
// ---------------------------------------------------------------------------

/**
 * @param {object} record — one workspace record as assembled by
 *   collectWorkspaceState(): { kind: 'worktree'|'branch-only', path, branch,
 *   isPrimary, bare, detached, porcelain, branchExists, pr, ancestry,
 *   remoteExists, tipDate, leasePhase, leaseOwner, leaseError }
 * @returns {{status: string, evidence: string[], reasons: string[], ageDays: number|null, ageSource: string|null}}
 */
export function classifyRecord(record, { graceDays = GRACE_DAYS_DEFAULT, now = Date.now() } = {}) {
  const evidence = [];
  const reasons = [];
  const branch = record.branch || null;

  if (record.kind === 'worktree') {
    if (record.bare) return { status: 'BARE', evidence, reasons, ageDays: null, ageSource: null };
    if (record.isPrimary) return { status: 'PRIMARY', evidence, reasons, ageDays: null, ageSource: null };
    if (branch === 'main') return { status: 'MAIN_CHECKOUT', evidence, reasons, ageDays: null, ageSource: null };
    if (record.detached) reasons.push('detached-head');
    if (!record.branchExists && branch) reasons.push('branch-ref-missing');
    if (record.porcelain === null && !record.detached) reasons.push('status-unreadable');
  }

  // Completion evidence.
  let mergedProof = null;
  if (record.pr && record.pr.state === 'MERGED') {
    mergedProof = 'pr-merged';
    evidence.push('PR #' + record.pr.number + ' MERGED' + (record.pr.url ? ' (' + record.pr.url + ')' : ''));
  } else if (record.ancestry) {
    mergedProof = 'ancestry';
    evidence.push('branch tip is an ancestor of origin/main');
  }

  // A PR still open means a task is (or may be) in review — ACTIVE wins over
  // any ancestry proof; nobody may sweep a review in flight.
  if (record.pr && record.pr.state === 'OPEN') {
    evidence.push('PR #' + record.pr.number + ' OPEN');
    return { status: 'ACTIVE', evidence, reasons, ageDays: null, ageSource: null };
  }

  if (!mergedProof) {
    if (record.pr && record.pr.state === 'CLOSED') reasons.push('pr-closed-unmerged');
    else reasons.push('no-pr-found');
    return { status: 'ORPHAN', evidence, reasons, ageDays: null, ageSource: null };
  }

  // Age: PR mergedAt is authoritative; branch tip date is the git-only proxy.
  let ageDays = null;
  let ageSource = null;
  if (mergedProof === 'pr-merged' && record.pr.mergedAt && !Number.isNaN(Date.parse(record.pr.mergedAt))) {
    ageDays = (now - Date.parse(record.pr.mergedAt)) / DAY_MS;
    ageSource = 'pr-mergedAt';
  } else if (record.tipDate && !Number.isNaN(Date.parse(record.tipDate))) {
    ageDays = (now - Date.parse(record.tipDate)) / DAY_MS;
    ageSource = 'branch-tip-commit-date';
  }
  if (ageDays === null) {
    reasons.push('merge-age-unknown');
  } else {
    evidence.push('age ' + Math.floor(ageDays) + 'd (source: ' + ageSource + ')');
  }

  // Blockers keep the record in CLEANUP_PENDING; CLEANUP_READY requires all
  // green. The planner re-checks defensively at apply time regardless.
  if (ageDays === null || ageDays <= graceDays) {
    if (ageDays !== null) reasons.push('grace-period-active (' + graceDays + 'd)');
    if (record.kind === 'worktree' && record.porcelain && record.porcelain.trim().length > 0) {
      reasons.push('dirty-worktree');
    }
    return { status: 'CLEANUP_PENDING', evidence, reasons, ageDays, ageSource };
  }
  if (record.kind === 'worktree') {
    if (record.porcelain && record.porcelain.trim().length > 0) {
      reasons.push('dirty-worktree — review and commit or remove the files; not auto-deletable');
      return { status: 'CLEANUP_PENDING', evidence, reasons, ageDays, ageSource };
    }
    if (record.porcelain === null) {
      return { status: 'ORPHAN', evidence, reasons, ageDays, ageSource };
    }
    if (record.leasePhase === 'active') {
      reasons.push('active write lease held' + (record.leaseOwner ? ' by ' + record.leaseOwner : ''));
      return { status: 'CLEANUP_PENDING', evidence, reasons, ageDays, ageSource };
    }
    if (record.leasePhase === 'invalid') {
      reasons.push('lease file unreadable — inspect manually');
      return { status: 'CLEANUP_PENDING', evidence, reasons, ageDays, ageSource };
    }
  }
  if (reasons.length > 0) {
    return { status: 'CLEANUP_PENDING', evidence, reasons, ageDays, ageSource };
  }
  return { status: 'CLEANUP_READY', evidence, reasons, ageDays, ageSource };
}

/** Classify a full record list. */
export function classifyRecords(records, opts = {}) {
  return records.map((record) => ({ record, ...classifyRecord(record, opts) }));
}

/**
 * Build the cleanup action plan from classified records. Dry-run safe: this
 * only COMPUTES actions; executors must still re-verify freshness per action.
 * Branch deletion is restricted to task branches (ai/ prefix, git-1
 * convention) — other refs are out of scope for the sweep by construction.
 */
export function planCleanup(classified, { taskBranchPrefix = TASK_BRANCH_PREFIX } = {}) {
  const actions = [];
  const skipped = [];
  for (const entry of classified) {
    const r = entry.record;
    const target = r.kind === 'worktree' ? r.path || r.branch : r.branch;
    if (entry.status === 'CLEANUP_READY') {
      if (r.kind === 'worktree') {
        actions.push({ kind: 'remove-worktree', path: r.path, branch: r.branch, evidence: entry.evidence });
        if (r.branch && r.branch.startsWith(taskBranchPrefix)) {
          actions.push({ kind: 'delete-branch', branch: r.branch, evidence: entry.evidence });
        }
      } else if (r.branch && r.branch.startsWith(taskBranchPrefix)) {
        actions.push({ kind: 'delete-branch', branch: r.branch, evidence: entry.evidence });
      } else {
        skipped.push({ target, status: entry.status, reasons: ['branch outside task namespace — sweep skips it'] });
      }
    } else if (entry.status === 'CLEANUP_PENDING' || entry.status === 'ORPHAN') {
      skipped.push({ target, status: entry.status, reasons: entry.reasons.length ? entry.reasons : ['not eligible'] });
    }
    // PRIMARY / BARE / MAIN_CHECKOUT / ACTIVE: silently out of scope.
  }
  return { actions, skipped };
}

// ---------------------------------------------------------------------------
// Collectors (I/O — git, gh, fs)
// ---------------------------------------------------------------------------

/**
 * Read the git-9 lease state of a worktree root, collapsed to one word.
 * Any thrown error (fs problems) counts as 'invalid' — cleanup must not
 * sweep a checkout whose lease cannot be read.
 */
export function readLeaseState(root, now = Date.now()) {
  let result;
  try {
    result = readLease(root);
  } catch {
    return { phase: 'invalid', owner: null };
  }
  if (!result.exists) return { phase: 'none', owner: null };
  if (!result.valid) return { phase: 'invalid', owner: null };
  return { phase: leasePhase(result.lease, now), owner: result.lease.owner };
}

/**
 * Index PRs by head branch via `gh pr list`. Never throws: on any failure
 * returns { available: false } and callers degrade to git-only evidence.
 */
export async function collectPrIndex(cwd) {
  const open = new Map();
  const merged = new Map();
  const run = async (state, fields) => {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--state', state, '--limit', String(GITHUB_PR_LIMIT), '--json', fields],
      { cwd, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }
    );
    return JSON.parse(stdout);
  };
  try {
    for (const pr of await run('open', 'number,headRefName,state,url')) {
      open.set(pr.headRefName, pr);
    }
    for (const pr of await run('merged', 'number,headRefName,state,url,mergedAt')) {
      merged.set(pr.headRefName, pr);
    }
  } catch {
    return { available: false, open, merged };
  }
  return { available: true, open, merged };
}

/**
 * Scan the sibling directories of the primary checkout for deregistered
 * worktree shells: a `.git` FILE whose gitdir admin target no longer exists
 * (the ERR-098 / metadata-incident residue class). Report-only — v1 never
 * deletes these.
 */
export function scanResidue(primaryPath) {
  const parent = path.dirname(primaryPath);
  const base = path.basename(primaryPath);
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(base + '-')) continue;
    const dir = path.join(parent, entry.name);
    const gitFile = path.join(dir, '.git');
    let raw;
    try {
      // Read directly with no stat pre-check (CodeQL file-system-race): a
      // worktree shell has a .git FILE (readable), while a plain repo
      // checkout has a .git DIRECTORY (readFileSync throws EISDIR) and a
      // plain dir has none (ENOENT) — both land in the catch below.
      raw = fs.readFileSync(gitFile, 'utf-8');
    } catch {
      continue; // no readable .git file → not a worktree shell — out of scope
    }
    const match = /^\s*gitdir:\s*(.+)\s*$/m.exec(raw);
    if (!match) continue;
    const target = match[1].trim();
    if (!fs.existsSync(target)) {
      found.push({ path: dir, gitdirTarget: target, reason: 'worktree admin entry missing' });
    }
  }
  return found;
}

function shortBranch(ref) {
  return ref ? ref.replace(/^refs\/heads\//, '') : null;
}

async function branchFacts(cwd, branch) {
  const branchExists =
    (await runGit(['rev-parse', '--verify', 'refs/heads/' + branch], { cwd, allowFailure: true })) !== null;
  if (!branchExists) {
    return { branchExists, ancestry: false, tipDate: null, remoteExists: null };
  }
  const ancestry =
    (await runGit(['merge-base', '--is-ancestor', branch, 'origin/main'], { cwd, allowFailure: true })) !== null;
  const tipDate = (await runGit(['log', '-1', '--format=%cI', branch], { cwd, allowFailure: true }))?.trim() || null;
  const remoteExists =
    (await runGit(['rev-parse', '--verify', 'refs/remotes/origin/' + branch], { cwd, allowFailure: true })) !== null;
  return { branchExists, ancestry, tipDate, remoteExists };
}

function leaseFacts(wtPath, now) {
  const { phase, owner } = readLeaseState(wtPath, now);
  return { leasePhase: phase, leaseOwner: owner };
}

/**
 * Assemble every workspace record the classifiers need. All evidence is
 * gathered fresh per call; nothing is cached between runs.
 *
 * @param {{cwd?: string, now?: number, skipGh?: boolean, includeBranchSweep?: boolean, includeResidue?: boolean}} opts
 */
export async function collectWorkspaceState(opts = {}) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const now = opts.now || Date.now();
  const notes = [];
  const refreshed = await runGit(['fetch', 'origin', '--prune'], { cwd, allowFailure: true });
  if (refreshed === null) {
    notes.push('origin refresh failed — evidence uses the cached origin/main');
  }

  const gh = opts.skipGh ? { available: false, open: new Map(), merged: new Map() } : await collectPrIndex(cwd);
  if (!gh.available) notes.push('GitHub PR evidence unavailable — classification uses git ancestry only');

  const worktrees = await listWorktrees(cwd);
  const primary = worktrees.find((w) => !w.bare);
  if (!primary) throw new Error('No non-bare worktree found — cannot identify the primary checkout.');

  const records = [];
  const seenBranches = new Set();
  for (const wt of worktrees) {
    if (wt.bare) {
      records.push({ kind: 'worktree', path: wt.path, branch: null, isPrimary: false, bare: true, detached: false, porcelain: null, branchExists: false, pr: null, ancestry: false, remoteExists: null, tipDate: null, leasePhase: 'none', leaseOwner: null });
      continue;
    }
    const branch = shortBranch(wt.branch);
    if (branch) seenBranches.add(branch);
    const isPrimary = sameGitPath(wt.path, primary.path, cwd);
    const porcelain = await runGit(['status', '--porcelain'], { cwd: wt.path, allowFailure: true });
    const facts = branch ? await branchFacts(cwd, branch) : { branchExists: false, ancestry: false, tipDate: null, remoteExists: null };
    records.push({
      kind: 'worktree',
      path: wt.path,
      branch,
      isPrimary,
      bare: false,
      detached: Boolean(wt.detached) || !branch,
      porcelain: porcelain === null ? null : porcelain,
      branchExists: facts.branchExists,
      pr: branch ? gh.open.get(branch) || gh.merged.get(branch) || null : null,
      ancestry: facts.ancestry,
      remoteExists: facts.remoteExists,
      tipDate: facts.tipDate,
      ...leaseFacts(wt.path, now),
    });
  }

  if (opts.includeBranchSweep !== false) {
    // Task-namespace branches without a worktree (the "39 merged branches"
    // residue class). Restricted to ai/* by construction; anything checked
    // out in a worktree is handled by that worktree's record instead.
    const listing = await runGit(
      ['for-each-ref', 'refs/heads/' + TASK_BRANCH_PREFIX + '*', '--format=%(refname:short)%09%(committerdate:iso8601-strict)'],
      { cwd, allowFailure: true }
    );
    if (listing !== null) {
      for (const line of listing.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const tab = line.indexOf('\t');
        const branch = (tab === -1 ? line : line.slice(0, tab)).trim();
        if (!branch || seenBranches.has(branch)) continue;
        const facts = await branchFacts(cwd, branch);
        records.push({
          kind: 'branch-only',
          path: null,
          branch,
          isPrimary: false,
          bare: false,
          detached: false,
          porcelain: null,
          pr: gh.open.get(branch) || gh.merged.get(branch) || null,
          ...facts,
          leasePhase: 'none',
          leaseOwner: null,
        });
      }
    }
  }

  const residue = opts.includeResidue === false ? [] : scanResidue(primary.path);

  return {
    cwd,
    now,
    primaryPath: primary.path,
    primaryRecord: records.find((r) => r.kind === 'worktree' && r.isPrimary) || null,
    records,
    residue,
    ghAvailable: gh.available,
    notes,
  };
}

/** Conflict codes (XY) present in a porcelain blob, if any. */
export function conflictCodes(porcelain) {
  if (!porcelain) return [];
  const codes = new Set();
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.length < 2) continue;
    const xy = line.slice(0, 2);
    if (CONFLICT_CODES.has(xy)) codes.add(xy);
  }
  return [...codes];
}
