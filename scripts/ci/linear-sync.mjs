// GitHub -> Linear fact bridge. The GitHub Actions side of PRI-725.
//
// Responsibility split (this is the whole point of the file):
//
//   THIS SCRIPT OWNS   reading GitHub lifecycle facts, and posting Chinese
//                      reminder comments. Nothing else.
//   THIS SCRIPT NEVER  writes Linear issue state / priority / labels.
//
// Why it must never write state:
//
//   1. Linear's own GitHub Integration already covers the Level-1 fact
//      "PR merged -> Issue Done". Verified 2026-09-10: PRI-722 PR #1595
//      mergedAt=10:00:01Z, state Done at 10:00:03Z, actor = the connected
//      user, no human involved. Across the 84 merged PR links in team PRI the
//      only exceptions were PRI-703's two merges — and those are the Owner
//      deliberately moving Done -> In Progress again, because PRI-703 is a
//      multi-PR epic that was not actually finished.
//   2. A second writer would therefore be a second source of truth (AGENTS.md
//      P4) *and* would silently undo deliberate Owner governance on epic
//      issues.
//
// So the merged path only VERIFIES, and if an issue did not reach Done it
// leaves a reminder for the Owner to decide. Reminder, not decision.
//
// Usage (both modes read the GitHub event payload directly):
//
//   node scripts/ci/linear-sync.mjs pr          --event-file "$GITHUB_EVENT_PATH"
//   node scripts/ci/linear-sync.mjs ci-failure  --event-file "$GITHUB_EVENT_PATH"
//
//   --repo <owner/name>   default: $GITHUB_REPOSITORY
//   --dry-run             print intended actions, perform no writes
//
// Env: LINEAR_API_KEY (Linear), GITHUB_TOKEN (PR comments), GITHUB_API_URL
//
// Exit codes: 0 = handled (including "nothing to do" and degraded no-token
// runs — a reminder bot must never block a PR), 2 = usage/event error.

import fs from 'node:fs';

// ---------------------------------------------------------------- constants

/** Comment markers make every reminder idempotent: we never post twice. */
export const MARKERS = {
  missingLink: '<!-- pd-linear-sync:missing-link -->',
  mergeReminder: '<!-- pd-linear-sync:merge-reminder -->',
  ciFailure: (runId) => `<!-- pd-linear-sync:ci-failure:${runId} -->`,
};

/** Branch/title/body are scanned in that priority order (AGENTS.md §21). */
export const ISSUE_ID_PATTERN = /\bPRI-(\d+)\b/gi;

// ------------------------------------------------------------------ helpers

/**
 * Pull Linear identifiers out of a PR's branch / title / body. First field with
 * a hit wins: the branch is authoritative because `ai/PRI-722-*` is the repo
 * convention and survives later title edits.
 */
export function extractIssueIdentifiers({ branch, title, body } = {}) {
  for (const [source, value] of [
    ['branch', branch],
    ['title', title],
    ['body', body],
  ]) {
    if (!value) continue;
    const found = [...String(value).matchAll(ISSUE_ID_PATTERN)].map((m) => `PRI-${m[1]}`);
    if (found.length) return { identifiers: [...new Set(found)], source };
  }
  return { identifiers: [], source: null };
}

/** True when a previous run already posted this marker — the dedupe gate. */
export function hasMarker(comments, marker) {
  return (comments || []).some((c) => {
    const body = typeof c === 'string' ? c : c?.body;
    return typeof body === 'string' && body.includes(marker);
  });
}

export function renderMissingLinkComment() {
  return `${MARKERS.missingLink}
未检测到关联 Linear 工单。

请确认该 PR 是否属于某个开发任务。

（本提醒由 GitHub Actions 自动生成，不会修改任何状态。）`;
}

export function renderMergeReminder({ prNumber, mergedAt, pending }) {
  const lines = pending
    .map((i) => `- ${i.identifier}（当前状态：${i.stateName || '未知'}）`)
    .join('\n');
  return `${MARKERS.mergeReminder}
PR 已合并。

PR: #${prNumber}
Merge: ${mergedAt || '未知'}

以下关联工单**尚未**进入 \`Done\`，请确认是否需要人工处理：

${lines}

说明：Linear 原生 GitHub Integration 通常会在 PR 合并后自动把工单置为 \`Done\`。
本提醒由 GitHub Actions 生成，**不修改任何状态**，仅在你需要时提示。`;
}

