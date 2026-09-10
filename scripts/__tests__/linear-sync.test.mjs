// Contract tests for scripts/ci/linear-sync.mjs — the GitHub -> Linear fact
// bridge (PRI-725).
//
// These drive the REAL CLI entry point (`runCli`) with real event payload
// fixtures, faking only the network boundary. What is actually being protected:
//
//   1. The authority boundary: this script may read GitHub/Linear and post
//      comments, and NOTHING else. No issue state / priority / label writes,
//      ever, in any code path. `assertReadOnlyLinear` encodes that invariant
//      and runs against every scenario's recorded traffic.
//   2. Reminder idempotency: re-running a workflow must not post a second
//      comment (verified per scenario by replaying the recorded comments).
//   3. Non-blocking: a missing link, a missing token, or a Linear outage must
//      never turn into a failed PR check.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MARKERS,
  extractIssueIdentifiers,
  hasMarker,
  readPullRequestFacts,
  readWorkflowRunFacts,
  renderCiFailureComment,
  renderMergeReminder,
  renderMissingLinkComment,
  runCli,
} from '../ci/linear-sync.mjs';

const REPO = 'csuzngjh/principles';
let TMP;

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-linear-sync-'));
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let eventSeq = 0;
function writeEvent(payload) {
  const file = path.join(TMP, `event-${++eventSeq}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

/** Build a realistic pull_request event payload. */
function prEvent({ number = 725, branch = 'ai/PRI-725-linear-sync', title = 'feat(ci): x', body = '', state = 'open', merged = false, mergedAt = null, sameRepo = true } = {}) {
  return {
    repository: { full_name: REPO },
    pull_request: {
      number,
      title,
      body,
      state,
      merged,
      merged_at: mergedAt,
      head: { ref: branch, repo: { full_name: sameRepo ? REPO : 'someone/principles' } },
    },
  };
}

function runEvent({ number = 725, runId = '99001', name = 'CI', event = 'pull_request', conclusion = 'failure', headSha = 'aaaaaaa1', headBranch = 'ai/PRI-725-linear-sync' } = {}) {
  return {
    repository: { full_name: REPO },
    workflow_run: {
      id: Number(runId),
      html_url: `https://github.com/${REPO}/actions/runs/${runId}`,
      name,
      event,
      conclusion,
      head_sha: headSha,
      head_branch: headBranch,
      pull_requests: event === 'pull_request' ? [{ number, head_branch: headBranch }] : [],
    },
  };
}

/**
 * Fake network boundary. Records every request so the tests can assert on the
 * exact traffic the script produced.
 */
function harness({ issueById = {}, issueComments = {}, prComments = [], prHeadSha = null, linearFails = false, notFoundIds = [] } = {}) {
  const calls = { linear: [], github: [] };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const payload = init.body ? JSON.parse(init.body) : null;
    const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

    if (String(url).includes('api.linear.app')) {
      calls.linear.push({ method, query: payload.query, variables: payload.variables });
      if (linearFails) return json({ errors: [{ message: 'boom' }] });
      const query = payload.query;
      if (query.includes('mutation') && query.includes('commentCreate')) {
        return json({ data: { commentCreate: { success: true } } });
      }
      const id = payload.variables.id;
      // Linear answers an unknown identifier with a GraphQL error, not null.
      if (notFoundIds.includes(id)) return json({ errors: [{ message: 'Entity not found: Issue' }] });
      if (query.includes('comments(first: 50)')) {
        return json({ data: { issue: { comments: { nodes: (issueComments[id] || []).map((b) => ({ body: b })) } } } });
      }
      const issue = issueById[id];
      if (!issue) return json({ data: { issue: null } });
      return json({
        data: {
          issue: {
            id: `uuid-${id}`,
            identifier: id,
            url: `https://linear.app/principlesdisciple/issue/${id}`,
            state: { name: issue.stateName, type: issue.stateType },
          },
        },
      });
    }

    calls.github.push({ method, url: String(url) });
    if (String(url).includes('/pulls/')) return json({ head: { sha: prHeadSha } });
    if (method === 'POST') return json({ id: calls.github.length });
    return json(prComments);
  };
  return { fetchImpl, calls };
}

const ENV = { LINEAR_API_KEY: 'lin_api_test', GITHUB_TOKEN: 'ghs_test', GITHUB_REPOSITORY: REPO };

function captureLog() {
  const lines = [];
  return { lines, log: (m) => lines.push(String(m)) };
}

