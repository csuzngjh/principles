/**
 * `pd consent sweep-revoked` — PRI-1283 R3 operator entry for the source
 * revocation sweep.
 *
 * Contract:
 *   - default (no --apply): DRY RUN — reports what WOULD be purged, mutates
 *     nothing (cli-4 dry-run/confirm semantics);
 *   - --apply: executes the idempotent purge (the same sweep the setup
 *     decline path runs immediately);
 *   - --json: stdout is EXACTLY one machine-readable sweep report (cli-1);
 *   - exit 0 on completed/skipped, 1 on failed/partial-with-failures —
 *     a purge that could not finish must not read as success (cli-2/cli-5).
 */

import * as path from 'path';
import { runSourceRevocationSweep, type SourceRevocationSweepReport } from '@principles/host-runtime';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

export interface ConsentSweepRevokedOptions {
  workspace?: string;
  apply?: boolean;
  json?: boolean;
}

function printHuman(report: SourceRevocationSweepReport): void {
  console.log(`Workspace: ${report.workspaceDir}`);
  console.log(`Ran at:    ${report.ranAt}`);
  console.log(`Mode:      ${report.apply ? 'APPLY (purge executed)' : 'DRY RUN (no changes made)'}`);
  console.log(`Outcome:   ${report.outcome}${report.reason !== null ? ` (${report.reason})` : ''}`);
  if (report.reason !== null && 'nextAction' in report && report.nextAction !== undefined) {
    console.log(`Next:      ${report.nextAction}`);
  }
  for (const host of report.hosts) {
    console.log('─'.repeat(96));
    console.log(`  host=${host.hostKind} consent=${host.consentDecision} decidedAt=${host.decidedAt ?? '?'} swept=${host.swept ? 'yes' : 'dry-run'}`);
    const p = host.purged;
    console.log(`    governance_observations text purged: ${p.governanceObservations}`);
    console.log(`    admission payloads redacted:          ${p.admissionPayloads}`);
    console.log(`    pain_events text/reason purged:       ${p.painEventTexts}`);
    console.log(`    tasks evidence-cleaned:               ${p.tasks} (${p.taskEvidenceEntries} entries, ${p.taskCorrectionEvidence} correction blocks)`);
    console.log(`    pain_diagnoses evidence-cleaned:      ${p.painDiagnoses} (${p.painDiagnosesEvidenceEntries} entries)`);
    console.log(`    diagnostician artifacts cleaned:      ${p.artifacts} (${p.artifactEvidenceEntries} entries)`);
    for (const failure of host.failures) {
      console.error(`    WARN: ${failure}`);
    }
  }
  if ('checkedOnly' in report && report.checkedOnly !== undefined) {
    console.log('─'.repeat(96));
    console.log('  Checked (no excerpt fields persisted — not rewritten):');
    for (const location of report.checkedOnly) {
      console.log(`    - ${location}`);
    }
  }
}

export async function handleConsentSweepRevoked(opts: ConsentSweepRevokedOptions): Promise<void> {
  const json = opts.json === true;

  let workspaceDir: string;
  try {
    workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      console.log(JSON.stringify({ status: 'failed', reason: 'workspace_unresolved', message, nextAction: 'Pass --workspace <path>, set PD_WORKSPACE_DIR, or add workspace.default to .pd/config.yaml.' }));
    } else {
      console.error(`Error: ${message}`);
      console.error('Next: pass --workspace <path>.');
    }
    process.exit(1);
    return; // guard: test stubs of process.exit continue execution
  }

  const report = await runSourceRevocationSweep({ workspaceDir, apply: opts.apply === true });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  if (report.outcome === 'failed' || report.outcome === 'partial') {
    process.exit(1);
  }
}
