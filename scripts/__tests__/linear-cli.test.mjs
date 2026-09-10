import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createCli } = require('../linear-cli/linear.cjs');
const { evaluateStartReadiness } = require('../linear-cli/lib/linear.cjs');
const { evaluateLanguage } = require('../linear-cli/lib/audit.cjs');
const { createClient } = require('../linear-cli/lib/client.cjs');
const { parsePrReference, parseRepoFromRemoteUrl } = require('../linear-cli/lib/github.cjs');

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../linear-cli/linear.cjs');

// ── Test doubles ───────────────────────────────────────────────────────────

function makeClient(router) {
  const calls = [];
  return {
    calls,
    async gql(query, variables = {}) {
      calls.push({ query, variables });
      const r = router(query, variables, calls.length);
      if (!r) {
        return { ok: false, error: { reason: 'stub_no_route', nextAction: 'no fixture matched', details: { query: query.slice(0, 120) } } };
      }
      if (r.error) return { ok: false, error: r.error };
      return { ok: true, data: r.data };
    },
  };
}

/** Route by distinctive query fragments — mirrors the real query set. */
function route(query) {
  if (query.includes('searchIssues')) return 'search';
  if (query.includes('workflowStates')) return 'states';
  if (query.includes('issueLabels')) return 'labels';
  if (query.includes('viewer')) return 'viewer';
  if (query.includes('users(')) return 'users';
  if (query.includes('issueUpdate')) return 'update';
  if (query.includes('commentCreate')) return 'commentCreate';
  if (query.includes('attachmentCreate')) return 'attachmentCreate';
  if (query.includes('issueCreate')) return 'create';
  if (query.includes('projects(first:')) return 'projects';
  if (query.includes('issues(first:')) return 'listIssues';
  if (query.includes('inverseRelations')) return 'links';
  if (query.includes('priorityLabel')) return 'core';
  if (query.includes('comments(last:')) return 'contextComments';
  if (query.includes('comments(first:')) return 'comments';
  if (query.includes('attachments(first:')) return 'attachments';
  if (query.includes('issue(id:$id){ id ')) return 'findIssue';
  return 'unknown';
}

const state = (name, type) => ({ id: `st-${name}`, name, type });

const CORE_ISSUE = {
  id: 'issue-1',
  identifier: 'PRI-722',
  title: '升级 linear-cli：新增上下文、开工、交付、对账与审计命令',
  description: 'x'.repeat(5000),
  priority: 2,
  priorityLabel: 'High',
  url: 'https://linear.app/pri-722',
  branchName: 'csuzngjh/pri-722-升级-linear-cli',
  createdAt: '2026-09-10T06:45:38.100Z',
  updatedAt: '2026-09-10T06:57:39.304Z',
  state: state('Todo', 'unstarted'),
  assignee: { id: 'u1', name: 'gong wesley', email: 'a@b.c' },
  labels: { nodes: [{ id: 'l1', name: 'ready-for-agent' }] },
  parent: null,
  project: { id: 'p1', name: 'Linear 协同控制面升级', slugId: 's1', description: '把 CLI 升级为生命周期工具', status: { name: 'In Progress' }, targetDate: null },
  cycle: { id: 'c1', number: 10, name: null, startsAt: '2026-09-06T16:00:00.000Z', endsAt: '2026-09-20T16:00:00.000Z' },
  team: { id: 't1', key: 'PRI', name: 'Principles_disciple' },
};

function contextRouter(overrides = {}) {
  const core = { ...CORE_ISSUE, ...(overrides.core || {}) };
  const children = overrides.children ?? { nodes: [], pageInfo: { hasNextPage: false } };
  const relations = overrides.relations ?? { nodes: [], pageInfo: { hasNextPage: false } };
  const inverseRelations = overrides.inverseRelations ?? { nodes: [], pageInfo: { hasNextPage: false } };
  const comments = overrides.comments ?? { nodes: [], pageInfo: { hasPreviousPage: false } };
  const attachments = overrides.attachments ?? { nodes: [], pageInfo: { hasNextPage: false } };
  return (query) => {
    switch (route(query)) {
      case 'core': return { data: { issue: core } };
      case 'links': return { data: { issue: { children, relations, inverseRelations } } };
      case 'contextComments': return { data: { issue: { comments } } };
      case 'attachments': return { data: { issue: { attachments } } };
      default: return undefined;
    }
  };
}

function makeGithub(overrides = {}) {
  return {
    detectRepo: async () => ({ ok: true, repo: overrides.repo ?? 'csuzngjh/principles' }),
    listPullRequests: async () => ({ ok: true, pullRequests: overrides.pullRequests ?? [] }),
    getPullRequest: overrides.getPullRequest ?? (async () => ({ ok: true, pullRequest: { number: 1595, title: 'x', state: 'OPEN', merged: false, headRefName: 'ai/PRI-722-x', baseRefName: 'main', url: 'https://github.com/csuzngjh/principles/pull/1595', body: null } })),
  };
}

const cli = (client, github) => createCli({ client, github });

// ── 1. Legacy commands: no regression ──────────────────────────────────────

