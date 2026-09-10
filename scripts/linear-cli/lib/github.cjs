'use strict';

/**
 * GitHub access for `handoff` / `reconcile` / `audit`.
 *
 * The CLI deliberately reads PR truth from GitHub (`gh`) and PR↔issue
 * linkage from Linear attachments. It never infers a PR state from comment
 * prose, and it never merges anything.
 *
 * `gh` and `git` are injected as plain command runners so tests can exercise
 * the whole boundary with fixtures and no network.
 */

const { execFile } = require('node:child_process');

const PR_FIELDS = 'number,title,state,mergedAt,isDraft,headRefName,baseRefName,url,body';

function runCommand(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, code: error.code ?? 1, stdout: String(stdout || ''), stderr: String(stderr || error.message || '') });
        return;
      }
      resolve({ ok: true, code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function defaultGh(args) {
  return runCommand('gh', args);
}

function defaultGit(args) {
  return runCommand('git', args);
}

/** Accepts a full PR url, a `owner/repo#123` short form, or a bare number. */
function parsePrReference(input, defaultRepo) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let m = raw.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` };
  m = raw.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` };
  if (/^\d+$/.test(raw) && defaultRepo) {
    const [owner, repo] = defaultRepo.split('/');
    return { owner, repo, number: Number(raw), url: `https://github.com/${owner}/${repo}/pull/${raw}` };
  }
  return null;
}

function parseRepoFromRemoteUrl(url) {
  const raw = String(url || '').trim();
  let m = raw.match(/github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  m = raw.match(/^git@github\.com:([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

function normalizePullRequest(pr) {
  if (!pr) return null;
  const state = String(pr.state || '').toUpperCase();
  return {
    number: Number(pr.number),
    title: pr.title ?? null,
    state,
    merged: state === 'MERGED' || Boolean(pr.mergedAt),
    closed: state === 'CLOSED' || state === 'MERGED',
    draft: Boolean(pr.isDraft),
    headRefName: pr.headRefName ?? null,
    baseRefName: pr.baseRefName ?? null,
    mergedAt: pr.mergedAt ?? null,
    url: pr.url ?? null,
    body: pr.body ?? null,
  };
}

/** Collect `PRI-<n>` keys mentioned in a PR title/body/branch. */
const PRI_KEY_RE = /(PRI-\d+)/gi;

function issueKeysFromPullRequest(pr) {
  const text = [pr.title, pr.body, pr.headRefName].filter(Boolean).join(' ');
  const found = String(text).match(PRI_KEY_RE) || [];
  return [...new Set(found.map((k) => k.toUpperCase()))];
}

function createGitHub(options = {}) {
  const { gh = defaultGh, git = defaultGit, repo = process.env.PD_GITHUB_REPO || null } = options;

  async function detectRepo() {
    if (repo) return { ok: true, repo };
    const res = await git(['remote', 'get-url', 'origin']);
    if (!res.ok) {
      return { ok: false, error: { reason: 'repo_undetected', nextAction: 'Pass --repo owner/name, or run inside a git checkout with an origin remote.' } };
    }
    const parsed = parseRepoFromRemoteUrl(res.stdout);
    if (!parsed) {
      return { ok: false, error: { reason: 'repo_undetected', nextAction: 'Could not parse owner/repo from origin remote. Pass --repo owner/name.' } };
    }
    return { ok: true, repo: parsed };
  }

  /**
   * One bounded `gh pr list` instead of one call per PR: reconcile/audit scan
   * many issues, and per-PR calls would be both slow and rate-limit prone.
   */
  async function listPullRequests({ repo: repoOverride, limit = 200 } = {}) {
    const target = repoOverride || repo;
    if (!target) {
      const detected = await detectRepo();
      if (!detected.ok) return detected;
      return listPullRequests({ repo: detected.repo, limit });
    }
    const res = await gh(['pr', 'list', '--repo', target, '--state', 'all', '--limit', String(limit), '--json', PR_FIELDS]);
    if (!res.ok) {
      return { ok: false, error: { reason: 'gh_command_failed', nextAction: 'Check that gh is installed and authenticated (gh auth status).', details: { stderr: res.stderr.slice(0, 500) } } };
    }
    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return { ok: false, error: { reason: 'gh_output_not_json', nextAction: 'Unexpected gh output; retry or check gh version.' } };
    }
    return { ok: true, pullRequests: (parsed || []).map(normalizePullRequest) };
  }

  /** Verify one PR really exists and belongs to the expected repository. */
  async function getPullRequest({ number, repo: repoOverride } = {}) {
    const target = repoOverride || repo;
    if (!target) {
      const detected = await detectRepo();
      if (!detected.ok) return detected;
      return getPullRequest({ number, repo: detected.repo });
    }
    const res = await gh(['pr', 'view', String(number), '--repo', target, '--json', PR_FIELDS]);
    if (!res.ok) {
      const text = `${res.stderr}`.toLowerCase();
      const reason = /could not resolve|not found|no pull requests/i.test(text) ? 'pr_not_found' : 'gh_command_failed';
      return {
        ok: false,
        error: {
          reason,
          nextAction: reason === 'pr_not_found'
            ? 'Verify the PR number/url and that it belongs to the expected repository.'
            : 'Check that gh is installed and authenticated (gh auth status).',
          details: { number, repo: target, stderr: res.stderr.slice(0, 500) },
        },
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return { ok: false, error: { reason: 'gh_output_not_json', nextAction: 'Unexpected gh output; retry or check gh version.' } };
    }
    const pr = normalizePullRequest(parsed);
    if (String(pr.url || '').includes(`/${target}/`) === false) {
      return { ok: false, error: { reason: 'pr_repo_mismatch', nextAction: `PR does not belong to ${target}.`, details: { number, repo: target, url: pr.url } } };
    }
    return { ok: true, pullRequest: pr, repo: target };
  }

  return { detectRepo, listPullRequests, getPullRequest };
}

module.exports = {
  createGitHub,
  parsePrReference,
  parseRepoFromRemoteUrl,
  normalizePullRequest,
  issueKeysFromPullRequest,
  PR_FIELDS,
  PRI_KEY_RE,
};
