export type TriageCategoryName =
  | 'schema_mismatch'
  | 'sqlite_io_error'
  | 'broken_pd_shim'
  | 'candidate_audit_failed'
  | 'gfi_unavailable_or_stale'
  | 'pruning_orphans_present'
  | 'internalization_queue_blocked'
  | 'internalization_chain_broken'
  | 'artifact_missing'
  | 'runner_unsupported'
  | 'lease_stuck'
  | 'unknown';

export interface TriageCategory {
  category: TriageCategoryName;
  severity: 'critical' | 'high' | 'medium' | 'low';
  symptom: string;
  likelyRootCause: string;
  commandsToVerify: string[];
  safeFirstRepair: string;
  escalationRule: string;
  linearIssueTemplate: string;
}

export interface TriagePlan {
  findings: TriageCategory[];
  sortedBySeverity: TriageCategory[];
  summary: string;
}

interface CanaryCheckInput {
  name: string;
  status: 'healthy' | 'degraded' | 'error';
  summary: string;
  details?: unknown;
  error?: string;
}

interface CanaryOutputInput {
  overallStatus: 'healthy' | 'degraded' | 'error';
  checks: CanaryCheckInput[];
  recommendedNextActions: string[];
  generatedAt: string;
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const CATEGORY_DEFINITIONS: Record<TriageCategoryName, Omit<TriageCategory, 'category'>> = {
  schema_mismatch: {
    severity: 'critical',
    symptom: 'Schema conformance check reports missing columns or tables',
    likelyRootCause: 'Workspace was created with an older version of PD runtime; schema migrations have not been applied.',
    commandsToVerify: [
      'pd runtime canary --workspace <path> --json',
      'Check schema_conformance check details for missingColumns and migrationsNeeded.',
    ],
    safeFirstRepair: 'Open the workspace with a writable SqliteConnection to trigger automatic schema migration. Do NOT manually ALTER TABLE.',
    escalationRule: 'If migration fails or data loss is suspected, escalate to PD maintainer with full canary JSON output.',
    linearIssueTemplate: '## Schema Mismatch\n\n**Severity:** Critical\n**Symptom:** Schema conformance degraded\n**Missing columns:** [list from canary]\n**Migrations needed:** [list from canary]\n\n### Steps to reproduce\n1. Run `pd runtime canary --workspace <path> --json`\n2. Observe schema_conformance check status\n\n### Expected\nAll tables and columns conform.\n\n### Actual\nMissing columns reported.',
  },
  sqlite_io_error: {
    severity: 'critical',
    symptom: 'Database read error or cannot open state.db',
    likelyRootCause: 'File system permissions, disk corruption, or concurrent write lock.',
    commandsToVerify: [
      'ls -la <workspace>/.pd/state.db',
      'sqlite3 <workspace>/.pd/state.db "PRAGMA integrity_check;"',
    ],
    safeFirstRepair: 'Verify file permissions and disk space. If corruption detected, restore from backup.',
    escalationRule: 'If integrity_check fails, do NOT attempt repair in-place. Escalate with full diagnostic bundle.',
    linearIssueTemplate: '## SQLite IO Error\n\n**Severity:** Critical\n**Symptom:** Cannot read state.db\n**Error:** [from canary]\n\n### Steps\n1. Check file exists and is readable\n2. Run integrity check\n3. If corrupted, restore from backup',
  },
  broken_pd_shim: {
    severity: 'high',
    symptom: 'PD CLI entrypoint not found or not executable',
    likelyRootCause: 'PD CLI not installed globally, or sync-plugin not configured in OpenClaw.',
    commandsToVerify: [
      'which pd || where pd',
      'pd --version',
      'Check OpenClaw sync-plugin configuration in workflows.yaml.',
    ],
    safeFirstRepair: 'Reinstall PD CLI globally. Verify sync-plugin entry in OpenClaw config points to correct binary.',
    escalationRule: 'If sync-plugin is correctly configured but CLI still not found, check PATH and Node.js installation.',
    linearIssueTemplate: '## Broken PD Shim\n\n**Severity:** High\n**Symptom:** PD CLI not accessible\n\n### Steps\n1. Verify pd is on PATH\n2. Check sync-plugin config\n3. Reinstall if needed',
  },
  candidate_audit_failed: {
    severity: 'high',
    symptom: 'Candidate/ledger consistency audit reports orphans or missing entries',
    likelyRootCause: 'Race condition during candidate consumption, or ledger write failure after candidate state change.',
    commandsToVerify: [
      'pd candidate audit --workspace <path> --json',
    ],
    safeFirstRepair: 'Review audit output. Orphan candidates can be cleaned via pruning. Missing ledger entries require manual investigation.',
    escalationRule: 'If orphan count is growing, investigate the candidate consumption path for write failures.',
    linearIssueTemplate: '## Candidate Audit Failed\n\n**Severity:** High\n**Symptom:** Candidate/ledger inconsistency\n**Orphan count:** [from audit]\n**Missing ledger:** [from audit]\n\n### Steps\n1. Run candidate audit\n2. Review orphan candidates\n3. Clean via pruning if safe',
  },
  gfi_unavailable_or_stale: {
    severity: 'medium',
    symptom: 'GFI snapshot shows all sessions stale or no active sessions',
    likelyRootCause: 'No recent PD activity, or session lifecycle not advancing.',
    commandsToVerify: [
      'pd runtime canary --workspace <path> --json',
      'Check gfi_snapshot check details.',
    ],
    safeFirstRepair: 'Trigger a new session by running a PD command. If sessions remain stale, investigate session persistence.',
    escalationRule: 'If GFI is consistently unavailable after activity, check session file write permissions.',
    linearIssueTemplate: '## GFI Unavailable or Stale\n\n**Severity:** Medium\n**Symptom:** No active GFI sessions\n**Stale count:** [from canary]\n\n### Steps\n1. Trigger new session\n2. Verify session files are written\n3. Check file permissions',
  },
  pruning_orphans_present: {
    severity: 'medium',
    symptom: 'Orphan derived candidates found in database',
    likelyRootCause: 'Candidates created from derived principles that were later pruned or whose source references were lost.',
    commandsToVerify: [
      'pd runtime pruning orphans --workspace <path> --dry-run',
    ],
    safeFirstRepair: 'Run `pd runtime pruning orphans --workspace <path> --dry-run` first to inspect. Only use --confirm after review.',
    escalationRule: 'If orphan count is large (>100), investigate the pruning pipeline for systematic failures.',
    linearIssueTemplate: '## Pruning Orphans Present\n\n**Severity:** Medium\n**Symptom:** Orphan derived candidates\n**Count:** [from canary]\n\n### Steps\n1. Run dry-run to inspect orphans\n2. Review each orphan\n3. Confirm cleanup if safe',
  },
  internalization_queue_blocked: {
    severity: 'high',
    symptom: 'Internalization queue has blocked or dependency-failed tasks',
    likelyRootCause: 'Upstream task failure causing downstream tasks to be permanently blocked.',
    commandsToVerify: [
      'pd runtime internalization queue --workspace <path> --json',
    ],
    safeFirstRepair: 'Review blocked task details. If root cause is fixed, consider resetting task status to pending.',
    escalationRule: 'If blocked count is growing, investigate the internalization orchestrator for systematic issues.',
    linearIssueTemplate: '## Internalization Queue Blocked\n\n**Severity:** High\n**Symptom:** Blocked tasks in queue\n**Blocked count:** [from canary]\n\n### Steps\n1. Inspect blocked tasks\n2. Fix root cause\n3. Reset task status if appropriate',
  },
  internalization_chain_broken: {
    severity: 'high',
    symptom: 'Broken links in internalization chain (missing dreamer tasks, missing artifacts, missing successors)',
    likelyRootCause: 'Orchestrator failed to create successor tasks, or artifact commit failed after task completion.',
    commandsToVerify: [
      'pd runtime internalization integrity --workspace <path> --json',
    ],
    safeFirstRepair: 'Review broken links. For missing successors, manually enqueue the next task. For missing artifacts, re-run the failed task.',
    escalationRule: 'If chain breaks are systematic, investigate the orchestrator successor proposal and artifact commit logic.',
    linearIssueTemplate: '## Internalization Chain Broken\n\n**Severity:** High\n**Symptom:** Broken links in chain\n**Broken links:** [from integrity check]\n\n### Steps\n1. Run integrity check\n2. Review each broken link\n3. Repair manually or re-run tasks',
  },
  artifact_missing: {
    severity: 'high',
    symptom: 'Task result_ref points to non-existent artifact',
    likelyRootCause: 'Artifact commit failed silently, or database corruption removed the artifact row.',
    commandsToVerify: [
      'pd runtime internalization integrity --workspace <path> --json',
    ],
    safeFirstRepair: 'Re-run the task that should have produced the artifact. If the task is idempotent, this is safe.',
    escalationRule: 'If artifacts are systematically missing, investigate the artifact commit path for write failures.',
    linearIssueTemplate: '## Artifact Missing\n\n**Severity:** High\n**Symptom:** Task result_ref points to missing artifact\n**Task ID:** [from integrity check]\n\n### Steps\n1. Identify affected tasks\n2. Re-run tasks if idempotent\n3. Investigate commit failures',
  },
  runner_unsupported: {
    severity: 'low',
    symptom: 'Task references a runner kind that is not available',
    likelyRootCause: 'Configuration change removed a runner, or task was created with a runner not in current config.',
    commandsToVerify: [
      'Check workflows.yaml for available runners.',
    ],
    safeFirstRepair: 'Update task metadata to use a supported runner, or add the runner to configuration.',
    escalationRule: 'If this affects multiple tasks, review the runner configuration migration path.',
    linearIssueTemplate: '## Runner Unsupported\n\n**Severity:** Low\n**Symptom:** Task references unavailable runner\n\n### Steps\n1. Check available runners\n2. Update task or config',
  },
  lease_stuck: {
    severity: 'medium',
    symptom: 'Task is leased but lease has expired',
    likelyRootCause: 'Worker crashed or lost connection without releasing the lease.',
    commandsToVerify: [
      'pd runtime internalization integrity --workspace <path> --json',
    ],
    safeFirstRepair: 'Run a recovery sweep to release expired leases, or manually reset the task status to pending.',
    escalationRule: 'If leases are frequently stuck, investigate worker health and lease timeout configuration.',
    linearIssueTemplate: '## Lease Stuck\n\n**Severity:** Medium\n**Symptom:** Expired lease on task\n**Task ID:** [from integrity check]\n\n### Steps\n1. Identify stuck tasks\n2. Release expired leases\n3. Review worker health',
  },
  unknown: {
    severity: 'low',
    symptom: 'Unrecognized issue detected by canary',
    likelyRootCause: 'New or unexpected condition not yet classified.',
    commandsToVerify: [
      'pd runtime canary --workspace <path> --json',
    ],
    safeFirstRepair: 'Review the full canary output and investigate manually.',
    escalationRule: 'If this recurs, create a new triage category and update classifyCanaryFindings.',
    linearIssueTemplate: '## Unknown Issue\n\n**Severity:** Low\n**Symptom:** Unclassified canary finding\n\n### Steps\n1. Review full canary output\n2. Investigate manually\n3. Create new triage category if recurring',
  },
};

export function classifyCanaryFindings(canaryOutput: CanaryOutputInput): TriagePlan {
  const findings: TriageCategory[] = [];

  for (const check of canaryOutput.checks) {
    if (check.status === 'healthy') continue;

    switch (check.name) {
      case 'schema_conformance':
        findings.push({ category: 'schema_mismatch', ...CATEGORY_DEFINITIONS.schema_mismatch });
        break;
      case 'candidate_audit':
        findings.push({ category: 'candidate_audit_failed', ...CATEGORY_DEFINITIONS.candidate_audit_failed });
        break;
      case 'gfi_snapshot':
        findings.push({ category: 'gfi_unavailable_or_stale', ...CATEGORY_DEFINITIONS.gfi_unavailable_or_stale });
        break;
      case 'pruning_orphans':
        findings.push({ category: 'pruning_orphans_present', ...CATEGORY_DEFINITIONS.pruning_orphans_present });
        break;
      case 'internalization_queue':
        findings.push({ category: 'internalization_queue_blocked', ...CATEGORY_DEFINITIONS.internalization_queue_blocked });
        break;
      case 'internalization_integrity':
        findings.push({ category: 'internalization_chain_broken', ...CATEGORY_DEFINITIONS.internalization_chain_broken });
        break;
      case 'runtime_health':
        if (check.error?.includes('Cannot open') || check.error?.includes('SQLITE_IO') || check.error?.includes('SQLITE_BUSY') || check.error?.includes('I/O')) {
          findings.push({ category: 'sqlite_io_error', ...CATEGORY_DEFINITIONS.sqlite_io_error });
        } else {
          findings.push({ category: 'unknown', ...CATEGORY_DEFINITIONS.unknown });
        }
        break;
      case 'pd_shim_info':
        findings.push({ category: 'broken_pd_shim', ...CATEGORY_DEFINITIONS.broken_pd_shim });
        break;
      default:
        findings.push({ category: 'unknown', ...CATEGORY_DEFINITIONS.unknown });
        break;
    }

    if (check.details && typeof check.details === 'object') {
      const details = check.details as Record<string, unknown>;
      if (Object.hasOwn(details, 'brokenLinks') && Array.isArray(details.brokenLinks) && (details.brokenLinks as unknown[]).length > 0) {
        const alreadyHasChain = findings.some(f => f.category === 'internalization_chain_broken');
        if (!alreadyHasChain) {
          findings.push({ category: 'internalization_chain_broken', ...CATEGORY_DEFINITIONS.internalization_chain_broken });
        }
      }
      if (Object.hasOwn(details, 'missingIndexes') && Array.isArray(details.missingIndexes) && (details.missingIndexes as unknown[]).length > 0) {
        const alreadyHasSchema = findings.some(f => f.category === 'schema_mismatch');
        if (!alreadyHasSchema) {
          findings.push({ category: 'schema_mismatch', ...CATEGORY_DEFINITIONS.schema_mismatch });
        }
      }
    }
  }

  const sortedBySeverity = [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99),
  );

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const highCount = findings.filter(f => f.severity === 'high').length;
  const mediumCount = findings.filter(f => f.severity === 'medium').length;
  const lowCount = findings.filter(f => f.severity === 'low').length;

  const summaryParts: string[] = [];
  if (criticalCount > 0) summaryParts.push(`${criticalCount} critical`);
  if (highCount > 0) summaryParts.push(`${highCount} high`);
  if (mediumCount > 0) summaryParts.push(`${mediumCount} medium`);
  if (lowCount > 0) summaryParts.push(`${lowCount} low`);

  const summary = findings.length === 0
    ? 'No issues found. All checks healthy.'
    : `Found ${findings.length} issue(s): ${summaryParts.join(', ')}.`;

  return { findings, sortedBySeverity, summary };
}