describe('legacy CRUD — no regression', () => {
  it('issue returns the historical shape', async () => {
    const client = makeClient(() => ({ data: { issue: { id: 'i1', ...CORE_ISSUE, description: 'd', comments: undefined } } }));
    const { output } = await cli(client, makeGithub()).run(['issue', 'PRI-722']);
    expect(output.ok).toBe(true);
    const issue = output.issue;
    for (const k of ['identifier', 'title', 'state', 'stateId', 'priority', 'assignee', 'labels', 'parent', 'url', 'updatedAt', 'createdAt', 'description']) {
      expect(issue).toHaveProperty(k);
    }
    expect(issue.identifier).toBe('PRI-722');
    expect(issue.labels).toEqual(['ready-for-agent']);
  });

  it('search returns count + issues', async () => {
    const client = makeClient(() => ({ data: { searchIssues: { nodes: [CORE_ISSUE] } } }));
    const { output } = await cli(client, makeGithub()).run(['search', 'linear']);
    expect(output).toMatchObject({ ok: true, count: 1 });
    expect(output.issues[0].identifier).toBe('PRI-722');
  });

  it('status resolves the state name and updates', async () => {
    const client = makeClient((q) => {
      if (route(q) === 'states') return { data: { workflowStates: { nodes: [{ id: 's-inreview', name: 'In Review', type: 'started' }] } } };
      if (route(q) === 'update') return { data: { issueUpdate: { success: true, issue: { ...CORE_ISSUE, state: state('In Review', 'started') } } } };
      return { data: { issue: { id: 'i1', ...CORE_ISSUE } } };
    });
    const { output } = await cli(client, makeGithub()).run(['status', 'PRI-722', 'In Review']);
    expect(output.ok).toBe(true);
    expect(output.issue.state).toBe('In Review');
    expect(output.changed).toBe(true);
  });

  it('status is idempotent when already in the target state', async () => {
    const client = makeClient((q) => {
      if (route(q) === 'update') throw new Error('must not mutate when already in state');
      return { data: { issue: { id: 'i1', ...CORE_ISSUE, state: state('Done', 'completed') } } };
    });
    const { output } = await cli(client, makeGithub()).run(['status', 'PRI-722', 'Done']);
    expect(output.ok).toBe(true);
    expect(output.changed).toBe(false);
  });

  it('label add preserves existing labels (replace-semantics guard)', async () => {
    let captured = null;
    const client = makeClient((q, v) => {
      if (route(q) === 'labels') return { data: { issueLabels: { nodes: [{ id: 'lb-new', name: 'lesson-learned' }] } } };
      if (route(q) === 'update') { captured = v.input; return { data: { issueUpdate: { success: true, issue: CORE_ISSUE } } }; }
      return { data: { issue: { id: 'i1', ...CORE_ISSUE, labels: { nodes: [{ id: 'l1', name: 'ready-for-agent' }] } } } };
    });
    const { output } = await cli(client, makeGithub()).run(['label', 'PRI-722', 'add', 'lesson-learned']);
    expect(output.ok).toBe(true);
    expect(captured.labelIds).toEqual(['l1', 'lb-new']);
  });

  it('priority validates range', async () => {
    const client = makeClient(() => ({ data: { issue: { id: 'i1', ...CORE_ISSUE } } }));
    const { exitCode, output } = await cli(client, makeGithub()).run(['priority', 'PRI-722', '9']);
    expect(exitCode).toBe(1);
    expect(output.reason).toBe('invalid_priority');
  });

  it('subissue maps parent/child not-found reasons', async () => {
    const client = makeClient(() => ({ error: { reason: 'issue_not_found', nextAction: 'x' } }));
    const { output } = await cli(client, makeGithub()).run(['subissue', 'PRI-1', 'PRI-2']);
    expect(output.reason).toBe('parent_not_found');
  });

  it('unknown command fails with a stable reason', async () => {
    const { exitCode, output } = await cli(makeClient(() => ({ data: {} })), makeGithub()).run(['nope']);
    expect(exitCode).toBe(1);
    expect(output).toMatchObject({ ok: false, reason: 'unknown_command' });
    expect(typeof output.nextAction).toBe('string');
  });

  it('help advertises both legacy and lifecycle commands', async () => {
    const { output } = await cli(makeClient(() => ({ data: {} })), makeGithub()).run(['help']);
    expect(Object.keys(output.commands)).toEqual(expect.arrayContaining(['context', 'start', 'handoff', 'reconcile', 'audit', 'issue', 'label', 'subissue']));
    expect(output.lifecycle.join(' ')).toContain('handoff');
  });
});

// ── 2. context ─────────────────────────────────────────────────────────────

