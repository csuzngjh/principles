#!/usr/bin/env node
'use strict';

/**
 * linear-cli — a Linear + GitHub command line for AI development lifecycle.
 *
 * Contract (unchanged since before PRI-722):
 *   - stdout contains EXACTLY ONE JSON object;
 *   - failure is `{ ok:false, reason:"machine_readable", nextAction:"...", details?:{} }`;
 *   - exit code 1 on failure.
 *
 * Lifecycle commands added by PRI-722:
 *   context  — one bounded read of everything an agent needs before coding
 *   start    — guarded transition into In Progress (fail-closed)
 *   handoff  — verify a real PR, move to In Review, attach + summarise
 *   reconcile— Linear × GitHub drift check, DRY RUN by default
 *   audit    — workspace hygiene report, never mutates
 *
 * Existing CRUD commands are preserved verbatim as low-level tools.
 */

const fs = require('node:fs');
const { createClient } = require('./lib/client.cjs');
const L = require('./lib/linear.cjs');
const {
  createGitHub,
  parsePrReference,
  issueKeysFromPullRequest,
} = require('./lib/github.cjs');
const {
  associateIssuesWithPullRequests,
  buildReconciliationPlan,
  summarize,
} = require('./lib/reconcile.cjs');
const { auditWorkspace } = require('./lib/audit.cjs');

const DEFAULT_TEAM_ID = process.env.LINEAR_TEAM_ID || '5e746d13-253f-43fa-a0e5-716b4da7edcd';
const IN_REVIEW_STATE = 'In Review';
const IN_PROGRESS_STATE = 'In Progress';
const DONE_STATE = 'Done';

/** Machine marker making handoff comments idempotent without parsing prose. */
const handoffMarker = (owner, repo, number) => `<!-- linear-cli:handoff:pr=${owner}/${repo}#${number} -->`;

// ── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Page-size flags must stay in a range Linear accepts (a connection `first`
 * of 0 is rejected) and small enough to keep query complexity bounded.
 */
function pageSize(value, fallback) {
  return Math.min(250, Math.max(1, num(value, fallback)));
}

/** A flag passed without a value parses to `true` — never treat that as text. */
function textFlag(value) {
  return typeof value === 'string' ? value : '';
}

function firstPositional(flags, positional, key = 'id') {
  return flags[key] || positional[0];
}

// ── CLI factory (dependency injection point for tests) ─────────────────────

