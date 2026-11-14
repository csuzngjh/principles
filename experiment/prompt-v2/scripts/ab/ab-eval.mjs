/**
 * PD-SPEC-001 Phase 5 — independent blind evaluator (SPEC §7).
 *
 * Evaluator model: openrouter nvidia/nemotron-3-ultra-550b:free — a DIFFERENT
 * provider+model from the generation model (GLM-5.3-Flash on the AMD
 * endpoint), satisfying §7.4's independent-model preference. Scoring follows
 * the SPEC §6.2 weighted rubrics; every dimension requires Score/Evidence/
 * Rationale/Deduction/Severity/DownstreamImpact (§7.3). Blind: the evaluator
 * sees only Output-A/Output-B in the randomized order fixed by ab-blindpack.
 *
 * Usage: node ab-eval.mjs --run-id <id> [--limit N] [--stage router]
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXPERIMENT_ROOT } from './ab-lib.mjs';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const runId = getOpt('--run-id', null);
const limit = Number(getOpt('--limit', Infinity));
const stageFilter = getOpt('--stage', null);
if (!runId) throw new Error('--run-id required');

const RUBRICS = {
  rootcause: `Score Output-A and Output-B as root-cause analyses. Dimensions (weights): Evidence Fidelity 25 (claims traceable to provided evidence; fabricated evidence is a hard fail), Causal Accuracy 25 (each causal step supported; no forced depth), Responsibility Attribution 20 (tooling vs behavioral honesty), Uncertainty Handling 15 (ambiguityNotes/confidence calibration), Downstream Usability 15 (usable by Stage B).`,
  distiller: `Score Output-A and Output-B as principle distillations. Dimensions (weights): Source Fidelity 25 (faithful to the root-cause input; no second root-causing), Abstraction Accuracy 25 (abstract but grounded; no over-generalization), Scope Calibration 20 (general/domain/scenario justified), Behavioral Transferability 15, Uncertainty Handling 10, Conciseness 5 (≤200 chars).`,
  router: `Score Output-A and Output-B as router outputs. Dimensions (weights): Recommendation Accuracy 30 (justified kinds; no padding; defer used honestly), Principle Association Accuracy 25 (associations grounded; no invented ids), Knowledge Routing 20, Uncertainty and Defer Judgment 15, Downstream Usability 10. Also report whether each output copied the required upstream fields (diagnosisId/rootCause/evidence/confidence) exactly.`,
  dreamer: `Score Output-A and Output-B as alternative-decision candidate sets. Dimensions (weights): Root Cause Relevance 25, Candidate Diversity 25 (materially different strategies; reworded duplicates penalized), Strategy Effectiveness 20, Feasibility 15 (no assumed capabilities), Risk Awareness 15.`,
  philosopher: `Score Output-A and Output-B as critical syntheses. Dimensions (weights): Critical Evaluation 25 (challenges weak candidates, not mechanical acceptance), Synthesis Coherence 25 (one thesis; no merged mutually-exclusive strategies), Principle Necessity 20 (no false novelty), Consistency and Conflict Handling 15, Risk Identification 15.`,
  scribe: `Score Output-A and Output-B as final principle drafts. Dimensions (weights): Owner Intent Fidelity 25 (against the provided owner correction/intent; no invented requirements), Behavioral Actionability 25 (statement guides observable behavior), Requirement Retention 20 (mandatory requirements kept), Boundary Precision 15 (applicability/antiPatterns accurate), Internal Consistency 10, Conciseness 5.`,
};

async function callEvaluator(prompt) {
  const { request } = await import('node:https');
  const body = JSON.stringify({
    model: 'nvidia/nemotron-3-ultra-550b:free',
    messages: [
      { role: 'system', content: 'You are a meticulous, skeptical evaluator of AI-agent pipeline outputs. You judge ONLY from the provided material. Respond with ONLY a single JSON object, no markdown fences, no prose outside JSON.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 6000,
  });
  return new Promise((resolve, reject) => {
    const req = request(new URL('https://openrouter.ai/api/v1/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      timeout: 180_000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`evaluator HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
        try { resolve(JSON.parse(d).choices[0].message.content); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('evaluator timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON in evaluator reply');
  return JSON.parse(text.slice(start, end + 1));
}

const packDir = path.join(EXPERIMENT_ROOT, 'runs', runId, 'blindpack');
const evalsDir = path.join(EXPERIMENT_ROOT, 'runs', runId, 'evals');
fs.mkdirSync(evalsDir, { recursive: true });
const { packages } = JSON.parse(fs.readFileSync(path.join(packDir, 'packages.json'), 'utf8'));
const todo = packages.filter((p) => !stageFilter || p.stage === stageFilter).slice(0, limit);

let done = 0;
let failed = 0;
for (const pkg of todo) {
  const outPath = path.join(evalsDir, `${pkg.evalId}.json`);
  if (fs.existsSync(outPath)) { done += 1; continue; }
  const prompt = `You are given ONE real pain report from an agent-governance system and TWO candidate outputs for the "${pkg.stage}" pipeline stage. Evaluate both.

=== PAIN REPORT ===
${JSON.stringify(pkg.sample, null, 1)}

=== OUTPUT-A ===
${String(pkg.outputA).slice(0, 9000)}

=== OUTPUT-B ===
${String(pkg.outputB).slice(0, 9000)}

=== RUBRIC ===
${RUBRICS[pkg.stage]}

Return JSON exactly:
{
  "A": {"dimensionScores": {"<dimension>": {"score": 0-100, "evidence": "...", "rationale": "...", "deduction": "...", "severity": "none|minor|major|critical", "downstreamImpact": "..."}}, "weightedTotal": 0-100, "veto": null or "principle conflicts owner intent"|"core conclusion has no evidence support"|"cannot guide any recognizable behavior change", "vetoEvidence": "..."},
  "B": { ...same shape... },
  "pairwise": {"preferred": "A"|"B"|"tie", "reason": "...", "confidence": "low|medium|high"}
}
Score strictly: evidence fabrication or owner-intent conflict MUST be flagged (veto). Do not reward length. Do not reward confident language without evidence.`;
  try {
    const reply = await callEvaluator(prompt);
    const verdict = extractJson(reply);
    fs.writeFileSync(outPath, JSON.stringify({ evalId: pkg.evalId, stage: pkg.stage, source: pkg.source, sid: pkg.sample?.experimentPainId, verdict, evaluatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    done += 1;
    if (done % 5 === 0) console.log(`[${new Date().toISOString()}] ${done}/${todo.length} (failed ${failed})`);
  } catch (err) {
    failed += 1;
    fs.writeFileSync(path.join(evalsDir, `${pkg.evalId}.error.json`), JSON.stringify({ evalId: pkg.evalId, error: String(err?.message ?? err), at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  }
}
console.log(`eval done=${done} failed=${failed} -> ${evalsDir}`);