describe('context', () => {
  it('returns a complete bounded context', async () => {
    const client = makeClient(contextRouter());
    const { output } = await cli(client, makeGithub()).run(['context', 'PRI-722']);
    expect(output.ok).toBe(true);
    const c = output.issue;
    expect(c.identifier).toBe('PRI-722');
    expect(c.status).toEqual({ id: 'st-Todo', name: 'Todo', type: 'unstarted' });
    expect(c.project.name).toBe('Linear 协同控制面升级');
    expect(c.projectGoal).toBe('把 CLI 升级为生命周期工具');
    expect(c.cycle.number).toBe(10);
    expect(c.canStart).toBe(true);
    expect(c.blockingReasons).toEqual([]);
    expect(c.recommendedBranch).toBe('ai/PRI-722-linear-cli');
    expect(c.relations).toHaveProperty('blocks');
    expect(c.relations).toHaveProperty('blockedBy');
    expect(c.relations).toHaveProperty('related');
    expect(c.relations).toHaveProperty('duplicates');
  });

  it('caps a large issue: description truncated and comment count bounded', async () => {
    const manyComments = { nodes: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, body: 'b'.repeat(900), createdAt: 'x', url: 'u', user: { id: 'u', name: 'n' } })), pageInfo: { hasPreviousPage: true } };
    const client = makeClient(contextRouter({ comments: manyComments }));
    const { output } = await cli(client, makeGithub()).run(['context', 'PRI-722', '--comments', '5', '--description-chars', '300', '--comment-chars', '120']);
    const c = output.issue;
    expect(c.description.length).toBeLessThanOrEqual(301);
    expect(c.descriptionTruncated).toBe(true);
    expect(c.comments).toHaveLength(5);
    expect(c.comments[0].bodyTruncated).toBe(true);
    expect(c.meta.truncated.comments).toBe(true);
  });

  it('honours pagination limits for children', async () => {
    const children = { nodes: [], pageInfo: { hasNextPage: true } };
    const client = makeClient(contextRouter({ children }));
    const { output } = await cli(client, makeGithub()).run(['context', 'PRI-722', '--children', '2']);
    expect(output.issue.meta.limits.children).toBe(2);
    expect(output.issue.meta.truncated.children).toBe(true);
    expect(client.calls.find((c) => c.query.includes('children(first:')).variables.children).toBe(2);
  });

  it('keeps query complexity bounded — 4 small queries, no oversized page', async () => {
    const client = makeClient(contextRouter());
    await cli(client, makeGithub()).run(['context', 'PRI-722']);
    expect(client.calls).toHaveLength(4);
    for (const call of client.calls) {
      const pages = [...call.query.matchAll(/\((?:first|last):\s*\$?(\w+)\)/g)].map((m) => m[1]);
      for (const p of pages) {
        const n = call.variables[p] ?? Number(p);
        expect(n).toBeLessThanOrEqual(50);
      }
      // no single query fans out into more than 3 connections
      expect(pages.length).toBeLessThanOrEqual(3);
    }
  });

  it('separates blocks from blockedBy using relation direction', async () => {
    const relations = { nodes: [{ id: 'r1', type: 'blocks', relatedIssue: { identifier: 'PRI-800', title: 'downstream', state: state('Todo', 'unstarted') } }], pageInfo: { hasNextPage: false } };
    const inverseRelations = { nodes: [{ id: 'r2', type: 'blocks', issue: { identifier: 'PRI-799', title: 'upstream', state: state('Todo', 'unstarted') } }], pageInfo: { hasNextPage: false } };
    const client = makeClient(contextRouter({ relations, inverseRelations }));
    const { output } = await cli(client, makeGithub()).run(['context', 'PRI-722']);
    expect(output.issue.relations.blocks.map((x) => x.identifier)).toEqual(['PRI-800']);
    expect(output.issue.relations.blockedBy.map((x) => x.identifier)).toEqual(['PRI-799']);
    expect(output.issue.canStart).toBe(false);
    expect(output.issue.blockingReasons[0].code).toBe('blocked_by_open_issue');
  });

  it('derives pull requests from Linear github attachments', async () => {
    const attachments = { nodes: [{ id: 'a1', title: 'PR', url: 'https://github.com/csuzngjh/principles/pull/1592', source: { type: 'github', pullRequestId: '1' }, createdAt: 'x' }], pageInfo: { hasNextPage: false } };
    const client = makeClient(contextRouter({ attachments }));
    const { output } = await cli(client, makeGithub()).run(['context', 'PRI-722']);
    expect(output.issue.pullRequests).toEqual([{ number: 1592, owner: 'csuzngjh', repo: 'principles', url: 'https://github.com/csuzngjh/principles/pull/1592', title: 'PR', source: 'linear_attachment', provider: 'github', pullRequestId: '1' }]);
  });

  it('fails with issue_not_found for an unknown identifier', async () => {
    const client = makeClient(() => ({ data: { issue: null } }));
    const { exitCode, output } = await cli(client, makeGithub()).run(['context', 'PRI-999']);
    expect(exitCode).toBe(1);
    expect(output.reason).toBe('issue_not_found');
  });
});

// ── 3. start ───────────────────────────────────────────────────────────────

