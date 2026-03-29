/**
 * Nocturnal Benchmark — Scorer Adapters
 * =====================================
 *
 * Phase 4 evaluation interface: ScorerAdapter contract.
 *
 * Two implementations are provided:
 *
 * 1. StructuralScorerAdapter  (baseline / mock evaluator)
 *    - Deterministic structural heuristics only
 *    - Checkpoint-agnostic: ignores checkpointRef; the same sample always
 *      gets the same score regardless of which checkpoint is being evaluated
 *    - Delta from structural scorer alone will be ~0 for runCompare()
 *      (this is correct — structural scorer measures data quality, not checkpoint quality)
 *
 * 2. LocalModelScorerAdapter  (placeholder for real model evaluation)
 *    - Intended for real model inference endpoints
 *    - Accepts checkpointRef and routes to the appropriate checkpoint-specific
 *      model variant, producing genuine behavioral score differences
 *    - Currently a STUB: returns a fixed score with evaluator metadata
 *      indicating the placeholder status
 *    - Replace the stub implementation with real model inference when
 *      the evaluation infrastructure is available
 *
 * IMPORTANT — ScorerAdapter invariant:
 *   Delta in runCompare() must come from the evaluator's real assessment of
 *   the checkpoint's behavioral output. It must NOT come from synthetic
 *   manipulation of the checkpointRef string (no hashing, no string-derived bias).
 *
 *   This means:
 *   - StructuralScorerAdapter: delta ≈ 0 for any two checkpoints (expected)
 *   - LocalModelScorerAdapter (with real model): delta reflects real score differences
 *   - LocalModelScorerAdapter (stub): delta = 0 or stub-delivered differences (ok for scaffolding)
 *
 *   The contract guarantees: if you see a non-zero delta, it came from the
 *   evaluator's actual assessment behavior, not from the benchmark harness.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ORPOSample, ScoredSample, ScorerAdapter, EvalMode } from './types.js';

// ---------------------------------------------------------------------------
// Keyword Extraction (used by StructuralScorerAdapter)
// ---------------------------------------------------------------------------

/**
 * Extract significant keywords from text.
 * Strips common stopwords and returns lowercase words > 3 chars.
 */
function extractKeywords(text: string): Set<string> {
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
    'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'when', 'where',
    'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
    'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there', 'then',
    'once', 'if', 'because', 'until', 'while', 'although', 'though', 'after',
    'before', 'since', 'when', 'where', 'about', 'into', 'through', 'during',
    'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once',
    'being', 'having', 'doing', 'their', 'them', 'they', 'your', 'you',
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));

  return new Set(words);
}

/**
 * Compute overlap ratio between two keyword sets.
 */
function keywordOverlap(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0.5;
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const word of setA) {
    if (setB.has(word)) overlap++;
  }
  return overlap / Math.sqrt(setA.size * setB.size);
}

/**
 * Check if a decision text contains action-oriented language.
 */
function hasActionLanguage(text: string): boolean {
  const ACTION_PATTERNS = [
    /\b(check|verify|validate|test|read|inspect|examine|look|see|find|search|query|analyze|review)\b/i,
    /\b(before|after|when|if|while|unless|until)\b/i,
    /\b(use|apply|implement|add|remove|change|update|fix|repair|correct)\b/i,
    /\b(error|failure|fail|exception|issue|problem|bug|mistake|wrong)\b/i,
  ];
  return ACTION_PATTERNS.some((p) => p.test(text));
}

/**
 * Check if the rationale provides concrete justification.
 */
function rationaleStrength(rationale: string): number {
  if (!rationale || rationale.length < 20) return 0.0;
  if (rationale.length < 50) return 0.3;
  if (rationale.length < 100) return 0.6;
  return 0.8;
}

/**
 * Check if chosen and rejected are meaningfully different.
 */
function decisionSeparation(chosen: string, rejected: string): number {
  const chosenWords = extractKeywords(chosen);
  const rejectedWords = extractKeywords(rejected);

  if (chosenWords.size === 0 && rejectedWords.size === 0) return 0.5;

  const overlap = keywordOverlap(chosenWords, rejectedWords);
  // High overlap = low separation
  return 1.0 - overlap;
}

/**
 * Build a human-readable justification string.
 */