/** The authority boundary, asserted on every recorded Linear request. */
function assertReadOnlyLinear(calls) {
  for (const c of calls.linear) {
    const q = c.query || '';
    const isCommentCreate = q.includes('commentCreate');
    const isReadOnly = /^\s*query\b/.test(q);
    expect(isCommentCreate || isReadOnly, `unexpected Linear request: ${q.slice(0, 80)}`).toBe(true);
    expect(q, 'issue state must never be written').not.toMatch(/issueUpdate|issueArchive|issueDelete|issueUnarchive/);
    if (isCommentCreate) {
      // commentCreate is the ONLY mutation this script may perform.
      expect(Object.keys(c.variables.input).sort()).toEqual(['body', 'issueId']);
    }
  }
}

// ------------------------------------------------------------------ unit level

describe('extractIssueIdentifiers', () => {
  it('prefers the branch, then the title, then the body', () => {
    expect(extractIssueIdentifiers({ branch: 'ai/PRI-725-x', title: 'PRI-999', body: 'PRI-1' })).toEqual({ identifiers: ['PRI-725'], source: 'branch' });
    expect(extractIssueIdentifiers({ branch: 'ai/adhoc-x', title: 'fix PRI-999', body: 'PRI-1' })).toEqual({ identifiers: ['PRI-999'], source: 'title' });
    expect(extractIssueIdentifiers({ branch: 'ai/adhoc-x', title: 'plain title', body: 'closes PRI-1' })).toEqual({ identifiers: ['PRI-1'], source: 'body' });
  });

  it('is case-insensitive and normalises to upper case', () => {
    expect(extractIssueIdentifiers({ branch: 'pri-699-p0-2-active-record' }).identifiers).toEqual(['PRI-699']);
  });

  it('deduplicates and reports nothing when no identifier exists', () => {
    expect(extractIssueIdentifiers({ branch: 'ai/PRI-725-a', body: 'PRI-725 again' }).identifiers).toEqual(['PRI-725']);
    expect(extractIssueIdentifiers({ branch: 'ai/adhoc-20260908-x', title: 'no ticket', body: '' })).toEqual({ identifiers: [], source: null });
  });
});

describe('comment rendering', () => {
  it('embeds a dedupe marker in every reminder', () => {
    expect(renderMissingLinkComment()).toContain(MARKERS.missingLink);
    expect(renderMergeReminder({ prNumber: 1, mergedAt: '2026-09-10', pending: [{ identifier: 'PRI-1', stateName: 'In Progress' }] })).toContain(MARKERS.mergeReminder);
    expect(renderCiFailureComment({ workflowName: 'CI', runId: '1', runUrl: 'u', prNumber: 1 })).toContain(MARKERS.ciFailure('1'));
  });

  it('never claims to have changed state', () => {
    expect(renderMergeReminder({ prNumber: 1, mergedAt: null, pending: [{ identifier: 'PRI-1', stateName: 'In Review' }] })).toContain('不修改任何状态');
    expect(renderCiFailureComment({ workflowName: 'CI', runId: '1', runUrl: 'u', prNumber: 1 })).toContain('不修改状态');
  });
});

describe('payload readers', () => {
  it('reads pull_request facts, including the merged flag', () => {
    const facts = readPullRequestFacts(prEvent({ merged: true, mergedAt: '2026-09-10T10:00:01Z' }));
    expect(facts).toMatchObject({ number: 725, merged: true, mergedAt: '2026-09-10T10:00:01Z', branch: 'ai/PRI-725-linear-sync', fromSameRepo: true });
    expect(readPullRequestFacts({})).toBeNull();
  });

  it('flags fork PRs', () => {
    expect(readPullRequestFacts(prEvent({ sameRepo: false })).fromSameRepo).toBe(false);
  });

  it('reads workflow_run facts', () => {
    expect(readWorkflowRunFacts(runEvent())).toMatchObject({ runId: '99001', workflowName: 'CI', triggeringEvent: 'pull_request', headSha: 'aaaaaaa1', prNumber: 725 });
  });
});

describe('hasMarker', () => {
  it('matches both string bodies and comment objects', () => {
    expect(hasMarker(['x <!-- m --> y'], '<!-- m -->')).toBe(true);
    expect(hasMarker([{ body: 'x <!-- m --> y' }], '<!-- m -->')).toBe(true);
    expect(hasMarker([{ body: 'other' }], '<!-- m -->')).toBe(false);
    expect(hasMarker(undefined, '<!-- m -->')).toBe(false);
  });
});

// ------------------------------------------------------- pull_request scenarios