describe('start', () => {
  const statesResponse = { data: { workflowStates: { nodes: [{ id: 's-ip', name: 'In Progress', type: 'started' }] } } };

  it('moves an actionable issue to In Progress', async () => {
    const client = makeClient((q, v) => {
      const r = route(q);
      if (r === 'states') return statesResponse;
      if (r === 'update') return { data: { issueUpdate: { success: true, issue: { ...CORE_ISSUE, state: state('In Progress', 'started') } } } };
      return contextRouter()(q);
    });
    const { output } = await cli(client, makeGithub()).run(['start', 'PRI-722']);
    expect(output.ok).toBe(true);
    expect(output.issue.state).toBe('In Progress');
    expect(output.stateChanged).toBe(true);
    expect(output.recommendedBranch).toBe('ai/PRI-722-linear-cli');
    expect(output.untouched).toEqual(['assignee', 'priority', 'description']);
    expect(output.actions.commentAdded).toBe(false);
  });

  it('never writes assignee / priority / description', async () => {
    let input = null;
    const client = makeClient((q, v) => {
      const r = route(q);
      if (r === 'states') return statesResponse;
      if (r === 'update') { input = v.input; return { data: { issueUpdate: { success: true, issue: CORE_ISSUE } } }; }
      return contextRouter()(q);
    });
    await cli(client, makeGithub()).run(['start', 'PRI-722']);
    expect(Object.keys(input)).toEqual(['stateId']);
  });

  it('refuses a completed issue', async () => {
    const client = makeClient(contextRouter({ core: { state: state('Done', 'completed') } }));
    const { exitCode, output } = await cli(client, makeGithub()).run(['start', 'PRI-722']);
    expect(exitCode).toBe(1);
    expect(output.reason).toBe('issue_completed');
    expect(output.details.blockingReasons[0].code).toBe('issue_completed');
    expect(client.calls.some((c) => c.query.includes('issueUpdate'))).toBe(false);
  });

  it('refuses a canceled issue', async () => {
    const client = makeClient(contextRouter({ core: { state: state('Canceled', 'canceled') } }));
    const { exitCode, output } = await cli(client, makeGithub()).run(['start', 'PRI-722']);
    expect(exitCode).toBe(1);
    expect(output.reason).toBe('issue_canceled');
  });

  it('refuses a duplicate issue', async () => {
    const client = makeClient(contextRouter({ core: { state: state('Duplicate', 'canceled') } }));
    const { exitCode, output } = await cli(client, makeGithub()).run(['start', 'PRI-722']);
    expect(exitCode).toBe(1);
    expect(output.reason).toBe('issue_duplicate');
  });

  it('refuses when blocked by an open issue and mutates nothing', async () => {
    const inverseRelations = { nodes: [{ id: 'r', type: 'blocks', issue: { identifier: 'PRI-799', title: 'upstream', state: state('Todo', 'unstarted') } }], pageInfo: { hasNextPage: false } };
    const client = makeClient(contextRouter({ inverseRelations }));
    const { exitCode, output } = await cli(client, makeGithub()).run(['start', 'PRI-722']);
    expect(exitCode).toBe(1);
    expect(output.reason).toBe('blocked_by_open_issue');
    expect(client.calls.some((c) => c.query.includes('issueUpdate'))).toBe(false);
  });

  it('treats a resolved blocker as startable', () => {
    const r = evaluateStartReadiness({
      state: state('Todo', 'unstarted'),
      labels: [],
      blockedBy: [{ identifier: 'PRI-799', state: state('Done', 'completed') }],
    });
    expect(r.canStart).toBe(true);
  });

  it('writes a start comment only when one is supplied', async () => {
    const client = makeClient((q) => {
      const r = route(q);
      if (r === 'states') return statesResponse;
      if (r === 'commentCreate') return { data: { commentCreate: { success: true, comment: { id: 'cm1', url: 'u' } } } };
      if (r === 'update') return { data: { issueUpdate: { success: true, issue: CORE_ISSUE } } };
      return contextRouter()(q);
    });
    const { output } = await cli(client, makeGithub()).run(['start', 'PRI-722', '--comment', '调查基线：…']);
    expect(output.actions.commentAdded).toBe(true);
  });

  it('is idempotent when already In Progress', async () => {
    const client = makeClient((q) => {
      if (route(q) === 'update') throw new Error('should not mutate');
      return contextRouter({ core: { state: state('In Progress', 'started') } })(q);
    });
    const { output } = await cli(client, makeGithub()).run(['start', 'PRI-722']);
    expect(output.ok).toBe(true);
    expect(output.stateChanged).toBe(false);
  });
});

// ── 4. handoff ─────────────────────────────────────────────────────────────

