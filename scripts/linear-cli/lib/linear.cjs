'use strict';

/**
 * Linear data access + context assembly.
 *
 * Design constraint from PRI-722: never fetch a task's whole graph in one
 * query. `fetchContext` issues four small, independently bounded queries
 * (core scalars, links, comments, attachments) and merges them. Every
 * connection is capped and its `pageInfo` is surfaced so callers can see
 * truncation instead of assuming completeness.
 */

const TERMINAL_STATE_TYPES = new Set(['completed', 'canceled']);

// ── Shared fragments + normalizers (unchanged from the pre-PRI-722 CLI) ─────

function issueFragment() {
  return `identifier title url priority updatedAt createdAt
    state { id name type }
    assignee { id name email }
    labels { nodes { id name } }
    parent { id identifier title }`;
}

function commentFragment() {
  return `id body createdAt url user { id name }`;
}

function normalizeIssue(i) {
  if (!i) return null;
  return {
    identifier: i.identifier,
    title: i.title,
    state: i.state?.name,
    stateId: i.state?.id,
    priority: i.priority,
    assignee: i.assignee ? { id: i.assignee.id, name: i.assignee.name, email: i.assignee.email } : null,
    labels: i.labels?.nodes?.map((l) => l.name) ?? [],
    parent: i.parent ? { identifier: i.parent.identifier, title: i.parent.title } : null,
    url: i.url,
    updatedAt: i.updatedAt,
    createdAt: i.createdAt,
  };
}

function normalizeComment(c) {
  if (!c) return null;
  const body = String(c.body || '');
  return {
    id: c.id,
    author: c.user?.name ?? null,
    createdAt: c.createdAt,
    url: c.url,
    bodyPreview: body.length > 200 ? `${body.slice(0, 200)}…` : body,
    body,
  };
}

// ── Small helpers ──────────────────────────────────────────────────────────

function truncateText(value, max) {
  const text = String(value ?? '');
  if (!max || text.length <= max) return { value: text, truncated: false };
  return { value: `${text.slice(0, max)}…`, truncated: true };
}

/**
 * Build an ASCII-safe git branch slug from an issue title.
 *
 * Linear's own `Issue.branchName` cannot be used: for PRI-722 it is
 * `csuzngjh/pri-722-升级-linear-cli：新增上下文、开工、交付对账与审计命令`
 * (non-ASCII, full-width colon) which is not a usable git ref.
 */
function slugifyTitle(title) {
  const tokens = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const slug = tokens.slice(0, 5).join('-');
  return (slug || 'task').slice(0, 40).replace(/-+$/, '');
}

function recommendedBranchName(identifier, title) {
  return `ai/${identifier}-${slugifyTitle(title)}`;
}

const GITHUB_PR_URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

/** Extract GitHub PR links from Linear attachments written by the integration. */
function pullRequestsFromAttachments(attachments) {
  const out = [];
  for (const a of attachments || []) {
    const url = a?.url ? String(a.url) : '';
    const m = url.match(GITHUB_PR_URL);
    if (!m) continue;
    out.push({
      number: Number(m[3]),
      owner: m[1],
      repo: m[2],
      url,
      title: a.title ?? null,
      source: 'linear_attachment',
      provider: a?.source?.type ?? null,
      pullRequestId: a?.source?.pullRequestId ?? null,
    });
  }
  return out;
}

/**
 * Decide whether an issue may be started, and why not.
 * Pure — no Linear access, so it is directly unit-testable.
 */
