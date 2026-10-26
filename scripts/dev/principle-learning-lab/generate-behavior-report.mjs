#!/usr/bin/env node
// SPEC-PD-EXAMINER-001 v0.4 — challenge study behavior report CLI
// (SPEC §9.4 six-dimension report, §10 behavior-report.json/.md, §12.4
// "报告可从轨迹重算", §8 REPORT_READY lifecycle).
//
// Intended for study directory COPIES (e.g. under .tmp/). Writing into the
// frozen in-repo challenge-studies/ area is refused at RUNTIME by the module
// (resolved-path check) — the pristine CEB-001 placeholder stays NOT_RUN.
//
//   # generate + commit (writes behavior-report.json + .md, then — only when
//   # READY — appends exactly one REPORT_READY event; refuses to overwrite a
//   # committed REPORT_READY report that no longer recomputes identically):
//   node generate-behavior-report.mjs --study-dir <copy> --now 2026-10-26T12:00:00Z
//
//   # STRICTLY read-only verification (no lock, no writes, no events).
//   # Without --now it reuses the stored report's generatedAt so an
//   # unmodified study verifies deterministically:
//   node generate-behavior-report.mjs --study-dir <copy> --verify
//
//   # machine-readable single-JSON stdout: add --json
//
// Zero network, zero credentials; `now` is always explicit (the module never
// reads an environment clock).

import path from 'node:path';

import {
  writeBehaviorReport,
  verifyBehaviorReport,
  FrozenStudyWriteRefusedError,
  ReportRevisionRequiredError,
} from './lib/challenge-behavior-report.mjs';
import { StudyLockError } from './lib/challenge-ledger.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0;
};
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) return undefined;
  return v;
};

const studyDir = value('study-dir');
const now = value('now');
const verify = flag('verify');
const json = flag('json');

function usage() {
  console.error('usage: node generate-behavior-report.mjs --study-dir <study-copy> (--now <ISO-8601> | --verify) [--json]');
}

if (!studyDir) {
  usage();
  process.exit(1);
}
if (!verify && now === undefined) {
  console.error('write mode requires --now <ISO-8601> (the report timestamp must be explicit and reproducible)');
  usage();
  process.exit(1);
}
if (now !== undefined && !Number.isFinite(Date.parse(now))) {
  console.error(`invalid --now (ISO-8601 required): ${now}`);
  process.exit(1);
}

function out(obj) {
  if (json) console.log(JSON.stringify(obj));
  else console.log(JSON.stringify(obj, null, 2));
}

try {
  if (verify) {
    const result = verifyBehaviorReport(path.resolve(studyDir), { now });
    out({ mode: 'verify', ok: result.ok, reason: result.reason ?? null, status: result.status ?? null, checks: result.checks });
    process.exit(result.ok ? 0 : 1);
  }
  const result = writeBehaviorReport(path.resolve(studyDir), { now, owner: 'generate-behavior-report-cli' });
  out({
    mode: 'write',
    written: result.written,
    alreadyReady: result.alreadyReady === true,
    status: result.status,
    reportReadyEventAppended: result.eventAppended === true,
    assignedDenominator: result.report.scope.preregistered.assignedDenominator,
    executedUnits: result.report.scope.executedUnits,
    settlementCounts: result.report.scope.settlementCounts,
    criticalFindings: result.report.integrity.criticalCount,
    findings: result.report.integrity.findings,
    files: {
      json: path.join(path.resolve(studyDir), 'behavior-report.json'),
      md: path.join(path.resolve(studyDir), 'behavior-report.md'),
    },
  });
  process.exit(result.status === 'REPORT_READY' || result.alreadyReady === true ? 0 : 1);
} catch (e) {
  if (e instanceof FrozenStudyWriteRefusedError) {
    out({ mode: verify ? 'verify' : 'write', ok: false, reason: 'frozen_study_write_refused', detail: e.message });
  } else if (e instanceof ReportRevisionRequiredError) {
    out({ mode: 'write', ok: false, reason: 'report_revision_required', detail: e.message });
  } else if (e instanceof StudyLockError) {
    out({ mode: 'write', ok: false, reason: 'study_writer_lock_held', detail: e.message });
  } else {
    out({ mode: verify ? 'verify' : 'write', ok: false, reason: 'failed', detail: e.message });
  }
  process.exit(1);
}
