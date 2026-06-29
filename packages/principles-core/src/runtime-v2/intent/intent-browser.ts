/**
 * Browser-safe entry point for intent document utilities.
 *
 * This module re-exports ONLY the pure functions and types that are safe to
 * bundle for the browser (no node:crypto, no fs, no network). The UI bundle
 * (pd-console) imports from here instead of the full runtime-v2 barrel to
 * avoid pulling in Node.js-only modules.
 *
 * Browser-safe exports:
 *   - parseIntentDocSections / assembleIntentDoc / validateIntentDocSections
 *   - computeVersionDiff (depends only on parseIntentDocSections)
 *   - IntentDocSections / IntentDocWarning / IntentDocWarningCode / IntentLang
 *
 * NOT exported here (Node.js-only):
 *   - computeIntentContentHash (uses node:crypto — see intent-hash.ts)
 *   - IntentDocVersionStore / SqliteIntentDocVersionStore (uses sqlite)
 *   - generateIntentPatchProposal (uses agent runtime)
 */
export {
  parseIntentDocSections,
  assembleIntentDoc,
  validateIntentDocSections,
  INTENT_MAX_BYTES,
  INTENT_DOC_TEMPLATE,
  INTENT_DOC_TEMPLATE_ZH,
  INTENT_DOC_TEMPLATE_EN,
  getIntentFilename,
  createIntentTemplate,
} from './intent-doc.js';
export type {
  IntentDocSections,
  IntentDocWarning,
  IntentDocWarningCode,
  IntentLang,
} from './intent-doc.js';

export { computeVersionDiff, formatVersionSummary } from './intent-doc-version.js';
export type { IntentDocVersion, IntentDocVersionStore } from './intent-doc-version.js';