function buildJustification(
  mode: EvalMode,
  chosenRationaleOverlap: number,
  rejectedPenalty: number,
  separation: number,
  rStrength: number,
  finalScore: number
): string {
  const parts: string[] = [];

  parts.push(
    chosenRationaleOverlap >= 0.5
      ? 'chosen aligns with rationale'
      : 'chosen weakly aligned with rationale'
  );

  if (rejectedPenalty > 0.2) {
    parts.push('rejected contradicts rationale');
  }

  parts.push(
    separation >= 0.6
      ? 'decisions are well-separated'
      : 'decisions overlap significantly'
  );

  const scoreBand = finalScore >= 0.7 ? 'high' : finalScore >= 0.4 ? 'medium' : 'low';

  return `[structural:${mode}] ${parts.join('; ')} (${scoreBand} score: ${finalScore.toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// StructuralScorerAdapter
// ---------------------------------------------------------------------------

/**
 * StructuralScorerAdapter — checkpoint-agnostic baseline / mock evaluator.
 *
 * Scores based purely on structural heuristics (keyword alignment, decision
 * separation, rationale strength). The checkpointRef parameter is accepted
 * for interface compatibility but has NO effect on the score — the same
 * sample always receives the same score regardless of which checkpoint is
 * being evaluated.
 *
 * This is the correct behavior for a structural evaluator: it measures the
 * intrinsic quality of the training data (chosen/rejected/rationale
 * alignment), not the quality of any particular checkpoint.
 *
 * runCompare() with StructuralScorerAdapter alone: delta ≈ 0 for any
 * baseline/candidate pair. This is expected and is NOT a bug.
 */
export const STRUCTURAL_SCORER_VERSION = '1.0.0';

export const StructuralScorerAdapter: ScorerAdapter = {
  evaluatorType: 'structural',
  version: STRUCTURAL_SCORER_VERSION,

  async score(
    sample: ORPOSample,
    mode: EvalMode,
    _checkpointRef?: string
  ): Promise<ScoredSample> {
    // NOTE: _checkpointRef is intentionally ignored.
    //       Structural scorer is checkpoint-agnostic — same sample, same score.
    const rationaleKW = extractKeywords(sample.rationale);
    const chosenKW = extractKeywords(sample.chosen);
    const rejectedKW = extractKeywords(sample.rejected);

    // 1. Chosen alignment with rationale (0.0–1.0)
    const chosenRationaleOverlap = keywordOverlap(chosenKW, rationaleKW);

    // 2. Rejected contradiction with rationale (0.0–1.0)
    const rejectedRationaleOverlap = keywordOverlap(rejectedKW, rationaleKW);
    const rejectedPenalty = rejectedRationaleOverlap * (1 - chosenRationaleOverlap);

    // 3. Decision separation (0.0–1.0)
    const separation = decisionSeparation(sample.chosen, sample.rejected);

    // 4. Rationale strength (0.0–1.0)
    const rStrength = rationaleStrength(sample.rationale);

    // 5. Action language in chosen (bonus 0.0–0.1)
    const actionBonus = hasActionLanguage(sample.chosen) ? 0.1 : 0.0;

    // Combine scores
    const baseScore = (chosenRationaleOverlap * 0.35) +
      (separation * 0.25) +
      (rStrength * 0.25) +
      actionBonus -
      (rejectedPenalty * 0.15);

    // In reduced_prompt mode, rationale is not available to the worker
    let finalScore: number;
    if (mode === 'reduced_prompt') {
      const rationaleDependency = chosenRationaleOverlap * rStrength;
      finalScore = baseScore * (1 - rationaleDependency * 0.4);
    } else {
      finalScore = baseScore;
    }

    // Clamp to 0.0–1.0 — NO checkpoint bias applied
    finalScore = Math.max(0.0, Math.min(1.0, finalScore));

    const justification = buildJustification(
      mode,
      chosenRationaleOverlap,
      rejectedPenalty,
      separation,
      rStrength,
      finalScore
    );

    return {
      sampleFingerprint: sample.sampleFingerprint,
      score: Math.round(finalScore * 1000) / 1000,
      justification,
      mode,
      evaluator: {
        type: 'structural',
        version: STRUCTURAL_SCORER_VERSION,
        checkpointRef: undefined, // structural scorer is checkpoint-agnostic
      },
    };
  },
};

// ---------------------------------------------------------------------------
// LocalModelScorerAdapter
// ---------------------------------------------------------------------------

/**
 * LocalModelScorerAdapter — real model-based evaluation via Python backend.
 *
 * This adapter delegates to an external Python evaluator backend that:
 * 1. Loads the base model + PEFT adapter from the checkpoint path
 * 2. Runs inference on each sample
 * 3. Computes preference scores based on log probability differences
 *
 * The checkpointRef is used to resolve the checkpoint path and base model.
 * Resolution is handled by the Python backend using standard paths.
 */
export const LOCAL_MODEL_SCORER_VERSION = '0.1.0';

/**
 * Default path to the evaluator backend scripts.
 */
const EVALUATOR_SCRIPTS_DIR = 'scripts/nocturnal/evaluator';

/**
 * Default base model family for evaluation (used when not specified in checkpoint).
 */
const DEFAULT_BASE_MODEL = process.env.NOCTURNAL_BASE_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct';

/**
 * Default output directory for evaluator results.
 */
const EVALUATOR_OUTPUT_DIR = '.state/nocturnal/evaluator-output';

function readEvaluatorResultFile(outputDir: string, requestId: string): any {
  const resultPath = path.join(outputDir, `eval-result-${requestId}.json`);
  if (!fs.existsSync(resultPath)) {
    throw new Error(`Evaluator result file not found: ${resultPath}`);
  }
  return JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
}

function parseEvaluatorOutput(stdout: string, outputDir: string, requestId: string): any {
  const trimmedStdout = stdout.trim();
  if (trimmedStdout) {
    try {
      return JSON.parse(trimmedStdout);
    } catch {
      // stdout may contain progress logs; fall through to result file
    }
  }
  return readEvaluatorResultFile(outputDir, requestId);
}

/**
 * Resolve a checkpointRef to its filesystem path.
 *
 * Resolution strategy:
 * 1. If checkpointRef is an existing directory, use it as-is
 * 2. If checkpointRef looks like an absolute or explicit relative path, use it
 * 3. Otherwise, search for a matching checkpoint by scanning the standard
 *    checkpoint root for a subdirectory whose metadata matches checkpointRef
 *
 * The evaluator backend expects the path to point to the checkpoint directory
 * containing the adapter/ subdirectory with adapter weights.
 */
function resolveCheckpointPath(checkpointRef: string): string {
  // Case 1: Already a valid directory - use as-is
  if (fs.existsSync(checkpointRef) && fs.lstatSync(checkpointRef).isDirectory()) {
    return checkpointRef;
  }

  // Case 2: Looks like an explicit path
  if (checkpointRef.startsWith('/') || checkpointRef.startsWith('.') || checkpointRef.includes('\\')) {
    return checkpointRef;
  }

  // Case 3: Search standard checkpoint root for matching checkpoint
  // The trainer saves checkpoints as "checkpoint-<full-uuid>/" but returns
  // "ckpt-<short-id>" as the checkpointRef. We scan for dirs whose
  // metadata.json contains a matching checkpointId.
  const standardRoot = path.join(process.cwd(), '.state', 'nocturnal', 'checkpoints');
  if (fs.existsSync(standardRoot)) {
    try {
      const entries = fs.readdirSync(standardRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const metaPath = path.join(standardRoot, entry.name, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          // Match by checkpointId or checkpointRef (which is "ckpt-" + short id)
          if (meta.checkpointId === checkpointRef ||
              meta.checkpointRef === checkpointRef ||
              (`ckpt-${meta.checkpointId.slice(0, 8)}` === checkpointRef)) {
            return path.join(standardRoot, entry.name);
          }
        }
      }
    } catch {
      // Scanning failed - fall through to return checkpointRef as-is
    }
  }

  // Fallback: return as-is (evaluator will fail with clear error)
  return checkpointRef;
}

/**
 * Call the Python evaluator backend for a batch of samples.
 *
 * This function:
 * 1. Writes an evaluation request JSON file
 * 2. Invokes the Python evaluator
 * 3. Parses and returns the result
 *
 * NOTE: This implementation scores one sample at a time by calling the backend
 * per sample. For production, batching multiple samples per call would be more efficient.
 */
async function callEvaluator(
  sample: ORPOSample,
  mode: EvalMode,
  checkpointRef: string
): Promise<{ score: number; justification: string }> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  const os = await import('os');
  const crypto = await import('crypto');

  // Resolve the checkpoint path using the registry or standard paths
  const resolvedPath = resolveCheckpointPath(checkpointRef);

  // Create request ID and temp directory
  const requestId = crypto.randomUUID();
  const tempDir = path.join(os.tmpdir(), `nocturnal-eval-${requestId}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Build evaluation request
    const request = {
      requestId,
      checkpointRef,
      checkpointPath: resolvedPath,
      baseModelName: DEFAULT_BASE_MODEL,
      samples: [
        {
          sampleFingerprint: sample.sampleFingerprint,
          prompt: sample.prompt,
          chosen: sample.chosen,
          rejected: sample.rejected,
          rationale: mode === 'reduced_prompt' ? '' : sample.rationale,
        },
      ],
      mode,
      adapterFormat: 'peft-adapter',
    };

    // Write request file
    const requestPath = path.join(tempDir, `request-${requestId}.json`);
    fs.writeFileSync(requestPath, JSON.stringify(request, null, 2), 'utf-8');

    // Ensure output directory exists
    const outputDir = path.join(process.cwd(), EVALUATOR_OUTPUT_DIR);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Call Python evaluator
    const scriptPath = path.join(process.cwd(), EVALUATOR_SCRIPTS_DIR, 'main.py');
    const cmd = `python "${scriptPath}" --request "${requestPath}" --output-dir "${outputDir}"`;

    const { stdout, stderr } = await execAsync(cmd, { timeout: 300000 }); // 5 min timeout

    if (stderr) {
      // Log warnings but don't fail on stderr
      console.error(`[evaluator] stderr: ${stderr.substring(0, 300)}`);
    }

    const result = parseEvaluatorOutput(stdout, outputDir, requestId);

    if (result.status === 'failed') {
      throw new Error(`Evaluator failed: ${result.errorMessage}`);
    }

    if (!result.scores || result.scores.length === 0) {
      throw new Error('Evaluator returned no scores');
    }

    const scoredSample = result.scores[0];
    return {
      score: scoredSample.score,
      justification: scoredSample.justification,
    };
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

export const LocalModelScorerAdapter: ScorerAdapter = {
  evaluatorType: 'local-model',
  version: LOCAL_MODEL_SCORER_VERSION,

  async score(
    sample: ORPOSample,
    mode: EvalMode,
    checkpointRef?: string
  ): Promise<ScoredSample> {
    const ref = checkpointRef ?? 'unknown';

    try {
      const result = await callEvaluator(sample, mode, ref);

      return {
        sampleFingerprint: sample.sampleFingerprint,
        score: result.score,
        justification: result.justification,
        mode,
        evaluator: {
          type: 'local-model',
          version: LOCAL_MODEL_SCORER_VERSION,
          checkpointRef: ref,
        },
      };
    } catch (err) {
      // Fail-safe: if evaluator fails, return 0.0 but log the error
      console.error(`[LocalModelScorerAdapter] Evaluation failed for ${ref}: ${err}`);
      return {
        sampleFingerprint: sample.sampleFingerprint,
        score: 0.0,
        justification: `[local-model:${mode}:${ref}] evaluation failed: ${String(err)} — returning 0.0 as fail-safe`,
        mode,
        evaluator: {
          type: 'local-model',
          version: LOCAL_MODEL_SCORER_VERSION,
          checkpointRef: ref,
        },
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Scorer Adapter Registry
// ---------------------------------------------------------------------------

export const STRUCTURAL_SCORER_TYPE = 'structural' as const;
export const LOCAL_MODEL_SCORER_TYPE = 'local-model' as const;
export type RegisteredScorerType = typeof STRUCTURAL_SCORER_TYPE | typeof LOCAL_MODEL_SCORER_TYPE;

/**
 * Get a ScorerAdapter by name.
 *
 * Available scorers:
 * - 'structural': StructuralScorerAdapter (checkpoint-agnostic, deterministic)
 * - 'local-model': LocalModelScorerAdapter (checkpoint-aware, stub — replace with real model)
 */
export function getScorerAdapter(name: string): ScorerAdapter {
  switch (name) {
    case STRUCTURAL_SCORER_TYPE:
      return StructuralScorerAdapter;
    case LOCAL_MODEL_SCORER_TYPE:
      return LocalModelScorerAdapter;
    default:
      throw new Error(
        `Unknown scorer type: "${name}". Available: ${STRUCTURAL_SCORER_TYPE}, ${LOCAL_MODEL_SCORER_TYPE}`
      );
  }
}

export const __internal = {
  parseEvaluatorOutput,
  resolveCheckpointPath,
};
