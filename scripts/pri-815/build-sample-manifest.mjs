#!/usr/bin/env node
// PRI-815 Phase 1 — Sample Reality Check (read-only against production DB).
//
// Clusters internalization chains by original Pain lineage (SPEC §7: the only
// independent statistical unit), classifies DEV/REGRESSION vs CLEAN holdout,
// and freezes the sample manifest before any A/B run opens it.
//
// Read-only: opens state.db with { readOnly: true }. Writes only the manifest
// JSON + markdown under docs/audit/pri-815-quality-first/.
//
// CLEAN definition (SPEC §9): the source group's data was never collected,
// read, or used for prompt adjustment by the PRI-815 spike. The spike's
// ab-inputs.json (56 chains) is the authoritative "touched" record for
// succeeded-dreamer groups; groups whose dreamer never ran (pending) and are
// absent from that file are clean if their diag_router diagnosis is parseable.

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_DB = process.env.PD_STATE_DB ?? 'D:/.openclaw/workspace/.pd/state.db';
const SPIKE_AB_INPUTS = process.env.PD_SPIKE_AB_INPUTS ?? 'D:/pd-probe-815/ab-inputs.json';
const OUT_DIR = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first');

function detectLanguage(text) {
  if (!text) return 'unknown';
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return cjk > text.length * 0.15 ? 'zh' : 'en';
}

function severityOf(diagnosis) {
  const text = JSON.stringify(diagnosis?.evidence ?? diagnosis ?? {});
  const m = text.match(/(severe|critical|high|medium|low)\s*级别/i) ?? text.match(/"(severe|critical|high|medium|low)"/i);
  return m ? m[1].toLowerCase() : 'unknown';
}

const db = new DatabaseSync(STATE_DB, { readOnly: true, open: true });

// 1. spike-touched dreamer tasks (the 56-chain collection)
const spikeTouchedTasks = new Set();
try {
  const spike = JSON.parse(fs.readFileSync(SPIKE_AB_INPUTS, 'utf8'));
  for (const e of spike) spikeTouchedTasks.add(e.dreamerTask);
} catch {
  // absent spike file ⇒ nothing is spike-touched
}

// 2. all dreamer tasks grouped by sourcePainId
const dreamerRows = db.prepare("SELECT task_id, status, created_at, diagnostic_json FROM tasks WHERE task_kind='dreamer'").all();
const groups = new Map();
for (const r of dreamerRows) {
  let dj = {};
  try { dj = JSON.parse(r.diagnostic_json || '{}'); } catch { /* malformed envelope */ }
  const meta = dj.pi_metadata ?? {};
  const pain = dj.sourcePainId ?? 'UNKNOWN';
  if (!groups.has(pain)) {
    groups.set(pain, { painId: pain, dreamerTasks: [], channels: new Set(), firstSeen: null });
  }
  const g = groups.get(pain);
  g.dreamerTasks.push({ taskId: r.task_id, status: r.status, created: r.created_at, diagnosticJson: r.diagnostic_json });
  if (meta.channel) g.channels.add(meta.channel);
  if (!g.firstSeen || r.created_at < g.firstSeen) g.firstSeen = r.created_at;
}

