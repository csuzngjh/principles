#!/usr/bin/env node
// PRI-815 Phase 2/4 — minimal information-flow A/B harness (SPEC §5).
//
// Arm A (current production contract, byte-faithful):
//   Diagnosis -> Dreamer -> Philosopher -> Scribe(current visibility)
//   Scribe sees ONLY the philosopher artifact + lineage ids (the production
//   ScribePromptBuilder payload; Dreamer's 1-5 candidates are structurally
//   invisible to Scribe — the gap this experiment measures).
//
// Arm B (minimal information repair):
//   Same D/P/S cognition, same model/params, same validators. ONLY the Scribe
//   input changes: it additionally receives sourceDiagnosis (with evidence),
//   dreamerProposals (ALL candidates), and provenance ids, plus a frozen
//   candidate-priority addendum (SPEC §6).
//
// Paired design: per group x repeat, Dreamer and Philosopher run ONCE and
// both Scribe arms consume the SAME D/P outputs, isolating the Scribe-input
// variable. Interleaving: scribe call order alternates A/B by repeat parity.
//
// Resume-safe: one JSON file per group; existing complete files are skipped.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chat, extractJson } from './llm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE = path.join(ROOT, 'packages', 'principles-core', 'dist', 'runtime-v2');
const DATA_DIR = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'data');

const { DreamerPromptBuilder } = await import(`file://${CORE}/internalization/dreamer-prompt-builder.js`.replace(/\\/g, '/'));
const { PhilosopherPromptBuilder } = await import(`file://${CORE}/internalization/philosopher-prompt-builder.js`.replace(/\\/g, '/'));
const { ScribePromptBuilder } = await import(`file://${CORE}/internalization/scribe-prompt-builder.js`.replace(/\\/g, '/'));
const { DefaultDreamerValidator } = await import(`file://${CORE}/internalization/dreamer-output.js`.replace(/\\/g, '/'));
const { DefaultPhilosopherValidator } = await import(`file://${CORE}/internalization/philosopher-output.js`.replace(/\\/g, '/'));
const { DefaultScribeValidator } = await import(`file://${CORE}/internalization/scribe-output.js`.replace(/\\/g, '/'));
const { BasePeerRunner } = await import(`file://${CORE}/runner/base-peer-runner.js`.replace(/\\/g, '/'));
const { reconcileLineageEcho } = await import(`file://${CORE}/internalization/peer-runner-contracts.js`.replace(/\\/g, '/'));

const hashContextRefs = (refs) => BasePeerRunner.hashContextRefs(refs);
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ── Arm B: candidate-priority addendum (SPEC §6; frozen after Phase 3) ─────
// Lives in b-addendum.mjs so report tooling can import it without executing
// this file's driver.
import { B_ADDENDUM_VERSION, B_ADDENDUM } from './b-addendum.mjs';
export { B_ADDENDUM_VERSION, B_ADDENDUM };

function buildArmBPrompt(input) {
  // payload = production Scribe payload + the three evidence blocks
  const payload = {
    taskId: input.taskId,
    contextHash: input.contextHash,
    sourcePhilosopherArtifactId: input.sourcePhilosopherArtifactId,
    ...(input.sourceDreamerArtifactId !== undefined ? { sourceDreamerArtifactId: input.sourceDreamerArtifactId } : {}),
    philosopherArtifact: input.philosopherArtifact,
    sourceDiagnosis: input.sourceDiagnosis,
    dreamerProposals: input.dreamerProposals,
    provenance: input.provenance,
    promptContractVersion: input.promptContractVersion,
  };
  const message = JSON.stringify(payload);
  const systemPrompt = input.baseSystemPrompt + B_ADDENDUM;
  return { message, systemPrompt, promptInput: payload };
}

