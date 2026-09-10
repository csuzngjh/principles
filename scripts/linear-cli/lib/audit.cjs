'use strict';

/**
 * Linear workspace hygiene audit — PURE and report-only.
 *
 * Nothing here mutates Linear. Every finding carries a stable machine
 * `code` plus human-readable Chinese `message`, so the output can be triaged
 * without re-reading prose.
 */

const TERMINAL = new Set(['completed', 'canceled']);
const ACTIVE_LIKE = new Set(['triage', 'backlog', 'unstarted', 'started']);

const ACTING_AS_PROJECT_CHILD_THRESHOLD = 5;
const MIN_GOAL_LENGTH = 20;
const PRIORITY_LABEL_RE = /^priority\s*[:：]/i;
const BLOCKED_LABEL_RE = /^blocked$/i;

function isTerminal(issue) {
  return TERMINAL.has(issue?.state?.type);
}

function isActive(issue) {
  return !isTerminal(issue);
}

function splitRelationships(issue) {
  const blockedBy = [];
  const blocks = [];
  for (const r of issue.relations?.nodes ?? []) {
    if (r?.type === 'blocks' && r.relatedIssue) blocks.push(r.relatedIssue);
  }
  for (const r of issue.inverseRelations?.nodes ?? []) {
    if (r?.type === 'blocks' && r.issue) blockedBy.push(r.issue);
  }
  return { blocks, blockedBy };
}

function unresolvedBlockers(issue) {
  return splitRelationships(issue).blockedBy.filter((b) => !TERMINAL.has(b?.state?.type));
}

// ── Chinese-convention heuristic ───────────────────────────────────────────
//
// Governance text added by AI should be Chinese. Code identifiers and product
// proper nouns (RuleCode, runtimeProfile, Prompt, GraphQL, PR, API, CLI, MCP…)
// are NOT violations. So the check keys on English *function words*, not on
// the mere presence of ASCII.

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'should', 'would', 'could',
  'will', 'can', 'are', 'was', 'were', 'have', 'has', 'not', 'but', 'you', 'your',
  'we', 'our', 'they', 'their', 'then', 'when', 'which', 'what', 'how', 'why',
  'please', 'note', 'because', 'however', 'therefore', 'also', 'into', 'about',
  'there', 'been', 'does', 'did', 'must', 'need', 'needs', 'make', 'made', 'use',
  'used', 'using', 'after', 'before', 'during', 'while', 'where', 'these', 'those',
]);

const CJK_RE = /[㐀-䶿一-鿿぀-ヿ]/g;

function stripTechnicalTokens(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z0-9_./-]*[A-Z][A-Za-z0-9_./-]*[A-Za-z0-9]/g, ' ') // CamelCase / snake identifiers
    .replace(/[A-Za-z0-9_]+_[A-Za-z0-9_]+/g, ' ')
    .replace(/[A-Za-z0-9_./-]*\.[A-Za-z]{1,5}\b/g, ' '); // file names / paths
}

/** @returns {{violation: boolean, stopwords: number, asciiWords: number, cjk: number}} */
function evaluateLanguage(text) {
  const raw = String(text || '');
  if (raw.length < 40) return { violation: false, stopwords: 0, asciiWords: 0, cjk: 0 };
  const cjk = (raw.match(CJK_RE) || []).length;
  if (cjk > 0) return { violation: false, stopwords: 0, asciiWords: 0, cjk };
  const cleaned = stripTechnicalTokens(raw);
  const words = cleaned.toLowerCase().match(/[a-z]{2,}/g) || [];
  const stopwords = words.filter((w) => STOPWORDS.has(w)).length;
  return {
    violation: words.length >= 20 && stopwords >= 3,
    stopwords,
    asciiWords: words.length,
    cjk: 0,
  };
}

// ── Checks ─────────────────────────────────────────────────────────────────

function finding(code, severity, subject, message, evidence) {
  return { code, severity, subject, message, ...(evidence ? { evidence } : {}) };
}

/**
 * @param {object} input
 * @param {object[]} input.issues       Linear issues (see listIssues in lib/linear.cjs)
 * @param {object[]} input.projects     Linear projects
 * @param {object[]} input.pullRequests normalized GitHub PRs
 */