export function renderCiFailureComment({ workflowName, runId, runUrl, prNumber }) {
  return `${MARKERS.ciFailure(runId)}
检测到 CI 失败。

Workflow: ${workflowName}
Run: ${runUrl}
PR: #${prNumber}

请检查失败原因。

（本提醒不修改状态 / 优先级 / 标签。）`;
}

/** Read the pull_request facts this bridge is allowed to depend on. */
export function readPullRequestFacts(event) {
  const pr = event?.pull_request;
  if (!pr) return null;
  const repoFullName = event?.repository?.full_name;
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    branch: pr.head?.ref,
    state: pr.state,
    merged: pr.merged === true,
    mergedAt: pr.merged_at,
    fromSameRepo: !pr.head?.repo?.full_name || !repoFullName
      ? true
      : pr.head.repo.full_name === repoFullName,
  };
}

/** Read the workflow_run facts (CI failure mode). */
export function readWorkflowRunFacts(event) {
  const run = event?.workflow_run;
  if (!run) return null;
  const prs = run.pull_requests || [];
  return {
    runId: String(run.id),
    runUrl: run.html_url,
    workflowName: run.name,
    conclusion: run.conclusion,
    triggeringEvent: run.event,
    headSha: run.head_sha,
    prNumber: prs[0]?.number ?? null,
    branch: prs[0]?.head_branch ?? run.head_branch,
  };
}

// ------------------------------------------------------------------ clients

function makeFetch(fetchImpl) {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch === 'function') return fetch;
  throw new Error('no fetch implementation available (Node >= 18 required)');
}

export function createGithubClient({ token, repo, apiUrl, fetchImpl }) {
  const f = makeFetch(fetchImpl);
  const base = `${apiUrl}/repos/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pd-linear-sync',
  };
  async function call(method, url, payload) {
    const res = await f(url, {
      method,
      headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${url} -> ${res.status}`);
    return res.status === 204 ? null : res.json();
  }
  return {
    listIssueComments: (pr) => call('GET', `${base}/issues/${pr}/comments?per_page=100`),
    createIssueComment: (pr, body) => call('POST', `${base}/issues/${pr}/comments`, { body }),
    async getPullRequestHeadSha(pr) {
      const data = await call('GET', `${base}/pulls/${pr}`);
      return data?.head?.sha ?? null;
    },
  };
}

/**
 * Read-only for state, plus the two comment operations a reminder needs.
 * Note `issue(id:)` accepts the human identifier (PRI-725); commentCreate needs
 * the UUID, so the identifier is resolved first.
 */
export function createLinearClient({ apiKey, fetchImpl }) {
  const f = makeFetch(fetchImpl);
  // Linear answers an unknown identifier with a GraphQL error, not a null
  // issue ("Entity not found: Issue"). That is a normal outcome — a PR may
  // reference a ticket that does not exist — and must not be reported as
  // "Linear is unavailable". Verified against the live API 2026-09-10.
  const isNotFound = (err) => /not found/i.test(err?.message || '');
  async function gql(query, variables) {
    const res = await f('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Linear GraphQL -> HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    return json.data;
  }
  return {
    async getIssue(identifier) {
      let data;
      try {
        data = await gql(
          `query($id: String!) { issue(id: $id) { id identifier url state { name type } } }`,
          { id: identifier }
        );
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      const issue = data?.issue;
      if (!issue) return null;
      return { identifier: issue.identifier, uuid: issue.id, url: issue.url, stateName: issue.state?.name, stateType: issue.state?.type };
    },
    async listComments(identifier) {
      let data;
      try {
        data = await gql(
          `query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body } } } }`,
          { id: identifier }
        );
      } catch (err) {
        if (isNotFound(err)) return [];
        throw err;
      }
      return (data?.issue?.comments?.nodes || []).map((n) => n.body);
    },
    async createComment(identifier, body) {
      const data = await gql(
        `query($id: String!) { issue(id: $id) { id } }`,
        { id: identifier }
      );
      const issueId = data?.issue?.id;
      if (!issueId) throw new Error(`Linear issue not found: ${identifier}`);
      const created = await gql(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId, body } }
      );
      if (!created?.commentCreate?.success) throw new Error(`commentCreate failed for ${identifier}`);
    },
  };
}

