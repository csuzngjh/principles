#!/usr/bin/env node
// PRI-815 Phase 2 — freeze experiment inputs (SPEC §12 Input Freeze).
//
// Freezes, per source group, exactly what was knowable at formation start:
// the diagnostician_output artifact (diagnosis incl. evidence) + lineage ids.
// No future information (owner decisions, final principles, evaluator
// verdicts, later rulecodes) is copied. Output is the single input file the
// A/B harness reads; production DB is not touched at run time.

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_DB = process.env.PD_STATE_DB ?? 'D:/.openclaw/workspace/.pd/state.db';
const MANIFEST = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'sample-manifest.json');
const OUT = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'data', 'frozen-inputs.json');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const db = new DatabaseSync(STATE_DB, { readOnly: true, open: true });

const frozen = [];
for (const g of manifest.groups) {
  if (!g.diagnosis_parseable) continue;
  const art = db.prepare('SELECT artifact_id, content_json FROM artifacts WHERE task_id = ?').get(g.diagnosis_task_id);
  if (!art) continue;
  let diagnosis;
  try {
    diagnosis = JSON.parse(art.content_json);
  } catch {
    continue;
  }
  // input artifact ref, mirroring the production dreamer pi_metadata shape
  const contextRefs = [`artifact://${art.artifact_id}`];
  frozen.push({
    source_group_id: g.source_group_id,
    class: g.class,
    pain_id: g.pain_id,
    channel: g.channels[0] ?? 'unknown',
    language: g.language,
    diagnosis_task_id: g.diagnosis_task_id,
    diagnosis_artifact_id: art.artifact_id,
    contextRefs,
    diagnosis,
    input_hash: createHash('sha256').update(art.content_json).digest('hex'),
  });
}
db.close();

frozen.sort((a, b) => a.source_group_id.localeCompare(b.source_group_id));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  frozen_at: new Date().toISOString(),
  freeze_policy: 'formation-start information only (SPEC §12): diagnosis artifact + lineage ids; no owner decisions / final principles / evaluator verdicts',
  groups: frozen,
}, null, 2));
console.log(`frozen ${frozen.length} group inputs -> ${path.relative(ROOT, OUT)}`);