// ── one LLM stage call with production-style validation ────────────────────
// `echoRepairs` mirrors the production postFetchTransform lineage-echo gate
// (PRI-541): the runner overwrites LLM-echoed lineage ids with authoritative
// values BEFORE validation. Omitting it makes the harness stricter than
// production (taskId truncation kills outputs production would repair).
async function runStage({ systemPrompt, message, validator, taskId, stage, echoRepairs }) {
  const res = await chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: message },
  ]);
  const parsed = res.content ? extractJson(res.content) : null;
  if (parsed && typeof parsed === 'object') {
    if (echoRepairs && echoRepairs.length > 0) {
      const corrected = reconcileLineageEcho(parsed, { topFields: echoRepairs });
      if (corrected.length > 0) {
        stageLogLineageEcho(stage, corrected);
      }
    } else if (!parsed.taskId || typeof parsed.taskId !== 'string') {
      parsed.taskId = taskId;
    }
  }
  const validation = parsed ? await validator.validate(parsed, taskId) : { valid: false, errors: ['unparseable_or_empty_output'] };
  return {
    stage,
    ok: validation.valid === true,
    errors: validation.errors ?? [],
    parsed,
    raw: res.content,
    usage: res.usage,
    latencyMs: res.latencyMs,
    attempts: res.attempt,
    error: res.error ?? null,
    promptHash: sha(systemPrompt + '\x00' + message),
  };
}

function stageLogLineageEcho(stage, corrected) {
  console.log(`[echo-repair] ${stage}: corrected ${corrected.join(', ')}`);
}

async function runGroupRepeat(g, repeat) {
  const taskIdBase = `pri815-${g.source_group_id}-r${repeat}`;
  const contextHash = hashContextRefs(g.contextRefs);
  const log = (m) => console.log(`[${g.source_group_id} r${repeat}] ${m} ${new Date().toISOString().slice(11, 19)}`);

  // Dreamer — production builder, full diagnosis as predecessorOutput
  const dBuilder = new DreamerPromptBuilder({ coreGrounding: true });
  const dPrompt = dBuilder.buildPrompt({
    taskId: `dreamer-${taskIdBase}`,
    contextHash,
    contextRefs: g.contextRefs,
    predecessorOutput: g.diagnosis,
    coreGrounding: true,
  });
  const dreamer = await runStage({ ...dPrompt, validator: new DefaultDreamerValidator(), taskId: `dreamer-${taskIdBase}`, stage: 'dreamer',
    echoRepairs: [{ field: 'taskId', authoritativeValue: `dreamer-${taskIdBase}` }] });
  log(`dreamer ok=${dreamer.ok} ms=${dreamer.latencyMs}`);
  if (!dreamer.ok) return { group: g.source_group_id, repeat, aborted: 'dreamer_invalid', dreamer };

  // Philosopher — production builder, dreamer artifact as input
  const dreamerArtifactId = `pi-art-dreamer-${taskIdBase}-run1`;
  const pBuilder = new PhilosopherPromptBuilder({ coreGrounding: true });
  const pPrompt = pBuilder.buildPrompt({
    taskId: `philosopher-${taskIdBase}`,
    contextHash,
    dreamerArtifact: dreamer.parsed,
    sourceDreamerArtifactId: dreamerArtifactId,
    coreGrounding: true,
  });
  const philosopher = await runStage({ ...pPrompt, validator: new DefaultPhilosopherValidator(), taskId: `philosopher-${taskIdBase}`, stage: 'philosopher',
    echoRepairs: [
      { field: 'taskId', authoritativeValue: `philosopher-${taskIdBase}` },
      { field: 'sourceDreamerArtifactId', authoritativeValue: dreamerArtifactId },
    ] });
  log(`philosopher ok=${philosopher.ok} ms=${philosopher.latencyMs}`);
  if (!philosopher.ok) return { group: g.source_group_id, repeat, aborted: 'philosopher_invalid', dreamer, philosopher };

  const philosopherArtifactId = `pi-art-philosopher-${taskIdBase}-run1`;
  const scribeInput = {
    taskId: `scribe-${taskIdBase}`,
    contextHash,
    sourcePhilosopherArtifactId: philosopherArtifactId,
    sourceDreamerArtifactId: dreamerArtifactId,
    philosopherArtifact: philosopher.parsed,
    sourceDiagnosis: g.diagnosis,
    dreamerProposals: dreamer.parsed.candidates,
    provenance: { sourcePainId: g.pain_id, diagnosisTaskId: g.diagnosis_task_id, diagnosisArtifactId: g.diagnosis_artifact_id, dreamerArtifactId, philosopherArtifactId },
    promptContractVersion: 'scribe-output-v1.prompt.v3',
  };

  // Scribe A — production builder, current visibility (byte-faithful)
  const sBuilder = new ScribePromptBuilder({ coreGrounding: true });
  const aPrompt = sBuilder.buildPrompt({
    taskId: scribeInput.taskId,
    contextHash,
    sourcePhilosopherArtifactId: scribeInput.sourcePhilosopherArtifactId,
    sourceDreamerArtifactId: scribeInput.sourceDreamerArtifactId,
    philosopherArtifact: scribeInput.philosopherArtifact,
    coreGrounding: true,
  });
  scribeInput.baseSystemPrompt = aPrompt.systemPrompt;

  // Scribe B — same payload + evidence blocks + frozen addendum
  const bPrompt = buildArmBPrompt(scribeInput);

  const mk = (arm) => runStage({
    systemPrompt: arm === 'A' ? aPrompt.systemPrompt : bPrompt.systemPrompt,
    message: arm === 'A' ? aPrompt.message : bPrompt.message,
    validator: new DefaultScribeValidator(),
    taskId: scribeInput.taskId,
    stage: `scribe_${arm}`,
    echoRepairs: [
      { field: 'taskId', authoritativeValue: scribeInput.taskId },
      { field: 'sourcePhilosopherArtifactId', authoritativeValue: scribeInput.sourcePhilosopherArtifactId },
    ],
  });
  // interleave order by repeat parity (SPEC §13)
  const [first, second] = repeat % 2 === 1 ? ['A', 'B'] : ['B', 'A'];
  const out = { group: g.source_group_id, repeat, dreamer, philosopher };
  out[`scribe_${first}`] = await mk(first);
  log(`scribe_${first} ok=${out[`scribe_${first}`].ok} ms=${out[`scribe_${first}`].latencyMs}`);
  out[`scribe_${second}`] = await mk(second);
  log(`scribe_${second} ok=${out[`scribe_${second}`].ok} ms=${out[`scribe_${second}`].latencyMs}`);
  return out;
}