describe('pr mode — link detection', () => {
  it('records a recognised identifier and posts nothing', async () => {
    const h = harness();
    const cap = captureLog();
    const code = await runCli({ argv: ['pr', '--event-file', writeEvent(prEvent())], env: ENV, fetchImpl: h.fetchImpl, log: cap.log });

    expect(code).toBe(0);
    expect(h.calls.github).toEqual([]);        // no comment read, no comment write
    expect(h.calls.linear).toEqual([]);        // no Linear traffic at all
    expect(cap.lines.join('\n')).toContain('PRI-725');
    assertReadOnlyLinear(h.calls);
  });

  it('reminds once when the PR carries no Linear link', async () => {
    const h = harness();
    const cap = captureLog();
    const code = await runCli({ argv: ['pr', '--event-file', writeEvent(prEvent({ branch: 'ai/adhoc-eev2-error-experience-v2', title: 'feat: x' }))], env: ENV, fetchImpl: h.fetchImpl, log: cap.log });

    expect(code).toBe(0);
    const posts = h.calls.github.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(cap.lines.join('\n')).toContain('reminder posted');
  });

  it('does not repeat the reminder on a re-run', async () => {
    const h = harness({ prComments: [{ body: renderMissingLinkComment() }] });
    const cap = captureLog();
    const code = await runCli({ argv: ['pr', '--event-file', writeEvent(prEvent({ branch: 'ai/adhoc-x' }))], env: ENV, fetchImpl: h.fetchImpl, log: cap.log });

    expect(code).toBe(0);
    expect(h.calls.github.filter((c) => c.method === 'POST')).toEqual([]);
    expect(cap.lines.join('\n')).toContain('already posted');
  });

  it('stays silent for a fork PR (no secrets on fork runs)', async () => {
    const h = harness();
    const cap = captureLog();
    const code = await runCli({ argv: ['pr', '--event-file', writeEvent(prEvent({ sameRepo: false, branch: 'ai/adhoc-x' }))], env: ENV, fetchImpl: h.fetchImpl, log: cap.log });

    expect(code).toBe(0);
    expect(h.calls.github).toEqual([]);
    expect(h.calls.linear).toEqual([]);
    expect(cap.lines.join('\n')).toContain('fork');
  });

  it('stays silent for a PR closed without merging', async () => {
    const h = harness();
    const cap = captureLog();
    const code = await runCli({ argv: ['pr', '--event-file', writeEvent(prEvent({ branch: 'ai/adhoc-x', state: 'closed' }))], env: ENV, fetchImpl: h.fetchImpl, log: cap.log });

    expect(code).toBe(0);
    expect(h.calls.github).toEqual([]);
    expect(cap.lines.join('\n')).toContain('closed without merge');
  });
});

describe('pr mode — merge verification (no state write)', () => {
  it('takes no action when the native Linear integration already moved the issue to Done', async () => {
    const h = harness({ issueById: { 'PRI-725': { stateName: 'Done', stateType: 'completed' } } });
    const cap = captureLog();
    const code = await runCli({
      argv: ['pr', '--event-file', writeEvent(prEvent({ merged: true, mergedAt: '2026-09-10T10:00:01Z' }))],
      env: ENV, fetchImpl: h.fetchImpl, log: cap.log,
    });

    expect(code).toBe(0);
    expect(h.calls.linear.filter((c) => (c.query || '').includes('commentCreate'))).toEqual([]);
    expect(h.calls.github.filter((c) => c.method === 'POST')).toEqual([]);
    expect(cap.lines.join('\n')).toContain('native Linear integration handled it');
    assertReadOnlyLinear(h.calls);
  });

  it('leaves a reminder (not a decision) when the issue did not reach Done', async () => {
    const h = harness({
      issueById: { 'PRI-705': { stateName: 'In Progress', stateType: 'started' } },
      issueComments: {},
    });
    const cap = captureLog();
    const code = await runCli({
      argv: ['pr', '--event-file', writeEvent(prEvent({ branch: 'ai/PRI-705-epic-part-1', merged: true, mergedAt: '2026-09-10T10:00:01Z' }))],
      env: ENV, fetchImpl: h.fetchImpl, log: cap.log,
    });

    expect(code).toBe(0);
    const creates = h.calls.linear.filter((c) => (c.query || '').includes('commentCreate'));
    expect(creates).toHaveLength(1);
    expect(creates[0].variables.input.body).toContain('尚未');
    expect(cap.lines.join('\n')).toContain('reminded on PRI-705');
    assertReadOnlyLinear(h.calls);
  });

  it('does not repeat the merge reminder on a re-run', async () => {
    const h = harness({
      issueById: { 'PRI-705': { stateName: 'In Progress', stateType: 'started' } },
      issueComments: { 'PRI-705': [renderMergeReminder({ prNumber: 1, mergedAt: null, pending: [{ identifier: 'PRI-705', stateName: 'In Progress' }] })] },
    });
    const cap = captureLog();
    const code = await runCli({
      argv: ['pr', '--event-file', writeEvent(prEvent({ branch: 'ai/PRI-705-x', merged: true }))],
      env: ENV, fetchImpl: h.fetchImpl, log: cap.log,
    });

    expect(code).toBe(0);
    expect(h.calls.linear.filter((c) => (c.query || '').includes('commentCreate'))).toEqual([]);
    expect(cap.lines.join('\n')).toContain('already has a merge reminder');
  });

  it('degrades to a warning, not a failure, when the token is absent', async () => {
    const h = harness();
    const cap = captureLog();
    const code = await runCli({
      argv: ['pr', '--event-file', writeEvent(prEvent({ merged: true }))],
      env: { ...ENV, LINEAR_API_KEY: '' }, fetchImpl: h.fetchImpl, log: cap.log,
    });

    expect(code).toBe(0);
    expect(h.calls.linear).toEqual([]);
    expect(cap.lines.join('\n')).toContain('::warning::');
  });
});

