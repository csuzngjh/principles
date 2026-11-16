#!/usr/bin/env node
/**
 * PD-SPEC-001 round 2 — Dreamer V2.1 runtime prompt snapshots + SHA-256
 * fingerprint manifest (SPEC §十 deliverables 2 and 3).
 *
 * Rebuilds the instruction from the compiled @principles/core dist across the
 * dynamic-assembly combinations, writes each variant to
 * experiment/prompt-v2/snapshots/, and records a fingerprint manifest that
 * includes:
 *  - the Owner instruction provenance SHA-256 (from the extraction step)
 *  - the committed template snapshot SHA-256
 *  - every runtime variant SHA-256
 *  - the source builder file blob SHA-256 (git hash-object semantics)
 *
 * Usage: node experiment/prompt-v2/scripts/dreamer-v21-fingerprints.mjs [--instruction-sha <sha>]
 * Requires a current build of @principles/core.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findRepoRoot } from './repo-root.mjs';

const repoRoot = findRepoRoot(import.meta.url);
const snapshotsDir = join(repoRoot, 'experiment', 'prompt-v2', 'snapshots');
const templatePath = join(snapshotsDir, 'dreamer-v2.1-prompt-template.txt');
const template = readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');

// Import the compiled builder from the worktree dist (path-safe on Windows).
const builderPath = join(repoRoot, 'packages', 'principles-core', 'dist', 'runtime', 'internalization', 'dreamer-prompt-builder.js');
const axiomPath = join(repoRoot, 'packages', 'principles-core', 'dist', 'runtime', 'core-principles', 'core-axiom-block.js');
const langPath = join(repoRoot, 'packages', 'principles-core', 'dist', 'runtime', 'language-directive.js');

const { buildDreamerProtocolInstruction } = await import(pathToFileURL(builderPath).href);
const { buildCoreAxiomBlock } = await import(pathToFileURL(axiomPath).href);
const { buildLanguageDirective } = await import(pathToFileURL(langPath).href);

const variants = [
  { name: 'plain', opts: {} },
  { name: 'core-grounding', opts: { coreGrounding: true } },
  { name: 'lang-en', opts: { outputLanguage: 'en' } },
  { name: 'lang-zh-CN', opts: { outputLanguage: 'zh-CN' } },
  { name: 'grounding+zh-CN', opts: { coreGrounding: true, outputLanguage: 'zh-CN' } },
];

mkdirSync(snapshotsDir, { recursive: true });
const manifestEntries = [];
for (const v of variants) {
  const axioms = buildCoreAxiomBlock(v.opts);
  const language = buildLanguageDirective(v.opts.outputLanguage, 'dreamer');
  const expected = template
    .replace('${coreAxiomsBlock}', () => axioms)
    .replace('${languageDirective}', () => language);
  const actual = buildDreamerProtocolInstruction(v.opts);
  if (actual !== expected) {
    console.error(`FAIL: built instruction diverges from the Owner template for variant ${v.name}`);
    process.exit(1);
  }
  const fileName = `dreamer-v2.1-runtime-prompt--${v.name}.txt`;
  writeFileSync(join(snapshotsDir, fileName), actual, 'utf8');
  manifestEntries.push({
    variant: v.name,
    file: `snapshots/${fileName}`,
    sha256: createHash('sha256').update(actual, 'utf8').digest('hex'),
  });
  console.log(`${v.name}: ${manifestEntries[manifestEntries.length - 1].sha256}`);
}

// Source builder blob SHA (same value git reports; detects any source edit).
const blobSha = execFileSync('git', ['-C', repoRoot, 'hash-object', join(repoRoot, 'packages', 'principles-core', 'src', 'runtime', 'internalization', 'dreamer-prompt-builder.ts')], { encoding: 'utf8' }).trim();

// Provenance SHA passed from the extraction step (recorded in its stdout).
const instructionShaIdx = process.argv.indexOf('--instruction-sha');
const instructionSha = instructionShaIdx > -1 ? process.argv[instructionShaIdx + 1] : null;

const manifest = {
  generatedAt: new Date().toISOString(),
  spec: 'PD-SPEC-001 round 2 — Dreamer V2.1',
  ownerInstructionProvenance: {
    note: 'SHA-256 of the pasted Owner instruction file the template was extracted from (see extract-dreamer-v21-template.mjs output).',
    sha256: instructionSha,
  },
  templateSnapshot: { file: 'snapshots/dreamer-v2.1-prompt-template.txt', sha256: createHash('sha256').update(template, 'utf8').digest('hex') },
  sourceBuilder: { file: 'packages/principles-core/src/runtime/internalization/dreamer-prompt-builder.ts', gitBlobSha256: blobSha },
  distUsed: 'packages/principles-core/dist (rebuilt for this worktree)',
  variants: manifestEntries,
};
const manifestPath = join(snapshotsDir, 'dreamer-v2.1-fingerprints.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
console.log('manifest written:', manifestPath);
console.log('template sha256:', manifest.templateSnapshot.sha256);
console.log('builder blob sha256:', blobSha);