// --------------------------------------------------------------------- core

/**
 * pull_request handler. Advisory only — never writes Linear state, never throws
 * on network trouble (degraded logging instead).
 */
export async function handlePullRequest({ facts, github, linear, log = console.log, dryRun = false }) {
  const { identifiers, source } = extractIssueIdentifiers(facts);

  if (facts.merged) {
    if (!identifiers.length) {
      log('merge: no Linear identifier on branch/title/body — nothing to verify');
      return { action: 'none', reason: 'no-identifier' };
    }
    const pending = [];
    const healthy = [];
    for (const id of identifiers) {
      let issue;
      try {
        issue = await linear.getIssue(id);
      } catch (err) {
        log(`merge: Linear lookup failed for ${id}: ${err.message}`);
        return { action: 'none', reason: 'linear-unavailable' };
      }
      if (!issue) { log(`merge: ${id} not found in Linear`); continue; }
      (issue.stateType === 'completed' ? healthy : pending).push(issue);
    }
    if (healthy.length) {
      log(`merge: ${healthy.map((i) => i.identifier).join(', ')} already Done — native Linear integration handled it, no action`);
    }
    if (!pending.length) return { action: 'none', reason: 'native-sync-confirmed' };

    const results = [];
    for (const issue of pending) {
      const body = renderMergeReminder({ prNumber: facts.number, mergedAt: facts.mergedAt, pending: [issue] });
      if (dryRun) { log(`[dry-run] would comment on ${issue.identifier}:\n${body}`); results.push({ id: issue.identifier, action: 'dry-run' }); continue; }
      try {
        if (hasMarker(await linear.listComments(issue.identifier), MARKERS.mergeReminder)) {
          log(`merge: ${issue.identifier} already has a merge reminder — skipping`);
          results.push({ id: issue.identifier, action: 'skipped' });
          continue;
        }
        await linear.createComment(issue.identifier, body);
        log(`merge: reminded on ${issue.identifier} (state=${issue.stateName})`);
        results.push({ id: issue.identifier, action: 'reminded' });
      } catch (err) {
        log(`merge: failed to remind on ${issue.identifier}: ${err.message}`);
        results.push({ id: issue.identifier, action: 'failed' });
      }
    }
    return { action: 'merge-verified', results };
  }

  if (identifiers.length) {
    log(`pr: linked to ${identifiers.join(', ')} (source: ${source}) — recorded, no comment`);
    return { action: 'recorded', identifiers, source };
  }

  // A PR closed without merging needs no "which ticket owns this?" nudge.
  if (facts.state === 'closed') {
    log('pr: closed without merge and no Linear link — no reminder');
    return { action: 'none', reason: 'closed-unmerged' };
  }

  const comments = await github.listIssueComments(facts.number).catch(() => []);
  if (hasMarker(comments, MARKERS.missingLink)) {
    log('pr: missing-link reminder already posted — skipping');
    return { action: 'skipped', reason: 'duplicate' };
  }
  const body = renderMissingLinkComment();
  if (dryRun) { log(`[dry-run] would comment on #${facts.number}:\n${body}`); return { action: 'dry-run' }; }
  await github.createIssueComment(facts.number, body);
  log(`pr: no Linear link on #${facts.number} — reminder posted`);
  return { action: 'reminded' };
}