// ------------------------------------------------------------ ci-failure mode

describe('ci-failure mode', () => {
  it('notifies the linked issue with the failing run, and never touches state', async () => {
    const h = harness({ issueById: { 'PRI-725': { stateName: 'In Progress', stateType: 'started' } }, prHeadSha: 'aaaaaaa1' });
    const cap = captureLog();
    const code = await runCli({ argv: ['ci-failure', '--event-file', writeEvent(runEvent())], env: ENV, fetchImpl: h.fetchImpl, log: cap.log });

    expect(code).toBe(0);
    const creates = h.calls.linear.filter((c) => (c.query || '').includes('commentCreate'));
    expect(creates).toHaveLength(1);
    const body = creates[0].variables.input.body;
    expect(body).toContain('检测到 CI 失败');
    expect(body).toContain('https://github.com/csuzngjh/principles/actions/runs/99001');
    expect(body).toContain('不修改状态');
    assertReadOnlyLinear(h.calls);
  });

  it('suppresses a failure whose commit was already superseded', async () => {
    const h = harness({ issueById: { 'PRI-725': { stateName: 'In Progress', stateType: 'started' } }, prHeadSha: 'bbbbbbb2' });
    const cap = captureLog();
    const code = await runCli({ argv: ['ci-failure', '--event-file', writeEvent(runEvent({ headSha: 'aaaaaaa1' }))], env: ENV, fetchImpl: h.fetchImpl, log: cap.log });

    expect(code).toBe(0);
    expect(h.calls.linear).toEqual([]);
    expect(cap.lines.join('\n')).toContain('superseded');
  });

  it('does not repeat the notice for the same run id', async () => {
    const h = harness({
      issueById: { 'PRI-725': { stateName: 'In Progress', stateType: 'started' } },
      issueComments: { 'PRI-725': [renderCiFailureComment({ workflowName: 'CI', runId: '99001', runUrl: 'u', prNumber: 725 })] },
      prHeadSha: 'aaaaaaa1',
    });
    const cap = captureLog();
    const code = await runCli({ argv: ['ci-failure', '--event-file', writeEvent(runEvent())], env: ENV, fetchImpl: h.fetchImpl, log: cap.log });

    expect(code).toBe(0);
    expect(h.calls.linear.filter((c) => (c.query || '').includes('commentCreate'))).toEqual([]);
    expect(cap.lines.join('\n')).toContain('already notified');
  });

  it('ignores non-PR runs (a main-branch push has no issue to notify)', async () => {
    const h = harness();
    const cap = captureLog();
    const code = await runCli({ argv: ['ci-failure', '--event-file', writeEvent(runEvent({ event: 'push', headBranch: 'main' }))], env: ENV, fetchImpl: h.fetchImpl, log: cap.log });

    expect(code).toBe(0);
    expect(h.calls.linear).toEqual([]);
    expect(h.calls.github).toEqual([]);
    expect(cap.lines.join('\n')).toContain('not PR-associated');
  });

  it('stays silent when the branch carries no identifier', async () => {
    const h = harness();
    const cap = captureLog();
    const code = await runCli({ argv: ['ci-failure', '--event-file', writeEvent(runEvent({ headBranch: 'ai/adhoc-x' }))], env: ENV, fetchImpl: h.fetchImpl, log: cap.log });

    expect(code).toBe(0);
    expect(h.calls.linear).toEqual([]);
    expect(cap.lines.join('\n')).toContain('nothing to notify');
  });

  it('degrades to a warning when Linear is unhealthy — never blocks CI reporting', async () => {
    const h = harness({ linearFails: true, prHeadSha: 'aaaaaaa1' });
    const cap = captureLog();
    const code = await runCli({ argv: ['ci-failure', '--event-file', writeEvent(runEvent())], env: ENV, fetchImpl: h.fetchImpl, log: cap.log });

    expect(code).toBe(0);
    expect(cap.lines.join('\n')).toContain('failed to notify');
  });

  // Live-verified 2026-09-10: Linear answers an unknown identifier with
  // `Entity not found: Issue` rather than a null issue. A PR referencing a
  // non-existent ticket must read as "no ticket", not as "Linear is down".
  it('treats an unknown identifier as missing, not as a Linear outage', async () => {
    const h = harness({ notFoundIds: ['PRI-9999'], prHeadSha: 'aaaaaaa1' });
    const cap = captureLog();
    const code = await runCli({
      argv: ['ci-failure', '--event-file', writeEvent(runEvent({ headBranch: 'ai/PRI-9999-typo' }))],
      env: ENV, fetchImpl: h.fetchImpl, log: cap.log,
    });

    expect(code).toBe(0);
    expect(cap.lines.join('\n')).toContain('not found in Linear');
    expect(cap.lines.join('\n')).not.toContain('failed to notify');
    expect(h.calls.linear.filter((c) => (c.query || '').includes('commentCreate'))).toEqual([]);
  });

  it('treats an unknown identifier as missing on the merge path too', async () => {
    const h = harness({ notFoundIds: ['PRI-9999'] });
    const cap = captureLog();
    const code = await runCli({
      argv: ['pr', '--event-file', writeEvent(prEvent({ branch: 'ai/PRI-9999-typo', merged: true }))],
      env: ENV, fetchImpl: h.fetchImpl, log: cap.log,
    });

    expect(code).toBe(0);
    expect(cap.lines.join('\n')).toContain('not found in Linear');
    expect(cap.lines.join('\n')).not.toContain('lookup failed');
    assertReadOnlyLinear(h.calls);
  });
});