function auditWorkspace({ issues = [], projects = [], pullRequests = [] } = {}) {
  const findings = [];
  const prByNumber = new Map();
  for (const pr of pullRequests) if (Number.isFinite(pr.number)) prByNumber.set(pr.number, pr);

  for (const issue of issues) {
    const subject = { type: 'issue', identifier: issue.identifier, title: issue.title ?? null };
    const labels = (issue.labels?.nodes ?? []).map((l) => l.name);
    const children = issue.children?.nodes ?? [];
    const attachmentPrs = (issue.attachments?.nodes ?? [])
      .map((a) => {
        const m = String(a?.url || '').match(/\/pull\/(\d+)/);
        return m ? { number: Number(m[1]), url: a.url } : null;
      })
      .filter(Boolean);

    // 1. Active issue without a Project (a sub-issue inherits its parent's).
    if (isActive(issue) && !issue.project && !issue.parent) {
      findings.push(finding('active_issue_without_project', 'medium', subject,
        `活跃工单（${issue.state?.name ?? '未知状态'}）没有归属 Project，也没有父工单可继承归属。`,
        { state: issue.state?.name ?? null }));
    }

    // 2. A large tracking issue quietly acting as a Project.
    if (children.length >= ACTING_AS_PROJECT_CHILD_THRESHOLD) {
      findings.push(finding('issue_acting_as_project', 'medium', subject,
        `该工单有 ${children.length} 个子工单，实际在承担 Project 的职责，建议收敛为 Project 或补充完成条件。`,
        { children: children.length }));
    }

    // 3. In Review without any PR.
    if (isActive(issue) && /in review/i.test(String(issue.state?.name || '')) && attachmentPrs.length === 0) {
      findings.push(finding('in_review_without_pr', 'medium', subject,
        `工单处于 ${issue.state?.name} 但没有任何 PR 关联，可能漏做交付交接。`));
    }

    // 4. Merged PR but the issue is not Done.
    for (const link of attachmentPrs) {
      const pr = prByNumber.get(link.number);
      if (pr?.merged && !isTerminal(issue)) {
        findings.push(finding('merged_pr_issue_not_done', 'high', subject,
          `PR #${pr.number} 已合并，但工单仍为 ${issue.state?.name ?? '未知状态'}。`,
          { pr: { number: pr.number, url: pr.url, mergedAt: pr.mergedAt } }));
      }
    }

    // 5. Active issue carrying unresolved blockers.
    if (isActive(issue)) {
      const blockers = unresolvedBlockers(issue);
      if (blockers.length > 0 && String(issue.state?.type) === 'started') {
        findings.push(finding('in_progress_with_unresolved_blocker', 'high', subject,
          `工单已进入 ${issue.state?.name}，但仍存在未解决的阻塞工单，状态与阻塞关系不一致。`,
          { blockers: blockers.map((b) => ({ identifier: b.identifier, state: b.state?.name ?? null })) }));
      }
    }

    // 6. Native priority duplicated by a `priority:*` label.
    if (labels.some((l) => PRIORITY_LABEL_RE.test(String(l))) && Number(issue.priority) > 0) {
      findings.push(finding('priority_label_duplication', 'low', subject,
        `同时存在原生 priority（${issue.priorityLabel ?? issue.priority}）与 priority:* 标签，两处事实源易漂移。`,
        { priority: issue.priority, labels: labels.filter((l) => PRIORITY_LABEL_RE.test(String(l))) }));
    }

    // 7. `blocked` label used instead of a real blocked-by relation.
    if (labels.some((l) => BLOCKED_LABEL_RE.test(String(l))) && unresolvedBlockers(issue).length === 0) {
      findings.push(finding('blocked_label_without_relation', 'medium', subject,
        `工单带 blocked 标签，但没有 blocks/blockedBy 关系，标签无法被机器可靠消费。`));
    }

    // 8. Completed/canceled issue still acting as the current entry point.
    if (isTerminal(issue)) {
      const activeChildren = children.filter((c) => !TERMINAL.has(c?.state?.type));
      if (activeChildren.length > 0) {
        findings.push(finding('completed_issue_still_entry_point', 'medium', subject,
          `工单已 ${issue.state?.name}，但仍有 ${activeChildren.length} 个未完成的子工单挂在下面，容易被当成当前执行入口。`,
          { activeChildren: activeChildren.map((c) => c.identifier) }));
      }
    }

    // 9. Parent/child project mismatch.
    const parentProject = issue.parent?.project ?? null;
    if (issue.project && parentProject && issue.project.id !== parentProject.id) {
      findings.push(finding('parent_child_project_mismatch', 'medium', subject,
        `子工单 Project（${issue.project.name}）与父工单 Project（${parentProject.name}）不一致。`,
        { childProject: issue.project.name, parentProject: parentProject.name, parent: issue.parent.identifier }));
    }

    // 10. AI-added governance text violating the Chinese-first convention.
    const langTargets = [
      { kind: 'description', text: issue.description },
      ...(issue.comments?.nodes ?? []).slice(-5).map((c) => ({ kind: 'comment', text: c.body, id: c.id })),
    ];
    for (const target of langTargets) {
      const verdict = evaluateLanguage(target.text);
      if (verdict.violation) {
        findings.push(finding('non_chinese_governance_text', 'low', subject,
          `${target.kind === 'description' ? '工单描述' : '评论'}疑似为长英文正文，违反治理信息以中文为主的约定（启发式判断，需人工确认）。`,
          { target: target.kind, id: target.id ?? null, asciiWords: verdict.asciiWords, stopwords: verdict.stopwords }));
      }
    }
  }

  // Project-level checks. Active-issue counts come from the issue scan rather
  // than a nested `projects { issues { ... } }` query (see listProjects).
  const activeByProject = new Map();
  for (const issue of issues) {
    const pid = issue.project?.id;
    if (!pid || TERMINAL.has(issue?.state?.type)) continue;
    activeByProject.set(pid, (activeByProject.get(pid) || 0) + 1);
  }

  for (const project of projects) {
    const activeCount = activeByProject.get(project.id) || 0;
    const goal = String(project.description || '').trim();
    const subject = { type: 'project', id: project.id, name: project.name };
    if (activeCount > 0 && goal.length < MIN_GOAL_LENGTH) {
      findings.push(finding('project_without_goal', 'medium', subject,
        `Project 仍有 ${activeCount} 个活跃工单，但没有目标/完成条件描述（description 为空或过短）。`,
        { status: project.status?.name ?? null, activeIssues: activeCount, descriptionLength: goal.length, targetDate: project.targetDate ?? null }));
    }
  }

  const byCode = {};
  const bySeverity = {};
  for (const f of findings) {
    byCode[f.code] = (byCode[f.code] || 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }

  return {
    findings,
    summary: { total: findings.length, byCode, bySeverity },
  };
}

module.exports = {
  auditWorkspace,
  evaluateLanguage,
  stripTechnicalTokens,
  unresolvedBlockers,
  splitRelationships,
  isTerminal,
  isActive,
  ACTIVE_LIKE,
};