/** workflow_run handler: CI failed on a PR. Reminder only, no state mutation. */
export async function handleCiFailure({ facts, github, linear, log = console.log, dryRun = false }) {
  if (facts.triggeringEvent !== 'pull_request' || !facts.prNumber) {
    log(`ci-failure: run ${facts.runId} is not PR-associated (event=${facts.triggeringEvent}) — ignoring`);
    return { action: 'none', reason: 'not-a-pr-run' };
  }

  // A failure on a superseded commit is already stale information: the author
  // has moved on, and the run URL would point at code that no longer exists in
  // the PR. Only the current head produces a notice, which also bounds the
  // comment volume to roughly one per pushed commit.
  try {
    const headSha = await github.getPullRequestHeadSha(facts.prNumber);
    if (headSha && facts.headSha && headSha !== facts.headSha) {
      log(`ci-failure: run ${facts.runId} (${facts.headSha?.slice(0, 7)}) is superseded by ${headSha.slice(0, 7)} — no notice`);
      return { action: 'none', reason: 'superseded' };
    }
  } catch (err) {
    log(`ci-failure: could not resolve PR head (${err.message}) — proceeding with the notice`);
  }

  const { identifiers } = extractIssueIdentifiers({ branch: facts.branch });
  if (!identifiers.length) {
    log(`ci-failure: no Linear identifier on ${facts.branch} — nothing to notify`);
    return { action: 'none', reason: 'no-identifier' };
  }
  const marker = MARKERS.ciFailure(facts.runId);
  const results = [];
  for (const id of identifiers) {
    const body = renderCiFailureComment({ workflowName: facts.workflowName, runId: facts.runId, runUrl: facts.runUrl, prNumber: facts.prNumber });
    if (dryRun) { log(`[dry-run] would comment on ${id}:\n${body}`); results.push({ id, action: 'dry-run' }); continue; }
    try {
      const issue = await linear.getIssue(id);
      if (!issue) { log(`ci-failure: ${id} not found in Linear`); results.push({ id, action: 'missing' }); continue; }
      if (hasMarker(await linear.listComments(id), marker)) {
        log(`ci-failure: ${id} already notified for run ${facts.runId} — skipping`);
        results.push({ id, action: 'skipped' });
        continue;
      }
      await linear.createComment(id, body);
      log(`ci-failure: notified ${id} about ${facts.workflowName} run ${facts.runId}`);
      results.push({ id, action: 'notified' });
    } catch (err) {
      log(`ci-failure: failed to notify ${id}: ${err.message}`);
      results.push({ id, action: 'failed' });
    }
  }
  return { action: 'ci-notified', results };
}

// ---------------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a.startsWith('--')) { out[a.slice(2)] = argv[++i]; continue; }
    out._.push(a);
  }
  return out;
}

export async function runCli({ argv, env = {}, fetchImpl, log = console.log } = {}) {
  const args = parseArgs(argv);
  const mode = args._[0];
  if (!['pr', 'ci-failure'].includes(mode)) {
    log('usage: linear-sync.mjs <pr|ci-failure> --event-file <path> [--repo owner/name] [--dry-run]');
    return 2;
  }
  const eventFile = args['event-file'] || env.GITHUB_EVENT_PATH;
  if (!eventFile || !fs.existsSync(eventFile)) {
    log(`linear-sync: event file not found: ${eventFile}`);
    return 2;
  }
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  const dryRun = Boolean(args.dryRun);
  const prFacts = readPullRequestFacts(event);

  const needsLinear = mode === 'ci-failure' || prFacts?.merged === true;
  if (needsLinear && !env.LINEAR_API_KEY) {
    log('::warning::LINEAR_API_KEY is not configured — reminder skipped');
    return 0;
  }

  const github = createGithubClient({
    token: env.GITHUB_TOKEN,
    repo: args.repo || env.GITHUB_REPOSITORY,
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    fetchImpl,
  });
  const linear = env.LINEAR_API_KEY
    ? createLinearClient({ apiKey: env.LINEAR_API_KEY, fetchImpl })
    : { getIssue: async () => null, listComments: async () => [], createComment: async () => {} };

  try {
    if (mode === 'pr') {
      if (!prFacts) { log('linear-sync: event is not a pull_request payload'); return 2; }
      if (!prFacts.fromSameRepo) {
        log('linear-sync: PR originates from a fork — skipping (fork runs receive no secrets)');
        return 0;
      }
      await handlePullRequest({ facts: prFacts, github, linear, log, dryRun });
    } else {
      const facts = readWorkflowRunFacts(event);
      if (!facts) { log('linear-sync: event is not a workflow_run payload'); return 2; }
      await handleCiFailure({ facts, github, linear, log, dryRun });
    }
  } catch (err) {
    // A reminder bot must never block a PR on its own failure.
    log(`::warning::linear-sync degraded: ${err.message}`);
  }
  return 0;
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (entry.endsWith('scripts/ci/linear-sync.mjs')) {
  process.exitCode = await runCli({ argv: process.argv.slice(2), env: process.env });
}