// -------------------------------------------------------------------- CLI/hygiene

describe('cli contract', () => {
  it('rejects an unknown mode with exit 2 without touching the network', async () => {
    const h = harness();
    const cap = captureLog();
    expect(await runCli({ argv: ['nonsense'], env: ENV, fetchImpl: h.fetchImpl, log: cap.log })).toBe(2);
    expect(h.calls.github).toEqual([]);
    expect(h.calls.linear).toEqual([]);
  });

  it('reports a missing event file instead of throwing', async () => {
    const h = harness();
    const cap = captureLog();
    expect(await runCli({ argv: ['pr', '--event-file', path.join(TMP, 'nope.json')], env: ENV, fetchImpl: h.fetchImpl, log: cap.log })).toBe(2);
  });

  it('never blocks the workflow when GitHub itself is unreachable', async () => {
    const fetchImpl = async () => { throw new Error('ECONNRESET'); };
    const cap = captureLog();
    const code = await runCli({ argv: ['pr', '--event-file', writeEvent(prEvent({ branch: 'ai/adhoc-x' }))], env: ENV, fetchImpl, log: cap.log });
    expect(code).toBe(0);
    expect(cap.lines.join('\n')).toContain('degraded');
  });
});

// --------------------------------------------------------------- repo wiring

describe('workflow wiring', () => {
  const workflowPath = path.resolve(import.meta.dirname, '..', '..', '.github', 'workflows', 'linear-sync.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  it('triggers on the PR lifecycle plus the CI workflow completion', () => {
    expect(workflow).toMatch(/pull_request:\s*\n\s*types:\s*\[opened, reopened, closed\]/);
    expect(workflow).toMatch(/workflow_run:\s*\n(?:.*\n)*?\s*workflows:\s*\[CI\]/);
  });

  it('requests no write permission beyond pull-requests', () => {
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).not.toMatch(/contents:\s*write/);
    expect(workflow).not.toMatch(/issues:\s*write/);
  });

  it('pins both actions to immutable SHAs', () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use, `${use} must be SHA-pinned`).toMatch(/@[0-9a-f]{40}$/);
  });

  it('keeps the reminder off fork PRs and out of state mutation', () => {
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(workflow).not.toMatch(/issueUpdate|stateId/);
  });
});
