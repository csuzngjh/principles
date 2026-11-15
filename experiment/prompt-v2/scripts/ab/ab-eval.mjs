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
 * Consumes the ab-blindpack packages.json contract: entries carry
 * { evalId, stage, source, sid, rep, sample (incl. FULL evidence notes),
 *   outputA, outputB, attemptsA, attemptsB, completeness }. When a stage
 * output is a multi-artifact collection, the evaluator is told so (annotated
 * attempt collection) instead of silently judging a truncated candidate set.
 * Requests stay LOCAL to this script (evaluation orchestration is an
 * experiment-layer concern, not production code); eval files land in
 * runs/<run-id>/evals/ exactly as before.
 *
 * Usage: node ab-eval.mjs --run-id <id> [--limit N] [--stage router]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXPERIMENT_ROOT } from './ab-lib.mjs';

const RUBRICS = {
  rootcause: `Score Output-A and Output-B as root-cause analyses. Dimensions (weights): Evidence Fidelity 25 (claims traceable to provided evidence; fabricated evidence is a hard fail), Causal Accuracy 25 (each causal step supported; no forced depth), Responsibility Attribution 20 (tooling vs behavioral honesty), Uncertainty Handling 15 (ambiguityNotes/confidence calibration), Downstream Usability 15 (usable by Stage B).`,
  distiller: `Score Output-A and Output-B as principle distillations. Dimensions (weights): Source Fidelity 25 (faithful to the root-cause input; no second root-causing), Abstraction Accuracy 25 (abstract but grounded; no over-generalization), Scope Calibration 20 (general/domain/scenario justified), Behavioral Transferability 15, Uncertainty Handling 10, Conciseness 5 (≤200 chars).`,
  router: `Score Output-A and Output-B as router outputs. Dimensions (weights): Recommendation Accuracy 30 (justified kinds; no padding; defer used honestly), Principle Association Accuracy 25 (associations grounded; no invented ids), Knowledge Routing 20, Uncertainty and Defer Judgment 15, Downstream Usability 10. Also report whether each output copied the required upstream fields (diagnosisId/rootCause/evidence/confidence) exactly.`,
  dreamer: `Score Output-A and Output-B as alternative-decision candidate sets. Dimensions (weights): Root Cause Relevance 25, Candidate Diversity 25 (materially different strategies; reworded duplicates penalized), Strategy Effectiveness 20, Feasibility 15 (no assumed capabilities), Risk Awareness 15.`,
  philosopher: `Score Output-A and Output-B as critical syntheses. Dimensions (weights): Critical Evaluation 25 (challenges weak candidates, not mechanical acceptance), Synthesis Coherence 25 (one thesis; no merged mutually-exclusive strategies), Principle Necessity 20 (no false novelty), Consistency and Conflict Handling 15, Risk Identification 15.`,
  scribe: `Score Output-A and Output-B as final principle drafts. Dimensions (weights): Owner Intent Fidelity 25 (against the provided owner correction/intent; no invented requirements), Behavioral Actionability 25 (statement guides observable behavior), Requirement Retention 20 (mandatory requirements kept), Boundary Precision 15 (applicability/antiPatterns accurate), Internal Consistency 10, Conciseness 5.`,
};

export async function callEvaluator(prompt) {
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

export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON in evaluator reply');
  return JSON.parse(text.slice(start, end + 1));
}

/** Blinding-safe annotation: tells the evaluator WHEN an output is a
 *  multi-artifact collection — never which arm produced it. */
export function attemptAnnotation(pkg) {
  const nA = Array.isArray(pkg?.attemptsA) ? pkg.attemptsA.length : null;
  const nB = Array.isArray(pkg?.attemptsB) ? pkg.attemptsB.length : null;
  const lines = [];
  if (nA !== null && nA > 1) lines.push(`Output-A is a collection of ${nA} artifacts captured for this stage (annotated array: index/artifactId/candidateCount/content). Judge the collection as a whole.`);
  if (nB !== null && nB > 1) lines.push(`Output-B is a collection of ${nB} artifacts captured for this stage (annotated array: index/artifactId/candidateCount/content). Judge the collection as a whole.`);
  return lines.length ? `\n=== OUTPUT SHAPE NOTE ===\n${lines.join('\n')}\n` : '';
}

