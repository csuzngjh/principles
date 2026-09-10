'use strict';

/**
 * Linear × GitHub reconciliation rules — PURE.
 *
 * No network, no mutation, no persistence. The command layer feeds it
 * (issues, pullRequests) and decides whether to `--apply`.
 *
 * Safety rules encoded here (PRI-722):
 *   - merged PR + issue not Done        -> deterministic (only when the link
 *                                          comes from a Linear attachment)
 *   - open PR + issue still Todo        -> warning, never auto-start
 *   - issue Done + PR still open        -> manual review (high risk)
 *   - PR closed unmerged                -> manual review, never auto-cancel
 *   - several PRs for one issue         -> manual review, never guess
 */

const TERMINAL = new Set(['completed', 'canceled']);
const UNSTARTED = new Set(['triage', 'backlog', 'unstarted']);

function isTerminalIssue(issue) {
  return TERMINAL.has(issue?.state?.type);
}

/**
 * Pair issues with pull requests.
 *
 * `linear_attachment` links are authoritative (written by the GitHub
 * integration with a structured source). PRs matched only by PRI-key text in
 * title/body/branch are `pr_branch_or_title` and can never justify a
 * deterministic write.
 */
function associateIssuesWithPullRequests(issues, pullRequests) {
  const byNumber = new Map();
  for (const pr of pullRequests || []) {
    if (Number.isFinite(pr.number)) byNumber.set(Number(pr.number), pr);
  }

  const result = [];
  for (const issue of issues || []) {
    const identifier = issue.identifier;
    const links = [];

    for (const a of issue.attachments?.nodes ?? []) {
      const url = String(a?.url || '');
      const m = url.match(/\/pull\/(\d+)/);
      if (!m) continue;
      const number = Number(m[1]);
      const pr = byNumber.get(number);
      links.push({
        number,
        url,
        source: 'linear_attachment',
        pullRequest: pr ?? null,
        missing: !pr,
      });
    }

    // Heuristic links: a PR that mentions this issue key but is NOT attached.
    const attachedNumbers = new Set(links.map((l) => l.number));
    for (const pr of pullRequests || []) {
      if (attachedNumbers.has(pr.number)) continue;
      const keys = issueKeysFromPr(pr, identifier);
      if (!keys) continue;
      links.push({ number: pr.number, url: pr.url, source: 'pr_branch_or_title', pullRequest: pr, missing: false });
    }

    result.push({ issue, identifier, links });
  }
  return result;
}

/**
 * Heuristic match: branch name or PR title only.
 *
 * PR bodies are deliberately excluded — retrospective/playbook PRs mention
 * many unrelated issue keys in prose, which produced false high-risk findings
 * during the PRI-722 smoke test (PR #1590's body cites PRI-718).
 */
function issueKeysFromPr(pr, identifier) {
  const text = [pr.headRefName, pr.title].filter(Boolean).join(' ');
  return new RegExp(`\\b${identifier}\\b`, 'i').test(String(text));
}

function entry(code, severity, issue, extra) {
  return {
    code,
    severity,
    issue: issue.identifier,
    title: issue.title ?? null,
    issueState: issue.state?.name ?? null,
    issueStateType: issue.state?.type ?? null,
    message: extra.message,
    ...extra,
  };
}

/**
 * Build the reconciliation plan.
 *
 * @returns {{deterministicActions: object[], warnings: object[], manualReview: object[]}}
 */
