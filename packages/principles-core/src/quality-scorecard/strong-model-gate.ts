/**
 * PRI-361 Quality Scorecard — Strong Model Adjudication Gate
 *
 * Layer 2 of the dual-model gate.
 * Uses a strong model (cloud provider) for:
 * - Sampling review of low-score / divergent / critical episodes
 * - Final quality verdict on reviewed samples
 * - Arbitration when local evaluator shows uncertain results
 *
 * Samples WITHOUT strong-model review can only be marked:
 * needs-review | local-pass | local-fail
 * NEVER pass | fail (those require strong-model confirmation).
 */

import type {
  PainEpisode,
  LocalEvaluation,
  StrongModelAdjudication,
  AdjudicationStatus,
  RubricDimension,
  RubricScore,
} from './types.js';
import { RUBRIC_LABELS, RUBRIC_DIMENSIONS as DIMS, meetsMvpThreshold } from './types.js';

// ── Adjudication Triggers ──────────────────────────────────────────

export interface AdjudicationDecision {
  shouldAdjudicate: boolean;
  reason: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Determine if an episode needs strong-model adjudication.
 *
 * Rules:
 * - MVP not met → always adjudicate
 * - Any flag mentioning fabrication → always adjudicate
 * - Score ≤ 8/14 → adjudicate
 * - Any dimension score = 0 → adjudicate
 * - Score ≥ 12/14 with MVP met → local-pass (no adjudication needed)
 * - Otherwise → needs-review
 */
export function needsAdjudication(
  episode: PainEpisode,
  localEval: LocalEvaluation
): AdjudicationDecision {
  // Critical: fabrication detected
  if (localEval.flags.includes('fabricated_evidence')) {
    return { shouldAdjudicate: true, reason: 'Fabrication detected in local evaluation', priority: 'critical' };
  }

  // Critical: MVP not met
  if (!localEval.mvpMet) {
    return { shouldAdjudicate: true, reason: `MVP threshold not met (score ${localEval.totalScore}/14)`, priority: 'high' };
  }

  // High: low total score
  if (localEval.totalScore <= 8) {
    return { shouldAdjudicate: true, reason: `Low total score (${localEval.totalScore}/14)`, priority: 'high' };
  }

  // Medium: any dimension scored 0
  const zeroDims = DIMS.filter(d => localEval.dimensionScores[d] === 0);
  if (zeroDims.length > 0) {
    return {
      shouldAdjudicate: true,
      reason: `Zero-score dimensions: ${zeroDims.join(', ')}`,
      priority: 'medium',
    };
  }

  // High score with MVP met → local-pass
  if (localEval.totalScore >= 12 && localEval.mvpMet) {
    return { shouldAdjudicate: false, reason: 'High score with MVP met — local-pass sufficient', priority: 'low' };
  }

  // Default: needs review
  return { shouldAdjudicate: true, reason: 'Moderate score — recommend strong-model review', priority: 'medium' };
}

// ── Strong Model Prompt ────────────────────────────────────────────

function buildAdjudicationPrompt(
  episode: PainEpisode,
  localEval: LocalEvaluation
): string {
  const localScores = DIMS.map(d =>
    `- ${d} (${RUBRIC_LABELS[d]}): ${localEval.dimensionScores[d]}/2 — ${localEval.dimensionRationales[d]}`
  ).join('\n');

  return `You are a senior quality adjudicator for an AI agent evolution pipeline.
Your job is to independently re-evaluate a pain episode that was first scored by a local (smaller) model.
You must provide your own scores — do NOT simply copy the local model's scores.

## Pain Episode
- ID: ${episode.episodeId}
- Source: ${episode.source}
- Pain Score: ${episode.score}
- Severity: ${episode.severity}
- Summary: ${episode.summary}
- Evolution Task Resolution: ${episode.evolutionTaskResolution ?? 'none'}
- Linked Principles: ${episode.linkedPrinciples.length > 0 ? episode.linkedPrinciples.join(', ') : 'none'}

## Local Model Scores (${localEval.model})
${localScores}
Flags: ${localEval.flags.length > 0 ? localEval.flags.join(', ') : 'none'}

## Your Task
1. Independently score each dimension (0/1/2) based on the evidence.
2. Check for: language inconsistency, over-abstraction, fabricated evidence.
3. If your scores differ from the local model by ≥2 points on any dimension, explain why.
4. Give a final verdict: pass, fail, or needs-review.

## Output Format (STRICT JSON)
{
  "scores": { "G1": 0-2, "G2": 0-2, "G3": 0-2, "G4": 0-2, "G5": 0-2, "G6": 0-2, "G7": 0-2 },
  "rationale": "Overall assessment...",
  "divergences": { "G1": "explanation if score differs from local", ... },
  "verdict": "pass" | "fail" | "needs-review"
}

Do NOT output anything other than this JSON object.`;
}

// ── Strong Model Client ────────────────────────────────────────────

interface AdjudicationResponse {
  scores: Record<string, number>;
  rationale: string;
  divergences: Record<string, string>;
  verdict: string;
}

async function callStrongModel(
  model: string,
  prompt: string
): Promise<AdjudicationResponse> {
  // Use OpenAI-compatible API (works with OpenAI, Anthropic proxy, etc.)
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set — cannot run strong-model adjudication');
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a precise JSON-output quality adjudicator. Output only valid JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    throw new Error(`Strong model request failed: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as { choices: { message: { content: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? '';
  const jsonRe = /\{[\s\S]*\}/;
  const jsonMatch = jsonRe.exec(content);
  if (!jsonMatch) {
    throw new Error(`Strong model returned non-JSON: ${content.substring(0, 200)}`);
  }

  return JSON.parse(jsonMatch[0]);
}

// ── Public API ─────────────────────────────────────────────────────

export async function adjudicate(
  episode: PainEpisode,
  localEval: LocalEvaluation,
  strongModelId: string
): Promise<StrongModelAdjudication> {
  const prompt = buildAdjudicationPrompt(episode, localEval);

  try {
    const result = await callStrongModel(strongModelId, prompt);

    const scores = Object.fromEntries(
      DIMS.map(d => {
        const raw = result.scores?.[d];
        return [d, (raw === 0 || raw === 1 || raw === 2 ? raw : 0) as RubricScore];
      })
    ) as Record<RubricDimension, RubricScore>;

    const verdict = result.verdict?.toLowerCase() ?? 'needs-review';
    const validStatuses: AdjudicationStatus[] = ['pass', 'fail', 'needs-review'];
    const status: AdjudicationStatus = validStatuses.includes(verdict as AdjudicationStatus)
      ? (verdict as AdjudicationStatus)
      : 'needs-review';

    return {
      model: strongModelId,
      adjudicationStatus: status,
      confirmedScores: scores,
      confirmedMvpMet: meetsMvpThreshold(scores),
      rationale: result.rationale ?? 'No rationale provided',
      nextAction: null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      model: strongModelId,
      adjudicationStatus: 'needs-review',
      confirmedScores: null,
      confirmedMvpMet: null,
      rationale: `Adjudication failed: ${msg}`,
      nextAction: 'Retry with strong model or manually review',
    };
  }
}

export function skippedAdjudication(reason: string): StrongModelAdjudication {
  return {
    model: 'none',
    adjudicationStatus: 'skipped',
    confirmedScores: null,
    confirmedMvpMet: null,
    rationale: reason,
    nextAction: 'Configure and run strong-model adjudication for final quality verdict',
  };
}

/**
 * Determine final label for an episode based on local + strong model results.
 * Without strong model review: only local-pass | local-fail | needs-review.
 * With strong model review: pass | fail | needs-review.
 */
export function determineFinalLabel(
  localEval: LocalEvaluation,
  adjudication: StrongModelAdjudication | null
): AdjudicationStatus {
  if (!adjudication || adjudication.adjudicationStatus === 'skipped') {
    // No strong model review — only local labels
    if (localEval.mvpMet && localEval.totalScore >= 12) return 'local-pass';
    if (localEval.totalScore <= 6) return 'local-fail';
    return 'needs-review';
  }

  // Strong model reviewed — use its verdict
  return adjudication.adjudicationStatus;
}
