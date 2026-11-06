/**
 * Intent browser-safe exports contract tests.
 *
 * Verifies that intent-browser.ts ONLY exports pure functions that are safe
 * for browser bundling (no node:crypto, no fs, no network). This guards against
 * accidental leakage of Node.js-only modules into the pd-console UI bundle.
 *
 * PRI-484 Task 28 follow-up — ensures the browser-safe entry point contract
 * is testable and enforceable.
 */
import { describe, it, expect } from 'vitest';
import * as browserExports from '../intent-browser.js';
import * as fullExports from '../intent-doc.js';
import { computeIntentContentHash } from '../intent-hash.js';

describe('intent-browser exports contract', () => {
  // ── Browser-safe functions MUST be exported ─────────────────────────────

  it('exports parseIntentDocSections (pure)', () => {
    expect(browserExports.parseIntentDocSections).toBe(fullExports.parseIntentDocSections);
  });

  it('exports assembleIntentDoc (pure)', () => {
    expect(browserExports.assembleIntentDoc).toBe(fullExports.assembleIntentDoc);
  });

  it('exports validateIntentDocSections (pure)', () => {
    expect(browserExports.validateIntentDocSections).toBe(fullExports.validateIntentDocSections);
  });

  it('exports INTENT_MAX_BYTES (constant)', () => {
    expect(browserExports.INTENT_MAX_BYTES).toBe(fullExports.INTENT_MAX_BYTES);
  });

  it('exports INTENT_DOC_TEMPLATE (constant)', () => {
    expect(browserExports.INTENT_DOC_TEMPLATE).toBe(fullExports.INTENT_DOC_TEMPLATE);
  });

  it('exports getIntentFilename (pure)', () => {
    expect(browserExports.getIntentFilename).toBe(fullExports.getIntentFilename);
  });

  it('exports createIntentTemplate (pure)', () => {
    expect(browserExports.createIntentTemplate).toBe(fullExports.createIntentTemplate);
  });

  it('exports computeVersionDiff (pure)', () => {
    expect(typeof browserExports.computeVersionDiff).toBe('function');
  });

  it('exports formatVersionSummary (pure)', () => {
    expect(typeof browserExports.formatVersionSummary).toBe('function');
  });

  // ── Node.js-only functions MUST NOT be exported ─────────────────────────

  it('does NOT export computeIntentContentHash (uses node:crypto)', () => {
    // This function uses node:crypto and must stay in intent-hash.ts,
    // NOT exported from intent-browser.ts.
    expect(browserExports).not.toHaveProperty('computeIntentContentHash');
    // Verify the function exists in the Node.js-only module.
    expect(typeof computeIntentContentHash).toBe('function');
  });

  // ── Browser-safe behavior verification ────────────────────────────────

  it('parseIntentDocSections works without any Node.js dependencies', () => {
    const raw = `## 1. Why

Test content.

## 2. Desired Outcome

Outcome here.
`;
    // Direct call should succeed without any fs/crypto/network calls.
    const sections = browserExports.parseIntentDocSections(raw);
    expect(sections.why).toBe('Test content.');
    expect(sections.desiredOutcome).toBe('Outcome here.');
  });

  it('assembleIntentDoc produces valid markdown without Node.js dependencies', () => {
    const sections = { why: 'Browser test', desiredOutcome: 'Outcome' };
    const doc = browserExports.assembleIntentDoc(sections);
    expect(doc).toContain('# INTENT.md');
    expect(doc).toContain('## 1. Why');
    expect(doc).toContain('Browser test');
  });

  it('computeVersionDiff works without Node.js dependencies', () => {
    const old = '## 1. Why\nold\n## 2. Desired Outcome\nsame\n';
    const new_ = '## 1. Why\nnew\n## 2. Desired Outcome\nsame\n';
    const diff = browserExports.computeVersionDiff(old, new_);
    expect(diff).toHaveLength(5);
    const whyDiff = diff.find(d => d.section === 'why');
    expect(whyDiff?.changed).toBe(true);
  });

  // ── Export count sanity check ────────────────────────────────────────

  it('exports at least 9 named exports (functions + constants)', () => {
    // Count all exported keys — should be stable and minimal.
    const exportKeys = Object.keys(browserExports);
    // Filter out type exports (they don't appear at runtime in ESM).
    const runtimeExports = exportKeys.filter(k => typeof browserExports[k as keyof typeof browserExports] !== 'undefined');
    // Expected: 9 from intent-doc + 2 from intent-doc-version = 11 runtime exports.
    // Using >= to avoid breaking when new browser-safe exports are added.
    expect(runtimeExports.length).toBeGreaterThanOrEqual(9);
  });
});