export function buildEvalPrompt(pkg) {
  return `You are given ONE real pain report from an agent-governance system and TWO candidate outputs for the "${pkg.stage}" pipeline stage. Evaluate both.

=== PAIN REPORT ===
${JSON.stringify(pkg.sample, null, 1)}

=== OUTPUT-A ===
${String(pkg.outputA).slice(0, 9000)}

=== OUTPUT-B ===
${String(pkg.outputB).slice(0, 9000)}
${attemptAnnotation(pkg)}
=== RUBRIC ===
${RUBRICS[pkg.stage]}

Return JSON exactly:
{
  "A": {"dimensionScores": {"<dimension>": {"score": 0-100, "evidence": "...", "rationale": "...", "deduction": "...", "severity": "none|minor|major|critical", "downstreamImpact": "..."}}, "weightedTotal": 0-100, "veto": null or "principle conflicts owner intent"|"core conclusion has no evidence support"|"cannot guide any recognizable behavior change", "vetoEvidence": "..."},
  "B": { ...same shape... },
  "pairwise": {"preferred": "A"|"B"|"tie", "reason": "...", "confidence": "low|medium|high"}
}
Score strictly: evidence fabrication or owner-intent conflict MUST be flagged (veto). Do not reward length. Do not reward confident language without evidence.`;
}

export async function main(argv = process.argv.slice(2)) {
  const getOpt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const runId = getOpt('--run-id', null);
  const limit = Number(getOpt('--limit', Infinity));
  const stageFilter = getOpt('--stage', null);
  if (!runId) throw new Error('--run-id required');
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not set — set it in the environment (never pass it on the command line) and retry');
  }

  const packDir = path.join(EXPERIMENT_ROOT, 'runs', runId, 'blindpack');
  const evalsDir = path.join(EXPERIMENT_ROOT, 'runs', runId, 'evals');
  fs.mkdirSync(evalsDir, { recursive: true });
  const packDoc = JSON.parse(fs.readFileSync(path.join(packDir, 'packages.json'), 'utf8'));
  // packages.json contract (ab-blindpack): { runId, count, missing, packages: [...] }
  const packages = Array.isArray(packDoc?.packages) ? packDoc.packages : Array.isArray(packDoc) ? packDoc : null;
  if (!packages) {
    throw new Error(`packages.json at ${packDir} has no packages array — regenerate the blind pack with ab-blindpack.mjs (next action: node ab-blindpack.mjs --run-id ${runId})`);
  }
  if (packages.length === 0) {
    console.log(`eval skipped: blind pack for ${runId} contains 0 packages (missingCount=${packDoc.missingCount ?? 'n/a'}) — inspect packages.json missing[] before evaluating`);
    return { done: 0, failed: 0, evalsDir };
  }
  const todo = packages.filter((p) => !stageFilter || p.stage === stageFilter).slice(0, limit);

  let done = 0;
  let failed = 0;
  for (const pkg of todo) {
    const outPath = path.join(evalsDir, `${pkg.evalId}.json`);
    if (fs.existsSync(outPath)) { done += 1; continue; }
    const prompt = buildEvalPrompt(pkg);
    try {
      const reply = await callEvaluator(prompt);
      const verdict = extractJson(reply);
      fs.writeFileSync(outPath, JSON.stringify({ evalId: pkg.evalId, stage: pkg.stage, source: pkg.source, sid: pkg.sample?.experimentPainId ?? pkg.sid ?? null, rep: pkg.rep ?? 0, verdict, evaluatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
      done += 1;
      if (done % 5 === 0) console.log(`[${new Date().toISOString()}] ${done}/${todo.length} (failed ${failed})`);
    } catch (err) {
      failed += 1;
      fs.writeFileSync(path.join(evalsDir, `${pkg.evalId}.error.json`), JSON.stringify({ evalId: pkg.evalId, error: String(err?.message ?? err), at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    }
  }
  console.log(`eval done=${done} failed=${failed} -> ${evalsDir}`);
  return { done, failed, evalsDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