// 3. per-group: diagnosis resolution + downstream chain outcome
const manifest = [];
for (const [painId, g] of groups) {
  const succeeded = g.dreamerTasks.filter((t) => t.status === 'succeeded');
  const sampleTask = succeeded[0] ?? g.dreamerTasks[0];
  let dj = {};
  try { dj = JSON.parse(sampleTask.diagnosticJson || '{}'); } catch { /* keep {} */ }
  const routerTaskId = (dj.pi_metadata?.dependencyTaskIds ?? [])[0] ?? null;
  let diagnosis = null;
  let diagnosisChars = 0;
  if (routerTaskId) {
    const art = db.prepare('SELECT content_json FROM artifacts WHERE task_id = ?').get(routerTaskId);
    if (art) {
      try {
        diagnosis = JSON.parse(art.content_json);
        diagnosisChars = art.content_json.length;
      } catch { /* unparseable diagnosis */ }
    }
  }
  // artifacts per group (pi_artifacts written by dreamer/philosopher/scribe tasks of this pain)
  const taskIds = g.dreamerTasks.map((t) => t.taskId);
  let artifactCount = 0;
  let scribeOutcome = 'never_reached';
  for (const t of taskIds) {
    artifactCount += db.prepare('SELECT COUNT(*) c FROM pi_artifacts WHERE source_task_id = ?').get(t).c;
  }
  // historical outcome: follow successor tasks (philosopher/scribe) whose
  // dependencyTaskIds reference this group's dreamer tasks
  if (succeeded.length > 0) {
    let scribeSucceeded = false;
    let evaluatorOutcome = 'not_reached';
    for (const t of taskIds) {
      const philRows = db.prepare("SELECT task_id, status FROM tasks WHERE task_kind='philosopher' AND diagnostic_json LIKE ?").all(`%${t}%`);
      for (const p of philRows) {
        const scrRows = db.prepare("SELECT task_id, status FROM tasks WHERE task_kind='scribe' AND diagnostic_json LIKE ?").all(`%${p.task_id}%`);
        for (const s of scrRows) {
          if (s.status === 'succeeded') scribeSucceeded = true;
          const evRows = db.prepare("SELECT status FROM tasks WHERE task_kind='evaluator' AND diagnostic_json LIKE ?").all(`%${s.task_id}%`);
          for (const e of evRows) {
            if (e.status === 'succeeded') evaluatorOutcome = 'evaluator_succeeded';
            else if (e.status === 'needs_human_review') evaluatorOutcome = 'needs_human_review';
            else if (e.status === 'failed' && evaluatorOutcome === 'not_reached') evaluatorOutcome = 'evaluator_failed';
          }
        }
      }
    }
    scribeOutcome = scribeSucceeded ? `scribe_succeeded/${evaluatorOutcome}` : 'dreamer_only';
  }
  const spikeTouched = g.dreamerTasks.some((t) => spikeTouchedTasks.has(t.taskId));
  const usable = diagnosis !== null && diagnosisChars > 0;
  manifest.push({
    source_group_id: `G-${painId.slice(0, 24)}`,
    pain_id: painId,
    diagnosis_task_id: routerTaskId,
    diagnosis_parseable: usable,
    diagnosis_chars: diagnosisChars,
    channels: [...g.channels].sort(),
    risk: severityOf(diagnosis),
    language: detectLanguage(diagnosis?.summary ?? diagnosis?.rootCause ?? ''),
    dreamer_task_count: g.dreamerTasks.length,
    dreamer_succeeded: succeeded.length,
    artifact_count: artifactCount,
    historical_outcome: scribeOutcome,
    seen_in_previous_spike: spikeTouched,
    // CLEAN = diagnosis parseable AND never collected by the spike AND no
    // succeeded dreamer chain was read during spike work
    class: usable && !spikeTouched ? 'CLEAN' : (usable ? 'DEV' : 'EXCLUDED'),
    exclusion_reason: !usable ? 'diagnosis_missing_or_unparseable' : null,
    first_seen: g.firstSeen,
  });
}

manifest.sort((a, b) => (a.firstSeen ?? '').localeCompare(b.firstSeen ?? ''));
db.close();

const totalArtifacts = manifest.reduce((s, g) => s + g.artifact_count, 0);
const usable = manifest.filter((g) => g.class !== 'EXCLUDED');
const summary = {
  TOTAL_SOURCE_GROUPS: manifest.length,
  TOTAL_ARTIFACTS: totalArtifacts,
  INDEPENDENT_N: usable.length,
  DEV_GROUPS: manifest.filter((g) => g.class === 'DEV').length,
  CLEAN_HOLDOUT_N: manifest.filter((g) => g.class === 'CLEAN').length,
  EXCLUDED: manifest.filter((g) => g.class === 'EXCLUDED').length,
  MODE: 'EXPLORATORY',
  MODE_REASON:
    'No clean holdout large enough for a confirmatory one-sided sign test (clean N=' +
    manifest.filter((g) => g.class === 'CLEAN').length +
    ' would require unanimity). All succeeded-dreamer groups were collected by the PRI-815 spike (ab-inputs.json, 56 chains) and are DEV/REGRESSION per SPEC §9.',
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'sample-manifest.json'), JSON.stringify({ summary, groups: manifest }, null, 2));

const md = [
  '# PRI-815 Quality-First — Sample Manifest (frozen before A/B)',
  '',
  `> Generated ${new Date().toISOString()} from \`${STATE_DB}\` (read-only). Input freeze: manifest frozen BEFORE any Phase 4 A/B run (SPEC §8/§10).`,
  '',
  '## Summary',
  '',
  '```text',
  ...Object.entries(summary).map(([k, v]) => `${k} = ${v}`),
  '```',
  '',
  '## Groups',
  '',
  '| group | pain | diagnosis ok | ch | risk | lang | dreamers (succ) | artifacts | hist outcome | spike-seen | class |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...manifest.map((g) =>
    `| ${g.source_group_id} | ${g.pain_id.slice(0, 30)} | ${g.diagnosis_parseable ? 'Y' : 'N'} | ${g.channels.join('+')} | ${g.risk} | ${g.language} | ${g.dreamer_task_count} (${g.dreamer_succeeded}) | ${g.artifact_count} | ${g.historical_outcome} | ${g.seen_in_previous_spike ? 'Y' : 'N'} | ${g.class} |`,
  ),
  '',
  'Independent unit = original Pain lineage (SPEC §7). Same-source retries/revisions/channel variants never increase N.',
  '',
].join('\n');
fs.writeFileSync(path.join(OUT_DIR, 'SAMPLE_MANIFEST.md'), md);

console.log(JSON.stringify(summary, null, 2));
