/**
 * Nocturnal Benchmark — Core Testable API
 * ========================================
 *
 * Re-exports the testable portions of the benchmark library.
 * Import this from tests instead of the individual modules.
 */

export {
  structuralScore,
  structuralScorer,
  STRUCTURAL_SCORER_VERSION,
  getScorer,
} from './scorer.js';

export {
  selectHoldout,
  excludeTrainingSet,
  computeHoldoutFingerprint,
  verifyHoldoutConsistency,
  createTrainEvalSplit,
} from './holdout-selector.js';

export {
  readResult,
  readMeta,
  readResultFromPath,
  writeResult,
  writeMeta,
  listResults,
  validateResult,
  checkComparability,
  computeDelta,
  ensureEvalsDir,
} from './result-store.js';

export {
  computeMetrics,
  computeBenchmarkId,
  computeHoldoutFingerprint as computeHoldoutFp,
} from './types.js';