function buildReconciliationPlan(pairings) {
  const deterministicActions = [];
  const warnings = [];
  const manualReview = [];

  for (const { issue, links } of pairings) {
    const terminal = isTerminalIssue(issue);

    // An issue can be Done while a PR is still open — high risk, never auto-fix.
    // Only authoritative (Linear attachment) links may raise a `high` finding;
    // a branch/title mention is far too weak to claim a contradiction.
    if (terminal) {
      const attached = links.filter((l) => l.source === 'linear_attachment' && l.pullRequest);
      const open = attached.filter((l) => !l.pullRequest.merged && l.pullRequest.state === 'OPEN');
      if (open.length > 0) {
        manualReview.push(entry('issue_done_pr_still_open', 'high', issue, {
          pullRequests: open.map(describeLink),
          message: `工单已处于 ${issue.state?.name}，但关联 PR 仍未合并，属于高风险不一致，需人工确认。`,
        }));
      }
      const closedUnmerged = attached.filter((l) => l.pullRequest.state === 'CLOSED' && !l.pullRequest.merged);
      if (closedUnmerged.length > 0) {
        manualReview.push(entry('issue_done_pr_closed_unmerged', 'medium', issue, {
          pullRequests: closedUnmerged.map(describeLink),
          message: `工单已 ${issue.state?.name}，但关联 PR 被关闭且未合并，需人工确认工单是否应重开。`,
        }));
      }
      continue;
    }

    const attached = links.filter((l) => l.source === 'linear_attachment');
    const heuristic = links.filter((l) => l.source !== 'linear_attachment');

    if (attached.length > 1) {
      manualReview.push(entry('multiple_prs_for_issue', 'medium', issue, {
        pullRequests: attached.map(describeLink),
        message: `同一工单存在 ${attached.length} 个 Linear attachment 关联 PR，保守处理，不做自动状态写入。`,
      }));
      continue;
    }

    const link = attached[0] ?? null;

    if (!link) {
      if (heuristic.length > 1) {
        manualReview.push(entry('multiple_candidate_prs_for_issue', 'low', issue, {
          pullRequests: heuristic.map(describeLink),
          message: `同一工单有 ${heuristic.length} 个仅靠分支名/标题匹配的候选 PR，关联无法确认，需人工确认。`,
        }));
        continue;
      }
      if (heuristic.length === 1) {
        // Single unverified candidate — evaluated below, but can never justify
        // a deterministic write (enforced by the link.source check further on).
      } else if (/in review/i.test(String(issue.state?.name || ''))) {
        warnings.push(entry('in_review_without_pr', 'medium', issue, {
          message: `工单处于 ${issue.state?.name} 但没有任何关联 PR，可能漏做 handoff。`,
        }));
        continue;
      } else {
        continue;
      }
    }

    const effectiveLink = link ?? heuristic[0];

    if (effectiveLink.missing || !effectiveLink.pullRequest) {
      manualReview.push(entry('pr_not_found_in_github', 'medium', issue, {
        pullRequests: [describeLink(effectiveLink)],
        message: `Linear 记录了 PR 链接，但 GitHub 列表里找不到该 PR，需人工核对。`,
      }));
      continue;
    }

    const pr = effectiveLink.pullRequest;

    if (pr.merged) {
      if (effectiveLink.source === 'linear_attachment') {
        deterministicActions.push(entry('pr_merged_issue_not_done', 'low', issue, {
          pullRequests: [describeLink(effectiveLink)],
          action: { type: 'set_state', state: 'Done' },
          message: `PR #${pr.number} 已合并，工单应进入 Done。`,
        }));
      } else {
        manualReview.push(entry('merged_pr_link_unverified', 'medium', issue, {
          pullRequests: [describeLink(effectiveLink)],
          message: `PR #${pr.number} 已合并，但关联仅来自 PR 分支名/标题，未经 Linear attachment 确认，不自动写入。`,
        }));
      }
      continue;
    }

    if (pr.state === 'CLOSED') {
      manualReview.push(entry('pr_closed_unmerged', 'medium', issue, {
        pullRequests: [describeLink(effectiveLink)],
        message: `PR #${pr.number} 被关闭且未合并；不自动把工单置为 Canceled。`,
      }));
      continue;
    }

    // OPEN
    if (UNSTARTED.has(issue.state?.type)) {
      warnings.push(entry('pr_open_issue_not_started', 'low', issue, {
        pullRequests: [describeLink(effectiveLink)],
        message: `PR #${pr.number} 已开启，但工单仍为 ${issue.state?.name}；不自动改为 In Progress。`,
      }));
    }
  }

  return { deterministicActions, warnings, manualReview };
}

function describeLink(link) {
  return {
    number: link.number,
    url: link.url,
    source: link.source,
    state: link.pullRequest?.state ?? null,
    merged: Boolean(link.pullRequest?.merged),
    found: !link.missing,
  };
}

function summarize(plan) {
  return {
    deterministicActions: plan.deterministicActions.length,
    warnings: plan.warnings.length,
    manualReview: plan.manualReview.length,
  };
}

module.exports = {
  associateIssuesWithPullRequests,
  buildReconciliationPlan,
  summarize,
  isTerminalIssue,
  UNSTARTED,
  TERMINAL,
};