function evaluateStartReadiness({ state, labels = [], blockedBy = [] }) {
  const blockingReasons = [];
  const stateName = state?.name ?? null;
  const stateType = state?.type ?? null;

  // Linear models "Duplicate" as a canceled-type state, so the duplicate name
  // is checked first — the more specific reason is the more useful one.
  if (stateType === 'completed') {
    blockingReasons.push({ code: 'issue_completed', state: stateName, message: `工单状态为 ${stateName}（已完成），不允许重新开始。` });
  } else if (/duplicate/i.test(String(stateName || ''))) {
    blockingReasons.push({ code: 'issue_duplicate', state: stateName, message: `工单状态为 ${stateName}（重复单），不允许重新开始。` });
  } else if (stateType === 'canceled') {
    blockingReasons.push({ code: 'issue_canceled', state: stateName, message: `工单状态为 ${stateName}（已取消），不允许重新开始。` });
  }

  if (labels.some((l) => /^duplicate$/i.test(String(l)))) {
    blockingReasons.push({ code: 'issue_duplicate', message: '工单带 duplicate 标签，需先人工确认是否为重复单。' });
  }

  for (const blocker of blockedBy) {
    if (!TERMINAL_STATE_TYPES.has(blocker?.state?.type)) {
      blockingReasons.push({
        code: 'blocked_by_open_issue',
        issue: blocker.identifier,
        state: blocker?.state?.name ?? null,
        message: `被未关闭工单 ${blocker.identifier}（${blocker?.state?.name ?? '未知状态'}）阻塞。`,
      });
    }
  }

  return { canStart: blockingReasons.length === 0, blockingReasons };
}

// ── Queries ────────────────────────────────────────────────────────────────

async function findIssue(client, id, { withComments = false } = {}) {
  const comments = withComments ? `comments(first:100){ nodes { ${commentFragment()} } }` : '';
  const res = await client.gql(
    `query($id:String!){ issue(id:$id){ id ${issueFragment()} description ${comments} } }`,
    { id },
  );
  if (!res.ok) return res;
  if (!res.data?.issue) {
    return { ok: false, error: { reason: 'issue_not_found', nextAction: 'Check the Linear issue identifier or UUID.', details: { id } } };
  }
  return { ok: true, issue: res.data.issue };
}

async function findStateId(client, name) {
  const res = await client.gql('query{ workflowStates(first:100){ nodes { id name type } } }');
  if (!res.ok) return { ...res, stateId: undefined };
  const wanted = String(name).toLowerCase();
  const state = res.data?.workflowStates?.nodes?.find((s) => String(s.name).toLowerCase() === wanted);
  return { ok: true, stateId: state?.id, state };
}

async function findLabelIdByName(client, name) {
  const res = await client.gql('query{ issueLabels(first:200){ nodes { id name } } }');
  if (!res.ok) return { ...res, labelId: undefined };
  const wanted = String(name).toLowerCase();
  const label = res.data?.issueLabels?.nodes?.find((l) => String(l.name).toLowerCase() === wanted);
  return { ok: true, labelId: label?.id };
}

async function findUserId(client, identifier) {
  if (!identifier || identifier === '--remove') return { ok: true, userId: null };
  if (identifier === 'me') {
    const res = await client.gql('query{ viewer { id } }');
    return res.ok ? { ok: true, userId: res.data?.viewer?.id } : res;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)) {
    return { ok: true, userId: identifier };
  }
  const res = await client.gql(
    'query($email:String!){ users(first:5, filter:{ email:{ eq:$email } }){ nodes { id name email } } }',
    { email: identifier },
  );
  return res.ok ? { ok: true, userId: res.data?.users?.nodes?.[0]?.id } : res;
}

// ── Context assembly (the `context` / `start` shared core) ──────────────────

const CORE_QUERY = `query($id:String!){
  issue(id:$id){
    id identifier title description priority priorityLabel url branchName createdAt updatedAt
    state { id name type }
    assignee { id name email }
    labels { nodes { id name } }
    parent { id identifier title state { name type } }
    project { id name slugId description status { name } targetDate }
    cycle { id number name startsAt endsAt }
    team { id key name }
  }
}`;

const LINKS_QUERY = `query($id:String!,$children:Int!,$relations:Int!){
  issue(id:$id){
    children(first:$children){ nodes { identifier title priority state { name type } } pageInfo { hasNextPage } }
    relations(first:$relations){ nodes { id type relatedIssue { identifier title state { name type } } } pageInfo { hasNextPage } }
    inverseRelations(first:$relations){ nodes { id type issue { identifier title state { name type } } } pageInfo { hasNextPage } }
  }
}`;