function createCli(deps = {}) {
  const client = deps.client || createClient(deps.clientOptions);
  const github = deps.github || createGitHub(deps.githubOptions);

  // ── Existing CRUD commands ───────────────────────────────────────────────

  async function cmdSearch(flags, positional) {
    const term = flags.query || flags.q || positional.join(' ');
    if (!term) return { reason: 'missing_query', nextAction: 'Usage: linear.cjs search <query> [--limit 20]' };
    const first = num(flags.limit, 20);
    const res = await client.gql(
      `query($term:String!,$first:Int,$teamId:String){
        searchIssues(term:$term, first:$first, teamId:$teamId, includeComments:true) { nodes { ${L.issueFragment()} } }
      }`,
      { term, first, teamId: flags.team || DEFAULT_TEAM_ID },
    );
    if (!res.ok) return res.error;
    return { ok: true, count: res.data.searchIssues.nodes.length, issues: res.data.searchIssues.nodes.map(L.normalizeIssue) };
  }

  async function cmdIssue(flags, positional) {
    const id = firstPositional(flags, positional);
    if (!id) return { reason: 'missing_issue_id', nextAction: 'Usage: linear.cjs issue PRI-123 [--comments]' };
    const withComments = Boolean(flags.comments);
    const res = await L.findIssue(client, id, { withComments });
    if (!res.ok) return res.error;
    const out = { ...L.normalizeIssue(res.issue), description: res.issue.description };
    if (withComments) out.comments = (res.issue.comments?.nodes ?? []).map(L.normalizeComment);
    return { ok: true, issue: out };
  }

  async function cmdStates() {
    const res = await client.gql('query{ workflowStates(first:100){ nodes { id name type } } }');
    if (!res.ok) return res.error;
    return { ok: true, states: res.data.workflowStates.nodes };
  }

  async function cmdLabelsAll() {
    const res = await client.gql('query{ issueLabels(first:200){ nodes { id name } } }');
    if (!res.ok) return res.error;
    return { ok: true, labels: res.data.issueLabels.nodes };
  }

  async function cmdLabelsOnIssue(flags, positional) {
    const id = firstPositional(flags, positional);
    if (!id) return { reason: 'missing_issue_id', nextAction: 'Usage: linear.cjs labels PRI-123' };
    const res = await L.findIssue(client, id);
    if (!res.ok) return res.error;
    return { ok: true, issue: res.issue.identifier, labels: res.issue.labels?.nodes ?? [] };
  }

  async function cmdComments(flags, positional) {
    const id = firstPositional(flags, positional);
    if (!id) return { reason: 'missing_issue_id', nextAction: 'Usage: linear.cjs comments PRI-123' };
    const res = await client.gql(
      `query($id:String!){ issue(id:$id){ identifier comments(first:100){ nodes { ${L.commentFragment()} } } } }`,
      { id },
    );
    if (!res.ok) return res.error;
    if (!res.data.issue) return { reason: 'issue_not_found', nextAction: 'Check the Linear issue identifier or UUID.', details: { id } };
    return { ok: true, issue: res.data.issue.identifier, comments: (res.data.issue.comments?.nodes ?? []).map(L.normalizeComment) };
  }

  async function cmdComment(flags, positional) {
    const id = firstPositional(flags, positional);
    if (!id) return { reason: 'missing_issue_id', nextAction: 'Usage: linear.cjs comment PRI-123 --body-file comment.md' };
    const found = await L.findIssue(client, id);
    if (!found.ok) return found.error;
    const body = readBody(flags).trim();
    if (!body) return { reason: 'missing_comment_body', nextAction: 'Pass --body, --body-file, or pipe markdown on stdin.' };
    const res = await L.createComment(client, found.issue.id, body);
    if (!res.ok) return res.error;
    return { ok: true, issue: found.issue.identifier, comment: res.data.commentCreate.comment };
  }

  async function cmdStatus(flags, positional) {
    const id = firstPositional(flags, positional);
    const stateName = flags.state || positional[1];
    if (!id || !stateName) return { reason: 'missing_status_args', nextAction: 'Usage: linear.cjs status PRI-123 "In Review"' };
    const found = await L.findIssue(client, id);
    if (!found.ok) return found.error;
    const res = await L.setIssueState(client, found.issue, stateName);
    if (!res.ok) return res.error;
    return { ok: true, issue: L.normalizeIssue(res.issue), changed: res.changed, previousState: res.previousState };
  }

  async function cmdCreate(flags) {
    const title = flags.title;
    if (!title) return { reason: 'missing_title', nextAction: 'Usage: linear.cjs create --title "..." [--description-file body.md] [--priority 2]' };
    const description = flags.description || (flags['description-file'] ? fs.readFileSync(flags['description-file'], 'utf8') : '');
    const input = { teamId: flags.team || DEFAULT_TEAM_ID, title, description };
    if (flags.priority !== undefined) input.priority = Number(flags.priority);
    if (flags.state) {
      const s = await L.findStateId(client, flags.state);
      if (!s.ok) return s.error;
      if (!s.stateId) return { reason: 'state_not_found', nextAction: 'Run: linear.cjs states, then retry with an exact state name.', details: { stateName: flags.state } };
      input.stateId = s.stateId;
    }
    if (flags.assignee) {
      const u = await L.findUserId(client, flags.assignee);
      if (!u.ok) return u.error;
      if (!u.userId) return { reason: 'assignee_not_found', nextAction: 'Use "me", a user email, or a user UUID.', details: { assignee: flags.assignee } };
      input.assigneeId = u.userId;
    }
    if (flags.label) {
      const names = String(flags.label).split(',').map((s) => s.trim()).filter(Boolean);
      const ids = [];
      for (const name of names) {
        const l = await L.findLabelIdByName(client, name);
        if (!l.ok) return l.error;
        if (!l.labelId) return { reason: 'label_not_found', nextAction: `Label "${name}" does not exist. Create it in the Linear UI first.`, details: { label: name } };
        ids.push(l.labelId);
      }
      input.labelIds = ids;
    }
    if (flags.parent) {
      const p = await L.findIssue(client, flags.parent);
      if (!p.ok) return { ...p.error, reason: 'parent_not_found', nextAction: 'Check the parent issue identifier.' };
      input.parentId = p.issue.id;
    }
    const res = await client.gql(
      `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue { ${L.issueFragment()} } } }`,
      { input },
    );
    if (!res.ok) return res.error;
    return { ok: true, issue: L.normalizeIssue(res.data.issueCreate.issue) };
  }

  async function cmdList(flags) {
    const first = num(flags.limit, 50);
    const filter = { team: { id: { eq: flags.team || DEFAULT_TEAM_ID } } };
    if (flags.state) filter.state = { name: { eq: flags.state } };
    if (flags.label) {
      const l = await L.findLabelIdByName(client, flags.label);
      if (!l.ok) return l.error;
      if (!l.labelId) return { reason: 'label_not_found', nextAction: `Label "${flags.label}" does not exist.`, details: { label: flags.label } };
      filter.labels = { id: { eq: l.labelId } };
    }
    if (flags.assignee) {
      const u = await L.findUserId(client, flags.assignee);
      if (!u.ok) return u.error;
      if (!u.userId) return { reason: 'assignee_not_found', nextAction: 'Use "me", a user email, or a user UUID.', details: { assignee: flags.assignee } };
      filter.assignee = { id: { eq: u.userId } };
    }
    const res = await client.gql(
      `query($first:Int,$filter:IssueFilter){ issues(first:$first, filter:$filter, orderBy: updatedAt) { nodes { ${L.issueFragment()} } } }`,
      { first, filter },
    );
    if (!res.ok) return res.error;
    return { ok: true, count: res.data.issues.nodes.length, issues: res.data.issues.nodes.map(L.normalizeIssue) };
  }

  /** label add/remove uses read-modify-write: labelIds is replace-semantics. */
  async function cmdLabel(flags, positional) {
    const id = firstPositional(flags, positional);
    const action = (flags.action || positional[1] || '').toLowerCase();
    const labelName = flags.name || positional[2];
    if (!id || !action || !labelName) return { reason: 'missing_label_args', nextAction: 'Usage: linear.cjs label PRI-123 add|remove <label-name>' };
    if (action !== 'add' && action !== 'remove') return { reason: 'invalid_label_action', nextAction: 'Action must be "add" or "remove".', details: { action } };
    const found = await L.findIssue(client, id);
    if (!found.ok) return found.error;
    const currentIds = (found.issue.labels?.nodes ?? []).map((l) => l.id);
    const l = await L.findLabelIdByName(client, labelName);
    if (!l.ok) return l.error;
    if (!l.labelId) return { reason: 'label_not_found', nextAction: `Label "${labelName}" does not exist.`, details: { label: labelName } };
    let nextIds;
    if (action === 'add') {
      if (currentIds.includes(l.labelId)) {
        return { ok: true, issue: found.issue.identifier, label: labelName, action: 'add', note: 'label already present — no change' };
      }
      nextIds = [...currentIds, l.labelId];
    } else {
      if (!currentIds.includes(l.labelId)) {
        return { ok: true, issue: found.issue.identifier, label: labelName, action: 'remove', note: 'label not present — no change' };
      }
      nextIds = currentIds.filter((x) => x !== l.labelId);
    }
    const res = await L.updateIssue(client, found.issue.id, { labelIds: nextIds });
    if (!res.ok) return res.error;
    return { ok: true, issue: found.issue.identifier, label: labelName, action, labels: res.data.issueUpdate.issue.labels?.nodes?.map((x) => x.name) ?? [] };
  }

  async function cmdPriority(flags, positional) {
    const id = firstPositional(flags, positional);
    const value = flags.value || positional[1];
    if (!id || value === undefined) return { reason: 'missing_priority_args', nextAction: 'Usage: linear.cjs priority PRI-123 <0-4>' };
    const priority = Number(value);
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
      return { reason: 'invalid_priority', nextAction: 'Priority must be an integer 0-4 (0=None,1=Urgent,2=High,3=Medium,4=Low).', details: { value } };
    }
    const found = await L.findIssue(client, id);
    if (!found.ok) return found.error;
    const res = await L.updateIssue(client, found.issue.id, { priority });
    if (!res.ok) return res.error;
    return { ok: true, issue: L.normalizeIssue(res.data.issueUpdate.issue) };
  }

  async function cmdAssign(flags, positional) {
    const id = firstPositional(flags, positional);
    const who = positional[1];
    const remove = Boolean(flags.remove);
    if (!id) return { reason: 'missing_assign_args', nextAction: 'Usage: linear.cjs assign PRI-123 <email|me|uuid>  (or: assign PRI-123 --remove)' };
    const found = await L.findIssue(client, id);
    if (!found.ok) return found.error;
    const input = remove ? { assigneeId: null } : {};
    if (!remove) {
      if (!who) return { reason: 'missing_assign_args', nextAction: 'Provide an assignee (email, "me", or UUID), or use --remove to unassign.' };
      const u = await L.findUserId(client, who);
      if (!u.ok) return u.error;
      if (!u.userId) return { reason: 'assignee_not_found', nextAction: 'Use "me", a user email, or a user UUID.', details: { assignee: who } };
      input.assigneeId = u.userId;
    }
    const res = await L.updateIssue(client, found.issue.id, input);
    if (!res.ok) return res.error;
    return { ok: true, issue: L.normalizeIssue(res.data.issueUpdate.issue) };
  }

  async function cmdSubissue(flags, positional) {
    const parentIdent = flags.parent || positional[0];
    const childIdent = flags.child || positional[1];
    if (!parentIdent || !childIdent) return { reason: 'missing_subissue_args', nextAction: 'Usage: linear.cjs subissue <parent> <child>' };
    const parent = await L.findIssue(client, parentIdent);
    if (!parent.ok) return { ...parent.error, reason: 'parent_not_found', nextAction: 'Check the parent issue identifier.', details: { parent: parentIdent } };
    const child = await L.findIssue(client, childIdent);
    if (!child.ok) return { ...child.error, reason: 'child_not_found', nextAction: 'Check the child issue identifier.', details: { child: childIdent } };
    const res = await L.updateIssue(client, child.issue.id, { parentId: parent.issue.id });
    if (!res.ok) return res.error;
    return { ok: true, parent: parent.issue.identifier, child: L.normalizeIssue(res.data.issueUpdate.issue) };
  }

  // ── context ──────────────────────────────────────────────────────────────

  async function cmdContext(flags, positional) {
    const id = firstPositional(flags, positional);
    if (!id) return { reason: 'missing_issue_id', nextAction: 'Usage: linear.cjs context PRI-123 [--comments 10] [--children 20]' };
    const res = await L.fetchContext(client, id, {
      children: pageSize(flags.children, 20),
      relations: pageSize(flags.relations, 20),
      comments: pageSize(flags.comments, 10),
      attachments: pageSize(flags.attachments, 10),
      descriptionChars: num(flags['description-chars'], 2000),
      commentChars: num(flags['comment-chars'], 400),
    });
    if (!res.ok) return res.error;
    return { ok: true, issue: res.context };
  }

  // ── start ────────────────────────────────────────────────────────────────

  async function cmdStart(flags, positional) {
    const id = firstPositional(flags, positional);
    if (!id) return { reason: 'missing_issue_id', nextAction: 'Usage: linear.cjs start PRI-123 [--comment-file plan.md]' };

    const ctx = await L.fetchContext(client, id, {
      children: pageSize(flags.children, 20),
      relations: pageSize(flags.relations, 20),
      comments: pageSize(flags.comments, 5),
      attachments: pageSize(flags.attachments, 10),
      descriptionChars: num(flags['description-chars'], 2000),
      commentChars: num(flags['comment-chars'], 400),
    });
    if (!ctx.ok) return ctx.error;

    const { canStart, blockingReasons } = ctx.context;
    if (!canStart) {
      const first = blockingReasons[0];
      return {
        ok: false,
        reason: first.code,
        nextAction: 'Resolve the blocker first, or run `context` to inspect blockingReasons. This command never auto-clears a blocker.',
        details: {
          identifier: ctx.context.identifier,
          status: ctx.context.status.name,
          canStart: false,
          blockingReasons,
        },
      };
    }

    const setRes = await L.setIssueState(client, ctx.issue, IN_PROGRESS_STATE);
    if (!setRes.ok) return setRes.error;

    // A start comment is opt-in: writing one unconditionally produces noise
    // with no investigation content.
    let comment = null;
    const body = textFlag(flags.comment) || (flags['comment-file'] ? fs.readFileSync(flags['comment-file'], 'utf8') : '');
    if (String(body).trim()) {
      const created = await L.createComment(client, ctx.issue.id, String(body).trim());
      if (!created.ok) return created.error;
      comment = created.data.commentCreate.comment;
    }

    return {
      ok: true,
      issue: L.normalizeIssue(setRes.issue),
      started: true,
      stateChanged: setRes.changed,
      previousState: setRes.previousState,
      canStart: true,
      blockingReasons: [],
      recommendedBranch: ctx.context.recommendedBranch,
      worktreeHint: `git worktree add -b ${ctx.context.recommendedBranch} <path> origin/main`,
      untouched: ['assignee', 'priority', 'description'],
      actions: { stateSet: setRes.changed, commentAdded: Boolean(comment) },
      comment,
      context: ctx.context,
    };
  }

  // ── handoff ──────────────────────────────────────────────────────────────

  async function cmdHandoff(flags, positional) {
    const id = firstPositional(flags, positional);
    if (!id) return { reason: 'missing_issue_id', nextAction: 'Usage: linear.cjs handoff PRI-123 --pr <url>' };
    const prInput = flags.pr || flags['pr-url'];
    if (!prInput || prInput === true) return { reason: 'missing_pr_reference', nextAction: 'Pass --pr <url> (e.g. https://github.com/owner/repo/pull/123).' };

    const found = await L.findIssue(client, id);
    if (!found.ok) return found.error;
    const issue = found.issue;

    const repoFlag = typeof flags.repo === 'string' ? flags.repo : null;
    const expected = repoFlag ? { ok: true, repo: repoFlag } : await github.detectRepo();
    if (!expected.ok) return expected.error;

    const ref = parsePrReference(prInput, expected.repo);
    if (!ref) return { reason: 'pr_reference_invalid', nextAction: 'Use a full PR url (https://github.com/owner/repo/pull/123) or owner/repo#123.', details: { input: String(prInput) } };
    if (`${ref.owner}/${ref.repo}` !== expected.repo) {
      return { reason: 'pr_repo_mismatch', nextAction: `PR belongs to ${ref.owner}/${ref.repo}, expected ${expected.repo}.`, details: { expected: expected.repo, actual: `${ref.owner}/${ref.repo}` } };
    }

    // 1. The PR must really exist — verified against GitHub, not inferred.
    const prRes = await github.getPullRequest({ number: ref.number, repo: expected.repo });
    if (!prRes.ok) return prRes.error;
    const pr = prRes.pullRequest;

    // 2. Issue↔PR association, from structured sources only.
    const attachRes = await L.fetchAttachments(client, issue.id);
    if (!attachRes.ok) return attachRes.error;
    const attachments = attachRes.data?.issue?.attachments?.nodes ?? [];
    const alreadyAttached = attachments.some((a) => String(a?.url || '').includes(`/pull/${ref.number}`));
    const keys = issueKeysFromPullRequest(pr);
    const keyLinked = keys.map((k) => k.toUpperCase()).includes(issue.identifier.toUpperCase());
    const linked = keyLinked || alreadyAttached;

    if (!linked && !flags['allow-unlinked']) {
      return {
        ok: false,
        reason: 'pr_key_not_linked',
        nextAction: `PR #${ref.number} 的标题/branch/body 中未发现 ${issue.identifier}，且 Linear 也没有该 PR 的 attachment。确认后用 --allow-unlinked 覆盖。`,
        details: { identifier: issue.identifier, pr: ref.number, keysFound: keys, alreadyAttached },
      };
    }

    // 3. In Review (idempotent — the GitHub integration may already have done it).
    const setRes = await L.setIssueState(client, issue, IN_REVIEW_STATE);
    if (!setRes.ok) return setRes.error;

    // 4. Ensure the PR link exists in Linear (idempotent).
    let attachment = null;
    if (!alreadyAttached) {
      const created = await L.createAttachment(client, issue.id, { url: pr.url || ref.url, title: pr.title || `PR #${ref.number}` });
      if (!created.ok) return created.error;
      attachment = created.data.attachmentCreate.attachment;
    }

    // 5. Chinese evidence summary — only when supplied, and only once per PR
    //    (idempotency is keyed on a machine marker, not on parsed prose).
    const marker = handoffMarker(ref.owner, ref.repo, ref.number);
    let comment = null;
    const summary = textFlag(flags.summary) || (flags['summary-file'] ? fs.readFileSync(flags['summary-file'], 'utf8') : '');
    if (String(summary).trim()) {
      const existing = await L.listComments(client, issue.id, 100);
      if (!existing.ok) return existing.error;
      const alreadyCommented = (existing.data?.issue?.comments?.nodes ?? []).some((c) => String(c?.body || '').includes(marker));
      if (!alreadyCommented) {
        const body = `${String(summary).trim()}\n\n${marker}`;
        const created = await L.createComment(client, issue.id, body);
        if (!created.ok) return created.error;
        comment = created.data.commentCreate.comment;
      } else {
        comment = { skipped: 'handoff_marker_present', url: null };
      }
    }

    return {
      ok: true,
      issue: L.normalizeIssue(setRes.issue),
      pullRequest: {
        number: pr.number,
        url: pr.url,
        title: pr.title,
        state: pr.state,
        merged: pr.merged,
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
      },
      link: { keyLinked, alreadyAttached, source: alreadyAttached ? 'linear_attachment' : keyLinked ? 'pr_text' : 'forced' },
      actions: {
        stateChanged: setRes.changed,
        alreadyInReview: !setRes.changed,
        attachmentAdded: Boolean(attachment),
        commentAdded: Boolean(comment && !comment.skipped),
        merged: false,
      },
      idempotent: { previousState: setRes.previousState, attachmentExisted: alreadyAttached, commentSkipped: Boolean(comment?.skipped) },
      attachment,
      comment,
    };
  }

  // ── reconcile ────────────────────────────────────────────────────────────

  async function cmdReconcile(flags) {
    const apply = Boolean(flags.apply);
    const limit = num(flags.limit, 25);
    const repoFlag = textFlag(flags.repo) || undefined;
    const stateNames = flags.state
      ? String(flags.state).split(',').map((s) => s.trim()).filter(Boolean)
      : ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled'];

    let issues;
    if (flags.issue) {
      const found = await L.findIssue(client, flags.issue);
      if (!found.ok) return found.error;
      const attach = await L.fetchAttachments(client, found.issue.id);
      if (!attach.ok) return attach.error;
      issues = [{
        id: found.issue.id,
        identifier: found.issue.identifier,
        title: found.issue.title,
        state: found.issue.state,
        attachments: { nodes: attach.data?.issue?.attachments?.nodes ?? [] },
      }];
    } else {
      const res = await L.listIssues(client, { stateNames, limit, includeGraph: false });
      if (!res.ok) return res.error;
      issues = res.issues;
    }

    const prs = await github.listPullRequests({ repo: repoFlag, limit: num(flags['pr-limit'], 200) });
    if (!prs.ok) return prs.error;

    const pairings = associateIssuesWithPullRequests(issues, prs.pullRequests);
    const plan = buildReconciliationPlan(pairings);

    const applied = [];
    if (apply) {
      for (const action of plan.deterministicActions) {
        if (action.action?.type !== 'set_state') continue;
        const target = issues.find((i) => i.identifier === action.issue);
        if (!target) continue;
        const setRes = await L.setIssueState(client, target, action.action.state);
        applied.push({
          issue: action.issue,
          code: action.code,
          state: action.action.state,
          ok: setRes.ok === true,
          changed: setRes.changed ?? false,
          error: setRes.ok ? null : setRes.error,
        });
      }
    }

    return {
      ok: true,
      dryRun: !apply,
      mode: apply ? 'apply' : 'dry-run',
      scanned: { issues: issues.length, pullRequests: prs.pullRequests.length, states: flags.issue ? null : stateNames },
      deterministicActions: plan.deterministicActions,
      warnings: plan.warnings,
      manualReview: plan.manualReview,
      applied,
      summary: { ...summarize(plan), applied: applied.length },
      note: apply
        ? 'Only deterministicActions were applied. warnings/manualReview require human decision.'
        : 'Dry run by default. Re-run with --apply to execute deterministicActions only.',
    };
  }

  // ── audit ────────────────────────────────────────────────────────────────

  async function cmdAudit(flags) {
    const limit = num(flags.limit, 25);
    const repoFlag = textFlag(flags.repo) || undefined;
    const stateNames = flags.state
      ? String(flags.state).split(',').map((s) => s.trim()).filter(Boolean)
      : ['Backlog', 'Todo', 'In Progress', 'In Review'];

    const res = await L.listIssues(client, { stateNames, limit });
    if (!res.ok) return res.error;
    const projects = await L.listProjects(client, { limit: num(flags['project-limit'], 50) });
    if (!projects.ok) return projects.error;
    const prs = await github.listPullRequests({ repo: repoFlag, limit: num(flags['pr-limit'], 200) });
    if (!prs.ok) return prs.error;

    const report = auditWorkspace({
      issues: res.issues,
      projects: projects.projects,
      pullRequests: prs.pullRequests,
    });

    return {
      ok: true,
      readOnly: true,
      scanned: { issues: res.issues.length, projects: projects.projects.length, pullRequests: prs.pullRequests.length },
      findings: report.findings,
      summary: report.summary,
      note: 'Audit only reports. No Linear state was modified.',
    };
  }

  // ── help ─────────────────────────────────────────────────────────────────

  function help() {
    return {
      ok: true,
      commands: {
        context: 'linear.cjs context PRI-123 [--comments 10] [--children 20] [--relations 20] [--description-chars 2000]',
        start: 'linear.cjs start PRI-123 [--comment-file plan.md]',
        handoff: 'linear.cjs handoff PRI-123 --pr <url> [--summary-file summary.md] [--repo owner/name] [--allow-unlinked]',
        reconcile: 'linear.cjs reconcile [--issue PRI-123] [--limit 25] [--apply]',
        audit: 'linear.cjs audit [--limit 25]',
        search: 'linear.cjs search "diagnostician" --limit 20',
        issue: 'linear.cjs issue PRI-123 [--comments]',
        list: 'linear.cjs list --state Todo --limit 20 [--label x] [--assignee me]',
        create: 'linear.cjs create --title "..." --description-file body.md --priority 2 [--label a,b] [--assignee me] [--parent PRI-1]',
        comment: 'linear.cjs comment PRI-123 --body-file comment.md',
        status: 'linear.cjs status PRI-123 "In Review"',
        states: 'linear.cjs states',
        labels: 'linear.cjs labels PRI-123   (labels on an issue)',
        'labels-all': 'linear.cjs labels-all   (all workspace labels)',
        label: 'linear.cjs label PRI-123 add|remove <label-name>',
        priority: 'linear.cjs priority PRI-123 <0-4>',
        assign: 'linear.cjs assign PRI-123 <email|me|uuid>   (or: assign PRI-123 --remove)',
        subissue: 'linear.cjs subissue <parent> <child>',
        comments: 'linear.cjs comments PRI-123',
      },
      lifecycle: [
        'linear context PRI-xxx  -> read everything before coding',
        'linear start PRI-xxx    -> guarded In Progress (fail-closed)',
        '... implement + verify ...',
        'create PR (never auto-merged)',
        'linear handoff PRI-xxx --pr <url>',
        'linear reconcile        -> dry-run by default',
        'linear audit            -> read-only hygiene report',
      ],
      env: [
        'LINEAR_API_KEY required',
        `LINEAR_TEAM_ID optional (default ${DEFAULT_TEAM_ID})`,
        'LINEAR_TIMEOUT_MS optional (default 30000)',
        'PD_GITHUB_REPO optional (default: parsed from git origin remote)',
      ],
    };
  }

  async function dispatch(command, flags, positional) {
    if (command === 'context') return cmdContext(flags, positional);
    if (command === 'start') return cmdStart(flags, positional);
    if (command === 'handoff') return cmdHandoff(flags, positional);
    if (command === 'reconcile') return cmdReconcile(flags);
    if (command === 'audit') return cmdAudit(flags);
    if (command === 'search') return cmdSearch(flags, positional);
    if (command === 'issue') return cmdIssue(flags, positional);
    if (command === 'list') return cmdList(flags);
    if (command === 'create') return cmdCreate(flags);
    if (command === 'comment') return cmdComment(flags, positional);
    if (command === 'status') return cmdStatus(flags, positional);
    if (command === 'states') return cmdStates();
    if (command === 'label') return cmdLabel(flags, positional);
    if (command === 'priority') return cmdPriority(flags, positional);
    if (command === 'assign') return cmdAssign(flags, positional);
    if (command === 'subissue') return cmdSubissue(flags, positional);
    if (command === 'comments') return cmdComments(flags, positional);
    if (command === 'labels') {
      const id = firstPositional(flags, positional);
      return id ? cmdLabelsOnIssue(flags, positional) : cmdLabelsAll();
    }
    if (command === 'labels-all') return cmdLabelsAll();
    if (command === 'help' || command === '--help' || command === '-h') return help();
    return { reason: 'unknown_command', nextAction: 'Run: linear.cjs help', details: { command } };
  }

  /**
   * @returns {Promise<{exitCode:number, output:object}>}
   */
  async function run(argv) {
    const { positional, flags } = parseArgs(argv);
    const command = positional.shift() || 'help';
    try {
      const result = await dispatch(command, flags, positional);
      // Commands signal failure by returning an error object. Normalise here so
      // `ok:false` is always present on the wire regardless of which shorthand
      // a command used.
      if (result && (result.ok === false || typeof result.reason === 'string')) {
        const { ok: _ignored, ...rest } = result;
        return { exitCode: 1, output: { ok: false, ...rest } };
      }
      return { exitCode: 0, output: { ok: true, ...result } };
    } catch (error) {
      return {
        exitCode: 1,
        output: {
          ok: false,
          reason: 'linear_cli_unhandled_error',
          nextAction: 'Inspect the error, then retry. If it repeats, check Linear API status and token permissions.',
          details: { message: error instanceof Error ? error.message : String(error) },
        },
      };
    }
  }

  return { run, dispatch, client, github };
}

function readBody(flags) {
  if (typeof flags.body === 'string') return flags.body;
  if (typeof flags['body-file'] === 'string') return fs.readFileSync(flags['body-file'], 'utf8');
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8');
  return '';
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  const cli = createCli();
  const { exitCode, output } = await cli.run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (exitCode !== 0) process.exitCode = exitCode;
}

if (require.main === module) {
  main();
}

module.exports = { createCli, parseArgs, main, handoffMarker, DEFAULT_TEAM_ID };
