/**
 * PD-SPEC-001 round 2 — Dreamer V2.1 verbatim guarantee.
 *
 * Owner directive: "Prompt V2.1 必须使用本指令提供的原文。不得让本地 AI 自行
 * 重新创作、缩写、润色、删除或替换任何规则。"
 *
 * The committed snapshot
 * `experiment/prompt-v2/snapshots/dreamer-v2.1-prompt-template.txt` was
 * extracted programmatically from the Owner instruction (no manual
 * transcription; provenance SHA-256 recorded by
 * experiment/prompt-v2/scripts/extract-dreamer-v21-template.mjs). This test
 * rebuilds the instruction across every dynamic-assembly combination and
 * requires byte equality with the snapshot after substituting the two dynamic
 * blocks back into their placeholders. Any prompt-text drift fails here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDreamerProtocolInstruction } from '../dreamer-prompt-builder.js';
import { buildCoreAxiomBlock } from '../../core-principles/core-axiom-block.js';
import { buildLanguageDirective } from '../../language-directive.js';
import type { CoreAxiomBlockOptions } from '../../core-principles/core-axiom-block.js';
import type { OutputLanguage } from '../../language-directive.js';

const SNAPSHOT_URL = new URL(
  '../../../../../../experiment/prompt-v2/snapshots/dreamer-v2.1-prompt-template.txt',
  import.meta.url,
);

// Line-ending normalization only: git checkout may materialize CRLF; the
// template content itself is compared byte-for-byte after this normalization.
const SNAPSHOT = readFileSync(fileURLToPath(SNAPSHOT_URL), 'utf8').replace(/\r\n/g, '\n');

if (!SNAPSHOT.includes('${coreAxiomsBlock}') || !SNAPSHOT.includes('${languageDirective}')) {
  throw new Error(
    'dreamer-v2.1-prompt-template.txt is missing the dynamic placeholders — ' +
      'the snapshot is corrupt or was replaced; regenerate it with ' +
      'extract-dreamer-v21-template.mjs before running this suite.',
  );
}

/** Substitute the two dynamic blocks back into the snapshot placeholders. */
function expectedFor(opts: CoreAxiomBlockOptions & { outputLanguage?: OutputLanguage }): string {
  const axioms = buildCoreAxiomBlock(opts);
  const language = buildLanguageDirective(opts.outputLanguage, 'dreamer');
  // Function-form replacement: the dynamic blocks must never be interpreted
  // as replacement patterns ($&, $1, ...).
  return SNAPSHOT.replace('${coreAxiomsBlock}', () => axioms).replace('${languageDirective}', () => language);
}

describe('Dreamer V2.1 verbatim snapshot (PD-SPEC-001 round 2)', () => {
  const variants: { name: string; opts: CoreAxiomBlockOptions & { outputLanguage?: OutputLanguage } }[] = [
    { name: 'plain (no axioms, no language directive)', opts: {} },
    { name: 'coreGrounding=true', opts: { coreGrounding: true } },
    { name: 'outputLanguage=en', opts: { outputLanguage: 'en' } },
    { name: 'outputLanguage=zh-CN', opts: { outputLanguage: 'zh-CN' } },
    { name: 'coreGrounding=true + outputLanguage=zh-CN', opts: { coreGrounding: true, outputLanguage: 'zh-CN' } },
  ];

  for (const v of variants) {
    it(`instruction is byte-identical to the Owner template: ${v.name}`, () => {
      const actual = buildDreamerProtocolInstruction(v.opts);
      const expected = expectedFor(v.opts);
      expect(actual).toBe(expected);
    });
  }

  it('snapshot is non-empty and keeps the V2.1 section structure', () => {
    expect(SNAPSHOT.length).toBeGreaterThan(5000);
    for (const section of [
      'ROLE BOUNDARY',
      'INPUT AND EVIDENCE DISCIPLINE',
      'EXPLORATION BEFORE SELECTION',
      'CANDIDATE DIVERSITY AND DISTINCTNESS',
      'CANDIDATE COUNT AND SELECTION',
      'CANDIDATE CONSTRUCTION',
      'CANDIDATE QUALITY REVIEW',
      'OUTPUT CONTRACT — MUST REMAIN UNCHANGED',
    ]) {
      expect(SNAPSHOT).toContain(section);
    }
  });
});