describe('handoff', () => {
  const PR_URL = 'https://github.com/csuzngjh/principles/pull/1595';

  function handoffClient(overrides = {}) {
    const state2 = overrides.initialState ?? state('In Progress', 'started');
    let comments = overrides.existingComments ?? [];
    return makeClient((q, v) => {
      switch (route(q)) {
        case 'findIssue': return { data: { issue: { id: 'i1', ...CORE_ISSUE, state: state2 } } };
        case 'states': return { data: { workflowStates: { nodes: [{ id: 's-ir', name: 'In Review', type: 'started' }] } } };
        case 'update': return { data: { issueUpdate: { success: true, issue: { ...CORE_ISSUE, state: state('In Review', 'started') } } } };
        case 'attachments': return { data: { issue: { identifier: 'PRI-722', attachments: { nodes: overrides.attachments ?? [] } } } };
        case 'attachmentCreate': return { data: { attachmentCreate: { success: true, attachment: { id: 'a1', url: PR_URL, title: 'PR #1595' } } } };
        case 'comments': return { data: { issue: { identifier: 'PRI-722', comments: { nodes: comments } } } };
        case 'commentCreate': {
          comments = [...comments, { id: 'cm-new', body: v.body, createdAt: 'x', url: 'u', user: { id: 'u', name: 'n' } }];
          return { data: { commentCreate: { success: true, comment: { id: 'cm-new', url: 'u' } } } };
        }
        default: return undefined;
      }
    });
  }

  const githubOk = makeGithub();

  it('verifies the PR, moves to In Review, attaches and comments', async () => {
    const client = handoffClient();
    const { output } = await cli(client, githubOk).run(['handoff', 'PRI-722', '--pr', PR_URL, '--summary', '中文证据摘要']);
    expect(output.ok).toBe(true);
    expect(output.issue.state).toBe('In Review');
    expect(output.pullRequest.number).toBe(1595);
    expect(output.actions.stateChanged).toBe(true);
    expect(output.actions.attachmentAdded).toBe(true);
    expect(output.actions.commentAdded).toBe(true);
    expect(output.actions.merged).toBe(false);
  });

  it('fails closed when the PR does not exist', async () => {
    const gh = { ...githubOk, getPullRequest: async () => ({ ok: false, error: { reason: 'pr_not_found', nextAction: 'x' } }) };
    const client = handoffClient();
    const { exitCode, output } = await cli(client, gh).run(['handoff', 'PRI-722', '--pr', PR_URL]);
    expect(exitCode).toBe(1);
    expect(output.reason).toBe('pr_not_found');
    expect(client.calls.some((c) => c.query.includes('issueUpdate'))).toBe(false);
  });

  it('rejects a PR from the wrong repository', async () => {
    const client = handoffClient();
    const { exitCode, output } = await cli(client, githubOk).run(['handoff', 'PRI-722', '--pr', 'https://github.com/someone/else/pull/1']);
    expect(exitCode).toBe(1);
    expect(output.reason).toBe('pr_repo_mismatch');
  });

  it('rejects an unlinked PR unless --allow-unlinked', async () => {
    const gh = { ...githubOk, getPullRequest: async () => ({ ok: true, pullRequest: { number: 1595, title: 'unrelated', state: 'OPEN', merged: false, headRefName: 'feature/x', baseRefName: 'main', url: PR_URL, body: null } }) };
    const client = handoffClient();
    const blocked = await cli(client, gh).run(['handoff', 'PRI-722', '--pr', PR_URL]);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.output.reason).toBe('pr_key_not_linked');

    const allowed = await cli(handoffClient(), gh).run(['handoff', 'PRI-722', '--pr', PR_URL, '--allow-unlinked']);
    expect(allowed.output.ok).toBe(true);
  });

  it('is idempotent on a second run (no duplicate comment, no duplicate attachment)', async () => {
    const marker = '<!-- linear-cli:handoff:pr=csuzngjh/principles#1595 -->';
    const client = handoffClient({
      attachments: [{ id: 'a1', title: 'PR #1595', url: PR_URL, source: { type: 'github' }, createdAt: 'x' }],
      existingComments: [{ id: 'cm1', body: `之前的摘要\n\n${marker}`, createdAt: 'x', url: 'u', user: { id: 'u', name: 'n' } }],
    });
    const { output } = await cli(client, githubOk).run(['handoff', 'PRI-722', '--pr', PR_URL, '--summary', '再次执行']);
    expect(output.ok).toBe(true);
    expect(output.idempotent.attachmentExisted).toBe(true);
    expect(output.idempotent.commentSkipped).toBe(true);
    expect(output.actions.attachmentAdded).toBe(false);
    expect(output.actions.commentAdded).toBe(false);
    expect(client.calls.filter((c) => c.query.includes('commentCreate'))).toHaveLength(0);
  });

  it('is idempotent when already In Review', async () => {
    const client = handoffClient({ initialState: state('In Review', 'started') });
    const { output } = await cli(client, githubOk).run(['handoff', 'PRI-722', '--pr', PR_URL]);
    expect(output.actions.stateChanged).toBe(false);
    expect(output.actions.alreadyInReview).toBe(true);
  });

  it('never merges — no merge mutation exists in the query set', async () => {
    const client = handoffClient();
    await cli(client, githubOk).run(['handoff', 'PRI-722', '--pr', PR_URL]);
    for (const call of client.calls) expect(call.query.toLowerCase()).not.toContain('merge');
  });
});

// ── 5. reconcile ───────────────────────────────────────────────────────────

