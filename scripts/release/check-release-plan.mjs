#!/usr/bin/env node
/**
 * Final release plan + C4 guard (SPEC v1.2 §14 / Step H).
 *
 * Computes the Changesets final plan (direct changesets + internal
 * dependency propagation) for a tree and applies PD's product-assembly
 * rules on top of it:
 *
 *   C4-1  plugin release            -> installer release required
 *   C4-2  console payload change    -> installer release required
 *   C4-3  transitive plugin release -> installer release required
 *
 * The guard NEVER creates the missing version (SPEC §14.4) — it fails loud
 * so the author adds the changeset intent.
 *
 * Usage:
 *   node scripts/release/check-release-plan.mjs [--cwd <tree>] [--changed-paths-file <file>]
 *
 * --changed-paths-file supplies the PR's changed paths (C4-2 needs the
 * source diff, which the release plan alone cannot see). Without it, C4-2
 * is skipped (C4-1/C4-3 depend only on the plan).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFinalPlan } from './lib/version-plan.mjs';
import { ASSEMBLY_PAYLOAD_SOURCES, PRODUCT_ASSEMBLY_RULES } from './lib/workspace.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cwd = path.resolve(repoRoot, argValue('--cwd') ?? '.');
const changedPathsFile = argValue('--changed-paths-file');
const changedPaths = changedPathsFile
  ? fs.readFileSync(path.resolve(repoRoot, changedPathsFile), 'utf8').split('\n').filter(Boolean)
  : [];

let plan;
try {
  plan = await computeFinalPlan(cwd);
} catch (err) {
  console.error(`::error::Final release plan could not be computed (${err?.message ?? err}). A changeset declares something the workspace cannot resolve — fix the declaration.`);
  process.exit(1);
}
const inPlan = new Map(plan.releases.map((r) => [r.name, r]));
const failures = [];

for (const rule of PRODUCT_ASSEMBLY_RULES) {
  const trigger = inPlan.get(rule.when);
  if (!trigger) continue;
  const required = inPlan.get(rule.requires);
  if (!required) {
    failures.push(
      `C4: ${rule.when} has a ${trigger.type} release (${trigger.oldVersion} -> ${trigger.newVersion}) ` +
        `in the final plan, but ${rule.requires} does not. The installer bundles the plugin — ` +
        `publishing the plugin without an installer release breaks the /check vs /apply-full ` +
        `contract. Add a changeset declaring ${rule.requires}.`,
    );
  }
}

if (changedPaths.length > 0) {
  for (const src of ASSEMBLY_PAYLOAD_SOURCES) {
    const touchesPayload = changedPaths.some((p) => p.startsWith(src.path));
    if (!touchesPayload) continue;
    const required = inPlan.get(src.requires);
    if (!required) {
      failures.push(
        `C4: this PR changes ${src.path} which ships inside the ${src.requires} bundle, ` +
          `but the final release plan does not include a ${src.requires} release. ` +
          `Add a changeset declaring ${src.requires} (typically a patch).`,
      );
    }
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`::error::${f}`);
  process.exit(1);
}

console.log(
  `C4 release-plan guard PASS. Final plan: ${
    plan.releases.map((r) => `${r.name}@${r.oldVersion}->${r.newVersion} (${r.type})`).join(', ') || '(empty)'
  }`,
);