// ── driver ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = flag('--only') ? flag('--only').split(',') : null;
const repeats = Number(flag('--repeats') ?? 3);
const concurrency = Number(flag('--concurrency') ?? 3);
const subdir = flag('--out') ?? 'runs';
const frozenAll = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'frozen-inputs.json'), 'utf8')).groups;
const groups = only ? frozenAll.filter((g) => only.includes(g.source_group_id)) : frozenAll;

const OUT_DIR = path.join(DATA_DIR, subdir);
fs.mkdirSync(OUT_DIR, { recursive: true });

const queue = [];
for (const g of groups) {
  const file = path.join(OUT_DIR, `${g.source_group_id}.json`);
  // TOCTOU-safe read (CodeQL): unreadable/incomplete file = redo the group
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.repeats?.length === repeats && existing.repeats.every((r) => r.complete)) {
      console.log(`[skip] ${g.source_group_id} (complete)`);
      continue;
    }
  }
  queue.push({ g, file });
}

let done = 0;
async function worker(id) {
  while (queue.length > 0) {
    const { g, file } = queue.shift();
    const repeatsOut = [];
    for (let r = 1; r <= repeats; r++) {
      const res = await runGroupRepeat(g, r);
      res.complete = !res.aborted;
      repeatsOut.push(res);
      fs.writeFileSync(file, JSON.stringify({ group: g.source_group_id, class: g.class, pain_id: g.pain_id, frozen_at: new Date().toISOString(), repeats: repeatsOut, b_addendum_version: B_ADDENDUM_VERSION }, null, 1));
    }
    done += 1;
    console.log(`[w${id}] ${g.source_group_id} done (${done}/${queue.length + done} remaining files in this batch: ${queue.length})`);
  }
}
await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)));
console.log('ALL DONE');