const COMMENTS_QUERY = `query($id:String!,$n:Int!){
  issue(id:$id){
    comments(last:$n){ nodes { ${commentFragment()} } pageInfo { hasPreviousPage } }
  }
}`;

const ATTACHMENTS_QUERY = `query($id:String!,$n:Int!){
  issue(id:$id){
    attachments(first:$n){ nodes { id title url subtitle source createdAt } pageInfo { hasNextPage } }
  }
}`;

function compactRelation(nodes, side) {
  return (nodes || [])
    .map((n) => {
      const other = side === 'relatedIssue' ? n.relatedIssue : n.issue;
      if (!other) return null;
      return {
        identifier: other.identifier,
        title: other.title,
        state: other.state?.name ?? null,
        stateType: other.state?.type ?? null,
      };
    })
    .filter(Boolean);
}

function splitRelations(relations, inverseRelations) {
  const blocks = [];
  const blockedBy = [];
  const related = [];
  const duplicates = [];
  for (const r of relations || []) {
    const item = compactRelation([r], 'relatedIssue')[0];
    if (!item) continue;
    if (r.type === 'blocks') blocks.push(item);
    else if (r.type === 'duplicate') duplicates.push(item);
    else related.push(item);
  }
  for (const r of inverseRelations || []) {
    const item = compactRelation([r], 'issue')[0];
    if (!item) continue;
    // Inverse of "A blocks B" is "B is blocked by A".
    if (r.type === 'blocks') blockedBy.push(item);
    else if (r.type === 'duplicate') duplicates.push(item);
    else related.push(item);
  }
  return { blocks, blockedBy, related, duplicates };
}

/**
 * Fetch a bounded task context.
 *
 * Four small queries, each independently capped. `limits` lets the caller
 * shrink the payload for very large issues.
 */
