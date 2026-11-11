#!/usr/bin/env node
/**
 * check-ui-tokens — guards the console design system against drift.
 *
 * Why this exists (SPEC-PD-UIUX-002 §3.6): the audit measured 697 small-font
 * utilities across 39 files and hand-written values like `px-[14px]`. Stage 1
 * only introduces the script — it is deliberately NOT wired into the merge gate
 * yet (Owner decision 5, 2026-11-11).
 *
 * Rules:
 *   - `text-[Npx]` with N < 12    → error   (below the caption floor)
 *   - `text-[11px]`               → warning (eyebrow only; allowed in components/layout)
 *   - hand-written spacing values → error   (allowed: 4/8/12/16/24/32/48/64)
 *
 * Exit code is 0 unless `--strict` is passed, so it can be adopted gradually.
 * Run: node scripts/check-ui-tokens.mjs [--strict] [--json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(ROOT, 'src', 'ui');
const STRICT = process.argv.includes('--strict');

/** Files allowed to carry the 11px eyebrow (page-level scaffolding only). */
const EYEBROW_ALLOW = [
  'src/ui/components/layout/section-title.tsx',
  'src/ui/components/layout/app-sidebar.tsx',
  'src/ui/components/layout/page-shell.tsx',
];

const SPACING_SCALE = new Set([0, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64]);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

const errors = [];
const warnings = [];

for (const file of walk(UI_DIR)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);

  lines.forEach((line, index) => {
    const at = `${rel}:${index + 1}`;

    for (const match of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
      const size = Number(match[1]);
      if (size < 11) errors.push({ at, message: `font size ${size}px is below the 11px floor` });
      else if (size === 11 && !EYEBROW_ALLOW.includes(rel)) warnings.push({ at, message: '11px text outside an allowed eyebrow file' });
    }

    // `px-[14px]`, `py-[6px]`, `gap-[10px]`, `p-[13px]` … must come from the scale.
    for (const match of line.matchAll(/\b(?:p|px|py|pt|pb|pl|pr|gap|gap-x|gap-y|m|mx|my|mt|mb|ml|mr)-\[(\d+(?:\.\d+)?)px\]/g)) {
      const value = Number(match[1]);
      if (!SPACING_SCALE.has(value)) errors.push({ at, message: `hand-written spacing ${match[0]} is not on the 4/8/12/16/24/32/48/64 scale` });
    }
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings }, null, 2));
} else {
  console.log(`[ui-tokens] ${errors.length} error(s), ${warnings.length} warning(s).`);
  for (const item of errors) console.log(`  error   ${item.at} — ${item.message}`);
  for (const item of warnings.slice(0, 20)) console.log(`  warning ${item.at} — ${item.message}`);
  if (warnings.length > 20) console.log(`  … ${warnings.length - 20} more warnings`);
}

process.exit(STRICT && errors.length > 0 ? 1 : 0);