describe('reconcile', () => {
  const issue = (identifier, stateName, type, prNumber) => ({
    id: `${identifier}-id`,
    identifier,
    title: `title ${identifier}`,
    state: state(stateName, type),
    attachments: { nodes: prNumber ? [{ id: 'a', title: 'p', url: `https://github.com/csuzngjh/principles/pull/${prNumber}`, source: { type: 'github' }, createdAt: 'x' }] : [] },
  });

  function reconcileClient(issues) {
    return makeClient((q) => {
      if (route(q) === 'listIssues') return { data: { issues: { nodes: issues } } };
      if (route(q) === 'states') return { data: { workflowStates: { nodes: [{ id: 's-done', name: 'Done', type: 'completed' }] } } };
      if (route(q) === 'update') return { data: { issueUpdate: { success: true, issue: { ...CORE_ISSUE, state: state('Done', 'completed') } } } };
      return undefined;
    });
  }

  const pr = (number, s, merged = false) => ({ number, title: `PR ${number}`, state: s, merged, closed: s !== 'OPEN', draft: false, headRefName: `ai/PRI-${number}-x`, baseRefName: 'main', mergedAt: merged ? 't' : null, url: `https://github.com/csuzngjh/principles/pull/${number}`, body: null });

  it('merged PR + issue not Done → deterministic Done', async () => {
    const gh = makeGithub({ pullRequests: [pr(1592, 'MERGED', true)] });
    const { output } = await cli(reconcileClient([issue('PRI-718', 'In Review', 'started', 1592)]), gh).run(['reconcile']);
    expect(output.deterministicActions).toHaveLength(1);
    expect(output.deterministicActions[0].code).toBe('pr_merged_issue_not_done');
    expect(output.deterministicActions[0].action).toEqual({ type: 'set_state', state: 'Done' });
    expect(output.manualReview).toHaveLength(0);
  });

  it('open PR + issue still Todo → warning, never auto-start', async () => {
    const gh = makeGithub({ pullRequests: [pr(1591, 'OPEN')] });
    const { output } = await cli(reconcileClient([issue('PRI-717', 'Todo', 'unstarted', 1591)]), gh).run(['reconcile']);
    expect(output.warnings[0].code).toBe('pr_open_issue_not_started');
    expect(output.deterministicActions).toHaveLength(0);
  });

  it('PR closed unmerged → manual review, never Canceled', async () => {
    const gh = makeGithub({ pullRequests: [pr(1586, 'CLOSED')] });
    const { output } = await cli(reconcileClient([issue('PRI-678', 'In Review', 'started', 1586)]), gh).run(['reconcile']);
    expect(output.manualReview[0].code).toBe('pr_closed_unmerged');
    expect(output.deterministicActions).toHaveLength(0);
  });

  it('issue Done + PR still open → high-risk manual review', async () => {
    const gh = makeGithub({ pullRequests: [pr(1591, 'OPEN')] });
    const { output } = await cli(reconcileClient([issue('PRI-718', 'Done', 'completed', 1591)]), gh).run(['reconcile']);
    expect(output.manualReview[0]).toMatchObject({ code: 'issue_done_pr_still_open', severity: 'high' });
  });

  it('multiple PRs for one issue → conservative manual review', async () => {
    const issues = [{ id: 'x', identifier: 'PRI-700', title: 't', state: state('In Review', 'started'), attachments: { nodes: [{ id: 'a', url: 'https://github.com/csuzngjh/principles/pull/1', source: { type: 'github' } }, { id: 'b', url: 'https://github.com/csuzngjh/principles/pull/2', source: { type: 'github' } }] } }];
    const gh = makeGithub({ pullRequests: [pr(1, 'OPEN'), pr(2, 'MERGED', true)] });
    const { output } = await cli(reconcileClient(issues), gh).run(['reconcile']);
    expect(output.manualReview[0].code).toBe('multiple_prs_for_issue');
    expect(output.deterministicActions).toHaveLength(0);
  });

  it('a branch/title-only match never justifies an automatic write', async () => {
    const gh = makeGithub({ pullRequests: [pr(1590, 'MERGED', true)] });
    const { output } = await cli(reconcileClient([issue('PRI-1590', 'In Review', 'started', null)]), gh).run(['reconcile']);
    expect(output.deterministicActions).toHaveLength(0);
  });

  it('is dry-run by default and writes nothing', async () => {
    const client = reconcileClient([issue('PRI-718', 'In Review', 'started', 1592)]);
    const gh = makeGithub({ pullRequests: [pr(1592, 'MERGED', true)] });
    const { output } = await cli(client, gh).run(['reconcile']);
    expect(output.dryRun).toBe(true);
    expect(output.mode).toBe('dry-run');
    expect(output.applied).toHaveLength(0);
    expect(client.calls.some((c) => c.query.includes('issueUpdate'))).toBe(false);
  });

  it('--apply executes only deterministic actions', async () => {
    const client = reconcileClient([issue('PRI-718', 'In Review', 'started', 1592), issue('PRI-678', 'In Review', 'started', 1586)]);
    const gh = makeGithub({ pullRequests: [pr(1592, 'MERGED', true), pr(1586, 'CLOSED')] });
    const { output } = await cli(client, gh).run(['reconcile', '--apply']);
    expect(output.dryRun).toBe(false);
    expect(output.applied).toHaveLength(1);
    expect(output.applied[0]).toMatchObject({ issue: 'PRI-718', state: 'Done', ok: true });
    expect(output.summary.applied).toBe(1);
  });

  it('reports In Review without any PR', async () => {
    const gh = makeGithub({ pullRequests: [] });
    const { output } = await cli(reconcileClient([issue('PRI-700', 'In Review', 'started', null)]), gh).run(['reconcile']);
    expect(output.warnings[0].code).toBe('in_review_without_pr');
  });
});