async function fetchContext(client, id, limits = {}) {
  const childrenLimit = Math.max(0, Number(limits.children ?? 20));
  const relationsLimit = Math.max(0, Number(limits.relations ?? 20));
  const commentsLimit = Math.max(0, Number(limits.comments ?? 10));
  const attachmentsLimit = Math.max(0, Number(limits.attachments ?? 10));
  const descriptionChars = Math.max(0, Number(limits.descriptionChars ?? 2000));
  const commentChars = Math.max(0, Number(limits.commentChars ?? 400));

  const core = await client.gql(CORE_QUERY, { id });
  if (!core.ok) return core;
  const issue = core.data?.issue;
  if (!issue) {
    return { ok: false, error: { reason: 'issue_not_found', nextAction: 'Check the Linear issue identifier or UUID.', details: { id } } };
  }

  const links = await client.gql(LINKS_QUERY, { id, children: childrenLimit, relations: relationsLimit });
  if (!links.ok) return links;
  const comments = await client.gql(COMMENTS_QUERY, { id, n: commentsLimit });
  if (!comments.ok) return comments;
  const attachments = await client.gql(ATTACHMENTS_QUERY, { id, n: attachmentsLimit });
  if (!attachments.ok) return attachments;

  const linkNodes = links.data?.issue ?? {};
  const rel = splitRelations(
    linkNodes.relations?.nodes ?? [],
    linkNodes.inverseRelations?.nodes ?? [],
  );
  const labels = (issue.labels?.nodes ?? []).map((l) => l.name);
  const { canStart, blockingReasons } = evaluateStartReadiness({
    state: issue.state,
    labels,
    blockedBy: rel.blockedBy,
  });

  const description = truncateText(issue.description, descriptionChars);
  const rawAttachments = attachments.data?.issue?.attachments?.nodes ?? [];
  // `comments(last:n)` already bounds the response; keeping the newest n makes
  // that bound a guarantee even if a server ever returns more than asked.
  const newestComments = (comments.data?.issue?.comments?.nodes ?? []).filter(
    (c) => String(c?.body || '').trim().length > 0,
  );
  // `comments(last:n)` already bounds the response; keeping the newest n makes
  // that bound a guarantee even if a server ever returns more than asked.
  // Note: slice(-0) would return everything, so zero is handled explicitly.
  const rawComments = commentsLimit > 0 ? newestComments.slice(-commentsLimit) : [];

  const context = {
    identifier: issue.identifier,
    title: issue.title,
    description: description.value,
    descriptionTruncated: description.truncated,
    priority: issue.priority,
    priorityLabel: issue.priorityLabel,
    status: { id: issue.state?.id, name: issue.state?.name, type: issue.state?.type },
    assignee: issue.assignee ? { id: issue.assignee.id, name: issue.assignee.name, email: issue.assignee.email } : null,
    labels,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    team: issue.team ? { id: issue.team.id, key: issue.team.key, name: issue.team.name } : null,
    parent: issue.parent
      ? { identifier: issue.parent.identifier, title: issue.parent.title, state: issue.parent.state?.name ?? null, stateType: issue.parent.state?.type ?? null }
      : null,
    children: (linkNodes.children?.nodes ?? []).map((c) => ({
      identifier: c.identifier,
      title: c.title,
      priority: c.priority,
      state: c.state?.name ?? null,
      stateType: c.state?.type ?? null,
    })),
    project: issue.project
      ? {
          id: issue.project.id,
          name: issue.project.name,
          status: issue.project.status?.name ?? null,
          targetDate: issue.project.targetDate ?? null,
          description: issue.project.description ?? null,
        }
      : null,
    projectGoal: issue.project?.description ?? null,
    cycle: issue.cycle
      ? { id: issue.cycle.id, number: issue.cycle.number, name: issue.cycle.name, startsAt: issue.cycle.startsAt, endsAt: issue.cycle.endsAt }
      : null,
    relations: rel,
    comments: rawComments.map((c) => {
      const t = truncateText(c.body, commentChars);
      return {
        id: c.id,
        author: c.user?.name ?? null,
        createdAt: c.createdAt,
        url: c.url,
        body: t.value,
        bodyTruncated: t.truncated,
      };
    }),
    attachments: rawAttachments.map((a) => ({
      id: a.id,
      title: a.title ?? null,
      url: a.url ?? null,
      sourceType: a.source?.type ?? null,
      createdAt: a.createdAt,
    })),
    pullRequests: pullRequestsFromAttachments(rawAttachments),
    recommendedBranch: recommendedBranchName(issue.identifier, issue.title),
    canStart,
    blockingReasons,
    meta: {
      queries: 4,
      truncated: {
        children: Boolean(linkNodes.children?.pageInfo?.hasNextPage),
        relations: Boolean(linkNodes.relations?.pageInfo?.hasNextPage),
        inverseRelations: Boolean(linkNodes.inverseRelations?.pageInfo?.hasNextPage),
        comments: Boolean(comments.data?.issue?.comments?.pageInfo?.hasPreviousPage),
        attachments: Boolean(attachments.data?.issue?.attachments?.pageInfo?.hasNextPage),
      },
      limits: { children: childrenLimit, relations: relationsLimit, comments: commentsLimit, attachments: attachmentsLimit, descriptionChars, commentChars },
    },
  };

  return { ok: true, issue, context };
}

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Move an issue to a workflow state. Idempotent: if it is already in the
 * target state, no mutation is issued.
 */
async function setIssueState(client, issue, stateName) {
  if (String(issue.state?.name).toLowerCase() === String(stateName).toLowerCase()) {
    return { ok: true, issue, changed: false, previousState: issue.state?.name };
  }
  const found = await findStateId(client, stateName);
  if (!found.ok) return found;
  if (!found.stateId) {
    return { ok: false, error: { reason: 'state_not_found', nextAction: 'Run: states, then retry with an exact state name.', details: { stateName } } };
  }
  const res = await client.gql(
    `mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id,input:$input){ success issue { ${issueFragment()} } } }`,
    { id: issue.id, input: { stateId: found.stateId } },
  );
  if (!res.ok) return res;
  return { ok: true, issue: res.data.issueUpdate.issue, changed: true, previousState: issue.state?.name };
}

