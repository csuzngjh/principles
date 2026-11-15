/**
 * PD-SPEC-001 Phase 1 — V2 runtime prompt snapshot dumper (remediation v2).
 *
 * Same variant matrix as dump-v1-prompts.mjs (19 variants incl. the
 * production-default rootcause combination) so every prompt has a strict
 * V1↔V2 pair. Usable as CLI or as a library (preflight imports
 * computeVariants() to fingerprint the running code against the manifest).
 *
 * Usage:
 *   node experiment/prompt-v2/scripts/dump-v2-prompts.mjs [--worktree <dir>] [--out <dir>]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL as realPathToFileURL } from 'node:url';
import { findRepoRoot } from './repo-root.mjs';

const pathToFileURL = (p) => 'file://' + p.replace(/\\/g, '/');
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export async function loadBuilders(worktree) {
  const dist = (p) => path.join(worktree, 'packages/principles-core/dist', p);
  return {
    rootcause: (await import(pathToFileURL(dist('runtime/diagnostician/rootcause-prompt-builder.js')))).buildRootCauseProtocolInstruction,
    distiller: (await import(pathToFileURL(dist('runtime/diagnostician/distiller-prompt-builder.js')))).buildDistillerProtocolInstruction,
    router: (await import(pathToFileURL(dist('runtime/diagnostician/router-prompt-builder.js')))).RouterPromptBuilder,
    dreamer: (await import(pathToFileURL(dist('runtime/internalization/dreamer-prompt-builder.js')))).buildDreamerProtocolInstruction,
    philosopher: (await import(pathToFileURL(dist('runtime/internalization/philosopher-prompt-builder.js')))).buildPhilosopherProtocolInstruction,
    scribe: (await import(pathToFileURL(dist('runtime/internalization/scribe-prompt-builder.js')))).buildScribeProtocolInstruction,
    scribeVersion: (await import(pathToFileURL(dist('runtime/internalization/scribe-prompt-builder.js')))).SCRIBE_PROMPT_CONTRACT_VERSION,
  };
}

const correctionEvidence = { text: 'FIXTURE_OWNER_CORRECTION_VERBATIM', sessionId: 'fixture-session', turnIndex: 2, occurredAt: '2026-01-01T00:00:00Z' };
const anchor = { type: 'owner_expectation', ref: 'fixture-anchor-ref' };

/** The full 19-variant matrix (identical to dump-v1-prompts.mjs). */
export function computeVariants(B) {
  return [
    { agent: 'rootcause', name: 'base', build: () => B.rootcause({}) },
    { agent: 'rootcause', name: 'owner-correction', build: () => B.rootcause({ correctionEvidence }) },
    { agent: 'rootcause', name: 'anchor', build: () => B.rootcause({ anchor }) },
    { agent: 'rootcause', name: 'core-grounding', build: () => B.rootcause({ coreGrounding: true }) },
    { agent: 'rootcause', name: 'intent-grounding', build: () => B.rootcause({ intentGrounding: true }) },
    { agent: 'rootcause', name: 'evidence-first-attribution', build: () => B.rootcause({ evidenceFirstAttribution: true }) },
    { agent: 'rootcause', name: 'all-on', build: () => B.rootcause({ correctionEvidence, anchor, coreGrounding: true, intentGrounding: true, evidenceFirstAttribution: true }) },
    { agent: 'rootcause', name: 'production-default', build: () => B.rootcause({ coreGrounding: true, evidenceFirstAttribution: true }) },
    { agent: 'distiller', name: 'base', build: () => B.distiller({}) },
    { agent: 'distiller', name: 'core-grounding', build: () => B.distiller({ coreGrounding: true }) },
    { agent: 'router', name: 'base', build: () => new B.router().buildRouterInstruction({}) },
    { agent: 'dreamer', name: 'base', build: () => B.dreamer({}) },
    { agent: 'dreamer', name: 'core-grounding', build: () => B.dreamer({ coreGrounding: true }) },
    { agent: 'philosopher', name: 'base', build: () => B.philosopher({}) },
    { agent: 'philosopher', name: 'core-grounding', build: () => B.philosopher({ coreGrounding: true }) },
    { agent: 'scribe', name: 'base', build: () => B.scribe({}) },
    { agent: 'scribe', name: 'core-grounding', build: () => B.scribe({ coreGrounding: true }) },
    { agent: 'scribe', name: 'formation-evidence', build: () => B.scribe({ formationEvidence: true }) },
    { agent: 'scribe', name: 'formation-evidence+core-grounding', build: () => B.scribe({ formationEvidence: true, coreGrounding: true }) },
  ];
}