// ── 6. audit ───────────────────────────────────────────────────────────────

describe('audit', () => {
  function auditClient(issues, projects = []) {
    return makeClient((q) => {
      if (route(q) === 'listIssues') return { data: { issues: { nodes: issues } } };
      if (route(q) === 'projects') return { data: { projects: { nodes: projects } } };
      return undefined;
    });
  }

  const base = { id: 'i', url: 'u', priority: 0, priorityLabel: 'No priority', labels: { nodes: [] }, parent: null, project: null, children: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] }, attachments: { nodes: [] }, comments: { nodes: [] }, description: '中文描述' };

  it('detects the known hygiene anomalies', async () => {
    const issues = [
      { ...base, id: '1', identifier: 'PRI-1', title: 'no project', state: state('Todo', 'unstarted') },
      { ...base, id: '2', identifier: 'PRI-2', title: 'dup priority', state: state('Todo', 'unstarted'), priority: 2, priorityLabel: 'High', labels: { nodes: [{ id: 'l', name: 'priority:high' }] } },
      { ...base, id: '3', identifier: 'PRI-3', title: 'blocked label', state: state('Todo', 'unstarted'), labels: { nodes: [{ id: 'l', name: 'blocked' }] } },
      { ...base, id: '4', identifier: 'PRI-4', title: 'in progress but blocked', state: state('In Progress', 'started'), inverseRelations: { nodes: [{ id: 'r', type: 'blocks', issue: { identifier: 'PRI-9', title: 'x', state: state('Todo', 'unstarted') } }] } },
    ];
    const projects = [{ id: 'p1', name: 'P1', description: '', status: { name: 'In Progress' }, targetDate: null }];
    const gh = makeGithub({ pullRequests: [] });
    const { output } = await cli(auditClient(issues, projects), gh).run(['audit']);
    expect(output.ok).toBe(true);
    expect(output.readOnly).toBe(true);
    const codes = output.findings.map((f) => f.code);
    expect(codes).toContain('active_issue_without_project');
    expect(codes).toContain('priority_label_duplication');
    expect(codes).toContain('blocked_label_without_relation');
    expect(codes).toContain('in_progress_with_unresolved_blocker');
    // project_without_goal needs an active issue in that project
    expect(codes).not.toContain('project_without_goal');
  });

  it('detects a project without a goal when it holds active issues', async () => {
    const issues = [{ ...base, id: '1', identifier: 'PRI-1', title: 't', state: state('Todo', 'unstarted'), project: { id: 'p1', name: 'P1', description: '', status: { name: 'In Progress' }, targetDate: null } }];
    const projects = [{ id: 'p1', name: 'P1', description: '', status: { name: 'In Progress' }, targetDate: null }];
    const { output } = await cli(auditClient(issues, projects), makeGithub()).run(['audit']);
    expect(output.findings.map((f) => f.code)).toContain('project_without_goal');
  });

  it('detects merged PR whose issue is not Done', async () => {
    const issues = [{ ...base, id: '1', identifier: 'PRI-1', title: 't', state: state('In Review', 'started'), attachments: { nodes: [{ id: 'a', url: 'https://github.com/csuzngjh/principles/pull/1592', source: { type: 'github' } }] } }];
    const gh = makeGithub({ pullRequests: [{ number: 1592, title: 'p', state: 'MERGED', merged: true, closed: true, draft: false, headRefName: 'x', baseRefName: 'main', mergedAt: 't', url: 'https://github.com/csuzngjh/principles/pull/1592', body: null }] });
    const { output } = await cli(auditClient(issues), gh).run(['audit']);
    expect(output.findings.map((f) => f.code)).toContain('merged_pr_issue_not_done');
  });

  it('detects a large issue acting as a project', async () => {
    const children = { nodes: Array.from({ length: 6 }, (_, i) => ({ identifier: `PRI-C${i}`, title: 'c', state: state('Todo', 'unstarted') })) };
    const issues = [{ ...base, id: '1', identifier: 'PRI-1', title: 'tracking', state: state('In Progress', 'started'), children }];
    const { output } = await cli(auditClient(issues), makeGithub()).run(['audit']);
    expect(output.findings.map((f) => f.code)).toContain('issue_acting_as_project');
  });

  it('does NOT flag code identifiers / proper nouns as language violations', () => {
    for (const text of [
      'RuleCode runtimeProfile Prompt GraphQL PR API CLI MCP',
      '使用 RuleCode 与 runtimeProfile 对齐 Prompt 行为。',
      '`createRolloutGovernanceDeps` 返回 reopenRevisionTarget。',
    ]) {
      expect(evaluateLanguage(text).violation).toBe(false);
    }
  });

  it('flags long English-only governance prose', () => {
    const text = 'This change should be merged after the review is completed because the runtime contract was updated and we need to make sure the behavior is correct for all consumers.';
    const verdict = evaluateLanguage(text);
    expect(verdict.violation).toBe(true);
    expect(verdict.cjk).toBe(0);
  });

  it('never mutates anything', async () => {
    const client = auditClient([{ ...base, id: '1', identifier: 'PRI-1', title: 't', state: state('Todo', 'unstarted') }]);
    const { output } = await cli(client, makeGithub()).run(['audit']);
    expect(output.note).toContain('No Linear state was modified');
    for (const call of client.calls) expect(call.query).not.toContain('mutation');
  });
});