async function updateIssue(client, issueId, input) {
  return client.gql(
    `mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id,input:$input){ success issue { ${issueFragment()} } } }`,
    { id: issueId, input },
  );
}

async function createComment(client, issueId, body) {
  return client.gql(
    'mutation($issueId:String!,$body:String!){ commentCreate(input:{issueId:$issueId,body:$body}){ success comment { id url } } }',
    { issueId, body },
  );
}

async function listComments(client, issueId, first = 50) {
  return client.gql(
    `query($id:String!,$first:Int!){ issue(id:$id){ identifier comments(first:$first){ nodes { ${commentFragment()} } } } }`,
    { id: issueId, first },
  );
}

async function createAttachment(client, issueId, { url, title }) {
  return client.gql(
    'mutation($input:AttachmentCreateInput!){ attachmentCreate(input:$input){ success attachment { id url title } } }',
    { input: { issueId, url, title } },
  );
}

async function fetchAttachments(client, issueId, first = 20) {
  return client.gql(
    `query($id:String!,$first:Int!){ issue(id:$id){ identifier attachments(first:$first){ nodes { id title url subtitle source createdAt } } } }`,
    { id: issueId, first },
  );
}

/**
 * List issues, optionally restricted to workflow-state names.
 *
 * `includeGraph: false` is the reconcile shape: only the fields needed to
 * pair issues with PRs. Keeping the two shapes separate is deliberate — the
 * audit shape pulls children/relations/comments and would push a scan of
 * dozens of issues far closer to Linear's query-complexity ceiling.
 */
async function listIssues(client, { stateNames, limit = 25, projectId, includeGraph = true } = {}) {
  const filter = {};
  if (projectId) filter.project = { id: { eq: projectId } };
  if (stateNames && stateNames.length) filter.state = { name: { in: stateNames } };
  const graph = includeGraph
    ? `description priority priorityLabel
       assignee { id name email }
       labels { nodes { id name } }
       parent { id identifier title state { name type } project { id name } }
       children(first:20){ nodes { identifier title state { name type } } }
       relations(first:20){ nodes { id type relatedIssue { identifier title state { name type } } } }
       inverseRelations(first:20){ nodes { id type issue { identifier title state { name type } } } }
       comments(last:5){ nodes { id body createdAt url user { id name } } }`
    : '';
  const res = await client.gql(
    `query($first:Int,$filter:IssueFilter){
      issues(first:$first, filter:$filter, orderBy: updatedAt){
        nodes { id identifier title url
          state { id name type }
          project { id name slugId description status { name } targetDate }
          attachments(first:10){ nodes { id title url source createdAt } }
          ${graph}
        }
      }
    }`,
    { first: limit, filter },
  );
  if (!res.ok) return res;
  return { ok: true, issues: res.data?.issues?.nodes ?? [] };
}

/**
 * Projects are fetched WITHOUT their nested issue list: nesting
 * `issues { nodes { state } }` under `projects(first:50)` multiplies query
 * complexity (50 × 50) for a fact the audit can compute from the issue scan
 * it already performed.
 */
async function listProjects(client, { limit = 50 } = {}) {
  const res = await client.gql(
    `query($first:Int){
      projects(first:$first){
        nodes { id name slugId description status { name } targetDate startDate createdAt updatedAt }
      }
    }`,
    { first: limit },
  );
  if (!res.ok) return res;
  return { ok: true, projects: res.data?.projects?.nodes ?? [] };
}

module.exports = {
  TERMINAL_STATE_TYPES,
  issueFragment,
  commentFragment,
  normalizeIssue,
  normalizeComment,
  truncateText,
  slugifyTitle,
  recommendedBranchName,
  pullRequestsFromAttachments,
  evaluateStartReadiness,
  findIssue,
  findStateId,
  findLabelIdByName,
  findUserId,
  fetchContext,
  setIssueState,
  updateIssue,
  createComment,
  listComments,
  createAttachment,
  fetchAttachments,
  listIssues,
  listProjects,
  splitRelations,
  GITHUB_PR_URL,
};
