/**
 * PD-SPEC-001 round 2 — Candidate Diversity specialized evaluator (SPEC §八
 * layer 1). Separate from the main blind rubric (which stays UNCHANGED): this
 * pass assesses ONE dreamer candidate set at a time (each blind package slot
 * independently) against the eight round-2 observation metrics.
 *
 * Blindness: slots are anonymous (Output-A/Output-B); arm identity is resolved
 * later at analysis time via blindmap.json. The evaluator never sees prompt
 * text, arm names, or run metadata.
 *
 * Evaluator: same configuration as the main round-2 evaluator (zai glm-5.3,
 * thinking disabled) — SAME-model-family limitation disclosed, per SPEC §八
 * layer 4. Failures are recorded per assessment (never silently dropped);
 * an assessment missing after retries lands as {error} in the output and is
 * reported in the summary with its selection-bias risk.
 *
 * Usage: node ab-diversity-eval.mjs --run-id <runId> [--limit N] [--suffix <tag>]
 *   Reads runs/<runId>/blindpack/packages.json (dreamer packages only);
 *   writes runs/<runId>/diversity-evals[.<suffix>]/<evalId>.<slot>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootstrapConfigContext, experimentRoot } from './ab-lib.mjs';

bootstrapConfigContext(process.argv.slice(2), 'usage: node ab-diversity-eval.mjs --config <experiment-config.json> --run-id <id> [--limit N] [--suffix <tag>]');

const DIVERSITY_PROMPT = `You are assessing ONE candidate set produced by a "Dreamer" agent in a principle-internalization pipeline. Assess the set ALONE (there is no comparison output). Judge each metric from 0 (worst) to 100 (best).

=== PAIN REPORT (context) ===
__SAMPLE__

=== CANDIDATE SET ===
__OUTPUT__

__SHAPE_NOTE__
=== METRICS ===
1. candidateDiversity — do the candidates represent genuinely different decision mechanisms (different decision point, information, rule, action, or outcome)?
2. semanticDuplication — score the ABSENCE of duplication: 100 = every candidate is a distinct mechanism; low = candidates restate the same mechanism in different words.
3. evidenceFidelity — every candidate is grounded in the supplied pain/evidence; no invented facts, capabilities, tools, or owner requirements.
4. decisionActionability — each betterDecision is a behavior an agent could actually perform and an observer could check.
5. strategicDistinctness — strategicPerspective labels communicate distinct mechanisms (not generic tags).
6. confidenceCalibration — confidence values match the strength of evidence supporting each candidate.
7. riskCalibration — riskLevel reflects the risk of APPLYING the candidate (over-restriction, escalation, overhead, side effects), not the original pain's severity.
8. candidateCountAdequacy — the number of candidates matches the number of genuinely independent corrective opportunities in the diagnosis (penalize BOTH padding with near-duplicates and premature collapse to one candidate when the evidence supports several).

Also report: distinctMechanisms (your count of genuinely distinct mechanisms in the set), duplicatedPairs (indexes of candidate pairs that restate the same mechanism, with a <=15-word reason each; empty array if none), fabricatedCapability (true if any candidate assumes a capability the evidence does not establish).

Return JSON exactly (COMPACT — valid JSON, no markdown fences):
{"candidateCount": <n>, "scores": {"candidateDiversity": 0-100, "semanticDuplication": 0-100, "evidenceFidelity": 0-100, "decisionActionability": 0-100, "strategicDistinctness": 0-100, "confidenceCalibration": 0-100, "riskCalibration": 0-100, "candidateCountAdequacy": 0-100}, "distinctMechanisms": <n>, "duplicatedPairs": [{"pair": [i, j], "reason": "..."}], "fabricatedCapability": true|false, "notes": "<=40 words"}
Score strictly: duplication and fabrication are the primary failure modes. Do not reward confident wording.`;

export async function callDiversityEvaluator(prompt) {
  const { request } = await import('node:https');
  const body = JSON.stringify({
    model: 'glm-5.3',
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: 'You are a meticulous, skeptical evaluator of AI-agent pipeline outputs. You judge ONLY from the provided material. Respond with ONLY a single JSON object, no markdown fences, no prose outside JSON.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 2000,
  });
  return new Promise((resolve, reject) => {
    const req = request(new URL('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.ZAI_API_KEY },
      timeout: 240_000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('evaluator HTTP ' + res.statusCode + ': ' + d.slice(0, 200)));
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

function shapeNote(pkg, slot) {
  const attempts = slot === 'A' ? pkg.attemptsA : pkg.attemptsB;
  const n = Array.isArray(attempts) ? attempts.length : null;
  return n !== null && n > 1
    ? `NOTE: this candidate set is a collection of ${n} dreamer artifacts (annotated array with index/artifactId/candidateCount/content). Assess the collection as a whole.`
    : '';
}

export function buildDiversityPrompt(pkg, slot) {
  const output = slot === 'A' ? pkg.outputA : pkg.outputB;
  return DIVERSITY_PROMPT
    .replace('__SAMPLE__', JSON.stringify(pkg.sample, null, 1))
    .replace('__OUTPUT__', String(output).slice(0, 9000))
    .replace('__SHAPE_NOTE__', shapeNote(pkg, slot));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv = process.argv.slice(2)) {
  const getOpt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const runId = getOpt('--run-id', null);
  const limit = Number(getOpt('--limit', Infinity));
  const suffix = getOpt('--suffix', null);
  if (!runId) throw new Error('--run-id required');
  if (!process.env.ZAI_API_KEY) throw new Error('ZAI_API_KEY not set');

  const runDir = path.join(experimentRoot(), 'runs', runId);
  const packDoc = JSON.parse(fs.readFileSync(path.join(runDir, 'blindpack', 'packages.json'), 'utf8'));
  const packages = (Array.isArray(packDoc?.packages) ? packDoc.packages : []).filter((p) => p?.stage === 'dreamer').slice(0, limit);
  const outDir = path.join(runDir, suffix ? `diversity-evals.${suffix}` : 'diversity-evals');
  fs.mkdirSync(outDir, { recursive: true });

  const tally = { assessments: 0, ok: 0, failed: 0, failures: [] };
  for (const pkg of packages) {
    for (const slot of ['A', 'B']) {
      const outPath = path.join(outDir, `${pkg.evalId}.${slot.toLowerCase()}.json`);
      const priorExists = (() => { try { fs.statSync(outPath); return true; } catch { return false; } })();
      if (priorExists) {
        const prior = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        if (prior?.verdict && !prior.error) { tally.ok += 1; tally.assessments += 1; continue; }
      }
      tally.assessments += 1;
      let verdict = null;
      let lastError = null;
      for (let attempt = 1; attempt <= 2 && !verdict; attempt++) {
        try {
          const reply = await callDiversityEvaluator(buildDiversityPrompt(pkg, slot));
          verdict = extractJson(reply);
          if (typeof verdict?.scores?.candidateDiversity !== 'number') {
            throw new Error('verdict missing numeric scores');
          }
        } catch (e) {
          lastError = String(e?.message ?? e).slice(0, 300);
          if (attempt < 2) await sleep(4000);
        }
      }
      const record = {
        evalId: pkg.evalId, stage: pkg.stage, source: pkg.source, sid: pkg.sid, rep: pkg.rep, slot,
        evaluatedAt: new Date().toISOString(),
        ...(verdict ? { verdict } : { error: lastError }),
      };
      fs.writeFileSync(outPath, JSON.stringify(record, null, 1) + '\n');
      if (verdict) { tally.ok += 1; console.log(`[ok] ${pkg.evalId}.${slot.toLowerCase()} (${pkg.sid} rep${pkg.rep})`); }
      else { tally.failed += 1; tally.failures.push({ evalId: pkg.evalId, slot, sid: pkg.sid, rep: pkg.rep, error: lastError }); console.log(`[FAILED] ${pkg.evalId}.${slot.toLowerCase()} (${pkg.sid} rep${pkg.rep}): ${lastError}`); }
    }
  }
  fs.writeFileSync(path.join(outDir, 'diversity-eval-summary.json'), JSON.stringify({
    runId, generatedAt: new Date().toISOString(), packages: packages.length, ...tally,
    selectionBiasNote: tally.failed > 0 ? 'failed assessments remain missing; per-sample failure counts are listed — check whether failures concentrate in one group before trusting arm-level averages' : null,
  }, null, 1) + '\n');
  console.log(`diversity eval complete: ${tally.ok}/${tally.assessments} ok, ${tally.failed} failed -> ${outDir}`);
  if (tally.failed > 0) process.exit(2); // fail loud, never silent-drop
}

const isDirect = process.argv[1] && process.argv[1].endsWith('ab-diversity-eval.mjs');
if (isDirect) main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
