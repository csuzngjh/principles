/**
 * PRI-361 Quality Scorecard — Local Evaluator
 *
 * Uses LM Studio (OpenAI-compatible) local model for advisory scoring.
 * This is Layer 1 of the dual-model gate.
 *
 * SAFETY: This evaluator only READS data and produces scores.
 * It never writes to production data, creates pain signals,
 * approves principles, or commits code.
 */

import type {
  PainEpisode,
  LocalEvaluation,
  RubricDimension,
  RubricScore,
} from './types.js';
import { RUBRIC_LABELS, RUBRIC_PROMPTS, RUBRIC_DIMENSIONS as DIMS, meetsMvpThreshold, sumScores } from './types.js';

// ── Prompt Builder ─────────────────────────────────────────────────

function buildEvaluationPrompt(episode: PainEpisode): string {
  const dimensions = DIMS.map(d => `${d} (${RUBRIC_LABELS[d]}): ${RUBRIC_PROMPTS[d]}`).join('\n');

  return `You are a quality evaluator for an AI agent's pain-signal → diagnosis → principle pipeline.

## Task
Evaluate this pain episode on a 7-dimension rubric. Each dimension scores 0 (fail), 1 (partial), or 2 (pass).

## Pain Episode
- ID: ${episode.episodeId}
- Source: ${episode.source}
- Pain Score: ${episode.score}
- Severity: ${episode.severity}
- Summary: ${episode.summary}
- Created: ${episode.createdAt}
- Evolution Task Resolution: ${episode.evolutionTaskResolution ?? 'none'}
- Linked Principles: ${episode.linkedPrinciples.length > 0 ? episode.linkedPrinciples.join(', ') : 'none'}
- Gate Blocks: ${episode.gateBlockCount}

## Rubric Dimensions
${dimensions}

## Additional Checks
- Is the language consistent (not mixing Chinese and English incoherently)?
- Is the diagnosis/principle overly abstract (no concrete actionable guidance)?
- Does it fabricate non-existent evidence, axioms, or references?

## Output Format (STRICT JSON)
Respond with ONLY a JSON object:
{
  "scores": { "G1": 0-2, "G2": 0-2, "G3": 0-2, "G4": 0-2, "G5": 0-2, "G6": 0-2, "G7": 0-2 },
  "rationales": { "G1": "...", "G2": "...", "G3": "...", "G4": "...", "G5": "...", "G6": "...", "G7": "..." },
  "flags": ["list of issues found, e.g. language_mixing, over_abstraction, fabricated_evidence"]
}

Do NOT output anything other than this JSON object.`;
}

// ── LM Studio Client ───────────────────────────────────────────────

interface LmStudioResponse {
  scores: Record<string, number>;
  rationales: Record<string, string>;
  flags: string[];
}

async function callLmStudio(
  baseUrl: string,
  model: string,
  prompt: string
): Promise<LmStudioResponse> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a precise JSON-output quality evaluator. Output only valid JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    throw new Error(`LM Studio request failed: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as { choices: { message: { content: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? '';

  // Extract JSON from response (handle ```json ... ``` wrapping)
  const jsonRe = /\{[\s\S]*\}/;
  const jsonMatch = jsonRe.exec(content);
  if (!jsonMatch) {
    throw new Error(`LM Studio returned non-JSON response: ${content.substring(0, 200)}`);
  }

  const parsed: Record<string, unknown> = JSON.parse(jsonMatch[0]);

  // Validate scores
  const validScores: Record<string, RubricScore> = {};
  const validRationales: Record<string, string> = {};
  for (const dim of DIMS) {
    const scores = parsed.scores as Record<string, unknown> | undefined;
    const raw: unknown = scores?.[dim];
    const score: RubricScore = (raw === 0 || raw === 1 || raw === 2) ? raw : 0;
    validScores[dim] = score;
    const rationales = parsed.rationales as Record<string, unknown> | undefined;
    validRationales[dim] = String(rationales?.[dim] ?? 'No rationale provided');
  }

  return {
    scores: validScores,
    rationales: validRationales,
    flags: Array.isArray(parsed.flags) ? (parsed.flags as unknown[]).map(String) : [],
  };
}

// ── Public API ─────────────────────────────────────────────────────

export interface LocalEvaluatorConfig {
  baseUrl: string;
  model: string;
}

export async function evaluateWithLocalModel(
  episode: PainEpisode,
  config: LocalEvaluatorConfig
): Promise<LocalEvaluation> {
  const prompt = buildEvaluationPrompt(episode);

  try {
    const result = await callLmStudio(config.baseUrl, config.model, prompt);

    const scores = result.scores as Record<RubricDimension, RubricScore>;
    const totalScore = sumScores(scores);

    return {
      model: config.model,
      dimensionScores: scores,
      dimensionRationales: result.rationales as Record<RubricDimension, string>,
      totalScore,
      maxScore: 14,
      mvpMet: meetsMvpThreshold(scores),
      flags: result.flags,
    };
  } catch (err: unknown) {
    // Return zero-score evaluation on failure
    const zeroScores = Object.fromEntries(DIMS.map(d => [d, 0])) as Record<RubricDimension, RubricScore>;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      model: config.model,
      dimensionScores: zeroScores,
      dimensionRationales: Object.fromEntries(DIMS.map(d => [d, `Evaluation failed: ${msg}`])) as Record<RubricDimension, string>,
      totalScore: 0,
      maxScore: 14,
      mvpMet: false,
      flags: ['evaluation_error'],
    };
  }
}

export async function checkLmStudioAvailable(baseUrl: string): Promise<{ available: boolean; models: string[]; error?: string }> {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return { available: false, models: [], error: `HTTP ${resp.status}` };
    const data = (await resp.json()) as { data: { id: string }[] };
    const models = (data.data || []).map((m) => m.id);
    return { available: true, models };
  } catch (err: unknown) {
    return { available: false, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}
