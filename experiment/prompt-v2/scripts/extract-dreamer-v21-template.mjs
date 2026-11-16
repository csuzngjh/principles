#!/usr/bin/env node
/**
 * Extract the Owner-provided Dreamer V2.1 prompt template from the PD-SPEC-001
 * V2.1 instruction (the pasted instruction file) and write it as the committed
 * snapshot. The template is extracted verbatim between the ```typescript fence
 * and the closing fence of section 四 — no manual transcription.
 *
 * Provenance: the source instruction file's SHA-256 is recorded in the output.
 *
 * Usage: node experiment/prompt-v2/scripts/extract-dreamer-v21-template.mjs <instruction-file>
 * Writes: experiment/prompt-v2/snapshots/dreamer-v2.1-prompt-template.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from './repo-root.mjs';

const [, , instructionFile] = process.argv;
if (!instructionFile) {
  console.error('usage: extract-dreamer-v21-template.mjs <instruction-file>');
  process.exit(2);
}

const repoRoot = findRepoRoot(import.meta.url);
const raw = readFileSync(resolve(instructionFile), 'utf8');
const lines = raw.split(/\r?\n/);

// Locate the fenced typescript block inside section 四 (the Dreamer V2.1 prompt).
const fenceStart = lines.findIndex(l => l.trim() === '```typescript');
const fenceEndRelative = lines.findIndex((l, i) => i > fenceStart && l.trim() === '```');
if (fenceStart < 0 || fenceEndRelative < 0) {
  console.error('FAIL: typescript fence not found in instruction file');
  process.exit(1);
}
// The fenced body must contain the Dreamer V2.1 opening line.
const body = lines.slice(fenceStart + 1, fenceEndRelative);
if (!body.some(l => l.includes('You are a Dreamer agent in a principle internalization pipeline.'))) {
  console.error('FAIL: fenced block is not the Dreamer V2.1 template');
  process.exit(1);
}
if (!body.some(l => l.includes('${coreAxiomsBlock}')) || !body.some(l => l.includes('${languageDirective}'))) {
  console.error('FAIL: template is missing the dynamic injection placeholders');
  process.exit(1);
}
// The template body inside the SPEC fence starts with "return `" and ends with "`;"
const first = body[0];
const last = body[body.length - 1];
if (!first.trim().startsWith('return `') || !last.trim().endsWith('`;')) {
  console.error('FAIL: unexpected fence body shape (expected `return \\`...\\`;`)');
  process.exit(1);
}
const template = first.trim().slice('return `'.length) + '\n' + body.slice(1, -1).join('\n') + '\n' +
  last.trim().slice(0, -';'.length - 1);

const sha = createHash('sha256').update(raw, 'utf8').digest('hex');
const outDir = join(repoRoot, 'experiment', 'prompt-v2', 'snapshots');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'dreamer-v2.1-prompt-template.txt');
writeFileSync(outPath, template, 'utf8');
console.log('written:', outPath);
console.log('instruction-file-sha256:', sha);
console.log('template-sha256:', createHash('sha256').update(template, 'utf8').digest('hex'));