export async function computePromptFingerprint(worktree) {
  const B = await loadBuilders(worktree);
  const variants = computeVariants(B);
  return {
    scribePromptContractVersion: B.scribeVersion,
    prompts: variants.map((v) => {
      const text = v.build();
      return { agent: v.agent, variant: v.name, sha256: sha256(text), chars: text.length };
    }),
  };
}

export async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const repoRoot = findRepoRoot(import.meta.url);
  const worktree = opt('--worktree') ? path.resolve(opt('--worktree')) : repoRoot;
  const outDir = path.resolve(opt('--out') ?? path.join(repoRoot, 'experiment/prompt-v2/prompts'));

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree }).toString().trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: worktree }).toString().trim();
  if (dirty !== '') {
    console.error(`worktree is dirty — refuse to snapshot:\n${dirty}`);
    process.exit(1);
  }

  const B = await loadBuilders(worktree);
  const variants = computeVariants(B);
  const promptDir = path.join(outDir, 'runtime-prompts');
  mkdirSync(promptDir, { recursive: true });

  const records = [];
  for (const v of variants) {
    const systemPrompt = v.build();
    const file = `runtime-prompts/${v.agent}.${v.name}.txt`;
    writeFileSync(path.join(outDir, file), systemPrompt, 'utf8');
    records.push({ agent: v.agent, variant: v.name, file, sha256: sha256(systemPrompt), chars: systemPrompt.length });
  }
  // SPEC §10.1 canonical file names ← production-default variant per agent.
  const productionDefault = { rootcause: 'production-default', distiller: 'core-grounding', router: 'base', dreamer: 'core-grounding', philosopher: 'core-grounding', scribe: 'formation-evidence+core-grounding' };
  for (const [agent, variant] of Object.entries(productionDefault)) {
    copyFileSync(path.join(promptDir, `${agent}.${variant}.txt`), path.join(outDir, `${agent}-v2.txt`));
  }

  const baselinePath = path.join(repoRoot, 'experiment/prompt-v2/baseline/prompt-hashes.json');
  let v1ByFile = new Map();
  if (fs.existsSync(baselinePath)) {
    const v1 = JSON.parse(readFileSync(baselinePath, 'utf8'));
    v1ByFile = new Map(v1.prompts.map((p) => [`${p.agent}.${p.variant}`, p.sha256]));
  }
  const deltas = records.map((r) => {
    const key = `${r.agent}.${r.variant}`;
    const v1Hash = v1ByFile.get(key);
    const v1Chars = v1ByFile.size ? (JSON.parse(readFileSync(baselinePath, 'utf8')).prompts.find((p) => `${p.agent}.${p.variant}` === key)?.chars ?? null) : null;
    return { agent: r.agent, variant: r.variant, changed: v1Hash === undefined ? null : v1Hash !== r.sha256, v1Chars, v2Chars: r.chars };
  });

  const manifest = {
    spec: 'PD-SPEC-001',
    phase: '1 — V2 runtime prompt snapshot',
    v2WorktreeHead: head,
    scribePromptContractVersion: B.scribeVersion,
    notes: [
      'Same 19-variant matrix as baseline/ for strict V1↔V2 pairing.',
      'The prompt VERSION fingerprint is this manifest: preflight recomputes it from the arm dist and requires an exact match.',
    ],
    prompts: records,
    v1VsV2: deltas,
  };
  writeFileSync(path.join(outDir, 'prompt-hashes-v2.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`v2=${head.slice(0, 10)} variants=${records.length} -> ${outDir}`);
  for (const d of deltas) console.log(`${d.agent}.${d.variant}: changed=${d.changed} chars ${d.v1Chars ?? '-'} -> ${d.v2Chars}`);
}

if (process.argv[1] && realPathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
