#!/usr/bin/env node
/**
 * NARRATION_ZH.md is generated from VOICEOVER_ZH.json so the two can never diverge.
 * Edit the JSON, run this, never hand-edit the markdown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const spec = JSON.parse(fs.readFileSync(path.join(PROJECT, 'VOICEOVER_ZH.json'), 'utf8'));

const out = [
  '# V5 中文旁白（冻结文本）',
  '',
  '> 由 `VOICEOVER_ZH.json` 生成，请勿手改；任何改动都要先改 JSON 再运行 `node scripts/gen-narration.mjs`。',
  '',
];
for (const chapter of spec.chapters) {
  out.push(`## ${chapter.id.toUpperCase()} · ${chapter.title}`, '');
  for (const line of chapter.lines) out.push(line.text, '');
}
fs.writeFileSync(path.join(PROJECT, 'NARRATION_ZH.md'), `${out.join('\n').trimEnd()}\n`, 'utf8');
console.log(`NARRATION_ZH.md: ${spec.chapters.length} chapters, ${spec.chapters.reduce((n, c) => n + c.lines.length, 0)} lines`);