// ── 7. transport behaviour ─────────────────────────────────────────────────

describe('transport', () => {
  it('retries transient failures and then succeeds', async () => {
    let attempts = 0;
    const client = createClient({
      token: 'tok',
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) return { ok: false, status: 500, headers: { get: () => null }, text: async () => '' };
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { ok: 1 } }) };
      },
      sleep: async () => {},
    });
    const res = await client.gql('{ x }');
    expect(res.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('honours Retry-After on 429', async () => {
    const sleeps = [];
    const client = createClient({
      token: 'tok',
      fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '7' }, text: async () => '' }),
      sleep: async (ms) => sleeps.push(ms),
    });
    const res = await client.gql('{ x }');
    expect(res.ok).toBe(false);
    expect(res.error.reason).toBe('linear_transient_failed');
    expect(sleeps.every((s) => s >= 7000)).toBe(true);
  });

  it('does not retry a plain GraphQL error', async () => {
    let attempts = 0;
    const client = createClient({
      token: 'tok',
      fetchImpl: async () => {
        attempts += 1;
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ errors: [{ message: 'bad query' }] }) };
      },
      sleep: async () => {},
    });
    const res = await client.gql('{ x }');
    expect(res.ok).toBe(false);
    expect(res.error.reason).toBe('linear_graphql_error');
    expect(attempts).toBe(1);
  });

  it('reports a timeout as transient', async () => {
    const client = createClient({
      token: 'tok',
      fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
      sleep: async () => {},
    });
    const res = await client.gql('{ x }');
    expect(res.error.reason).toBe('linear_transient_failed');
    expect(res.error.details.lastReason).toBe('request_timeout');
  });

  it('fails with missing_linear_api_key when no token exists', async () => {
    const client = createClient({ token: '' });
    const res = await client.gql('{ x }');
    expect(res.error.reason).toBe('missing_linear_api_key');
  });

  it('propagates a GraphQL error through a command unchanged', async () => {
    const client = makeClient(() => ({ error: { reason: 'linear_graphql_error', nextAction: 'check token' } }));
    const { exitCode, output } = await cli(client, makeGithub()).run(['context', 'PRI-722']);
    expect(exitCode).toBe(1);
    expect(output).toMatchObject({ ok: false, reason: 'linear_graphql_error', nextAction: 'check token' });
  });
});

// ── 8. helpers + stdout contract ───────────────────────────────────────────

describe('helpers', () => {
  it('parses PR references', () => {
    expect(parsePrReference('https://github.com/o/r/pull/12')).toEqual({ owner: 'o', repo: 'r', number: 12, url: 'https://github.com/o/r/pull/12' });
    expect(parsePrReference('o/r#12')).toMatchObject({ owner: 'o', repo: 'r', number: 12 });
    expect(parsePrReference('42', 'o/r')).toMatchObject({ number: 42, repo: 'r' });
    expect(parsePrReference('nonsense')).toBeNull();
  });

  it('parses owner/repo from git remotes', () => {
    expect(parseRepoFromRemoteUrl('https://github.com/csuzngjh/principles.git')).toBe('csuzngjh/principles');
    expect(parseRepoFromRemoteUrl('git@github.com:csuzngjh/principles.git')).toBe('csuzngjh/principles');
  });
});

describe('stdout JSON contract (end-to-end subprocess)', () => {
  it('prints exactly one JSON object and exits 1 on failure', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { issue: null } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const { stdout, code } = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI_PATH, 'issue', 'PRI-999'], {
        env: { ...process.env, LINEAR_API_KEY: 'test-token', LINEAR_GRAPHQL_URL: `http://127.0.0.1:${port}/graphql` },
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (c) => resolve({ stdout: out, code: c }));
    });
    server.close();

    expect(code).toBe(1);
    const trimmed = stdout.trim();
    expect(trimmed.startsWith('{')).toBe(true);
    // Exactly one top-level JSON value — re-parsing any remainder must fail.
    const parsed = JSON.parse(trimmed);
    expect(parsed).toMatchObject({ ok: false, reason: 'issue_not_found' });
    expect(typeof parsed.nextAction).toBe('string');
  });
});
