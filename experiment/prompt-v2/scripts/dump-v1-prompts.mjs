/**
 * PD-SPEC-001 Phase 0 — V1 runtime prompt snapshot dumper.
 *
 * Drives the six prompt builders from a WORKTREE DIST and writes every
 * flag-variant systemPrompt + SHA-256. Deterministic fixtures only.
 *
 * Usage (from anywhere):
 *   node experiment/prompt-v2/scripts/dump-v1-prompts.mjs                        # current repo, current dist
 *   node experiment/prompt-v2/scripts/dump-v1-prompts.mjs \
 *        --worktree <V1-arm-worktree> --out experiment/prompt-v2/baseline       # re-execute at the V1 base
 *
 * `--worktree` pins BOTH the git-clean assertion and the dist import to that
 * worktree (a V1-baseline dump must run against V1 code, never this branch's
 * dist); `--out` redirects the artifacts (defaults to this repo's baseline/).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { findRepoRoot } from './repo-root.mjs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const worktreeOverride = opt('--worktree');
const outOverride = opt('--out');

const repoRoot = findRepoRoot(import.meta.url);
const worktree = worktreeOverride ? path.resolve(worktreeOverride) : repoRoot;
const dist = (p) => path.join(worktree, 'packages/principles-core/dist', p);
const outDir = path.resolve(outOverride ?? path.join(repoRoot, 'experiment/prompt-v2/baseline'));

const { buildRootCauseProtocolInstruction } = await import('file://' + dist('runtime/diagnostician/rootcause-prompt-builder.js').replace(/\\/g, '/'));
const { buildDistillerProtocolInstruction } = await import('file://' + dist('runtime/diagnostician/distiller-prompt-builder.js').replace(/\\/g, '/'));
const { RouterPromptBuilder } = await import('file://' + dist('runtime/diagnostician/router-prompt-builder.js').replace(/\\/g, '/'));
const { buildDreamerProtocolInstruction } = await import('file://' + dist('runtime/internalization/dreamer-prompt-builder.js').replace(/\\/g, '/'));
const { buildPhilosopherProtocolInstruction } = await import('file://' + dist('runtime/internalization/philosopher-prompt-builder.js').replace(/\\/g, '/'));
const { buildScribeProtocolInstruction, SCRIBE_PROMPT_CONTRACT_VERSION } = await import('file://' + dist('runtime/internalization/scribe-prompt-builder.js').replace(/\\/g, '/'));

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree }).toString().trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: worktree }).toString().trim();
if (dirty !== '') {
  console.error(`worktree is dirty — refuse to snapshot a non-clean baseline:\n${dirty}`);
  process.exit(1);
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const correctionEvidence = {
  text: 'FIXTURE_OWNER_CORRECTION_VERBATIM',
  sessionId: 'fixture-session',
  turnIndex: 2,
  occurredAt: '2026-01-01T00:00:00Z',
};
const anchor = { type: 'owner_expectation', ref: 'fixture-anchor-ref' };

const variants = [
  {
    agent: 'rootcause',
    name: 'base',
    flags: {},
    build: () => buildRootCauseProtocolInstruction({}),
  },
  {
    agent: 'rootcause',
    name: 'owner-correction',
    flags: { correctionEvidence: true },
    build: () => buildRootCauseProtocolInstruction({ correctionEvidence }),
  },
  {
    agent: 'rootcause',
    name: 'anchor',
    flags: { anchor: true },
    build: () => buildRootCauseProtocolInstruction({ anchor }),
  },
  {
    agent: 'rootcause',
    name: 'core-grounding',
    flags: { coreGrounding: true },
    build: () => buildRootCauseProtocolInstruction({ coreGrounding: true }),
  },
  {
    agent: 'rootcause',
    name: 'intent-grounding',
    flags: { intentGrounding: true },
    build: () => buildRootCauseProtocolInstruction({ intentGrounding: true }),
  },
  {
    agent: 'rootcause',
    name: 'evidence-first-attribution',
    flags: { evidenceFirstAttribution: true },
    build: () => buildRootCauseProtocolInstruction({ evidenceFirstAttribution: true }),
  },
  {
    agent: 'rootcause',
    name: 'all-on',
    flags: { correctionEvidence: true, anchor: true, coreGrounding: true, intentGrounding: true, evidenceFirstAttribution: true },
    build: () => buildRootCauseProtocolInstruction({
      correctionEvidence, anchor, coreGrounding: true, intentGrounding: true, evidenceFirstAttribution: true,
    }),
  },
  {
    // 19th variant: the PRODUCTION combination (core grounding + evidence-first
    // attribution) — parity with the V2 dump so every production-config prompt
    // has a strict V1↔V2 pair (remediation Phase 3 §6.3).
    agent: 'rootcause',
    name: 'production-default',
    flags: { coreGrounding: true, evidenceFirstAttribution: true },
    build: () => buildRootCauseProtocolInstruction({ coreGrounding: true, evidenceFirstAttribution: true }),
  },
  {
    agent: 'distiller',
    name: 'base',
    flags: {},
    build: () => buildDistillerProtocolInstruction({}),
  },
  {
    agent: 'distiller',
    name: 'core-grounding',
    flags: { coreGrounding: true },
    build: () => buildDistillerProtocolInstruction({ coreGrounding: true }),
  },
  {
    agent: 'router',
    name: 'base',
    flags: {},
    build: () => new RouterPromptBuilder().buildRouterInstruction({}),
  },
  {
    agent: 'dreamer',
    name: 'base',
    flags: {},
    build: () => buildDreamerProtocolInstruction({}),
  },
  {
    agent: 'dreamer',
    name: 'core-grounding',
    flags: { coreGrounding: true },
    build: () => buildDreamerProtocolInstruction({ coreGrounding: true }),
  },
  {
    agent: 'philosopher',
    name: 'base',
    flags: {},
    build: () => buildPhilosopherProtocolInstruction({}),
  },
  {
    agent: 'philosopher',
    name: 'core-grounding',
    flags: { coreGrounding: true },
    build: () => buildPhilosopherProtocolInstruction({ coreGrounding: true }),
  },
  {
    agent: 'scribe',
    name: 'base',
    flags: {},
    build: () => buildScribeProtocolInstruction({}),
  },
  {
    agent: 'scribe',
    name: 'core-grounding',
    flags: { coreGrounding: true },
    build: () => buildScribeProtocolInstruction({ coreGrounding: true }),
  },
  {
    agent: 'scribe',
    name: 'formation-evidence',
    flags: { formationEvidence: true },
    build: () => buildScribeProtocolInstruction({ formationEvidence: true }),
  },
  {
    agent: 'scribe',
    name: 'formation-evidence+core-grounding',
    flags: { formationEvidence: true, coreGrounding: true },
    build: () => buildScribeProtocolInstruction({ formationEvidence: true, coreGrounding: true }),
  },
];

// Prompt-affecting source modules (frozen-in-place evidence for V1).
const sourceFiles = [
  'packages/principles-core/src/runtime/diagnostician/rootcause-prompt-builder.ts',
  'packages/principles-core/src/runtime/diagnostician/distiller-prompt-builder.ts',
  'packages/principles-core/src/runtime/diagnostician/router-prompt-builder.ts',
  'packages/principles-core/src/runtime/internalization/dreamer-prompt-builder.ts',
  'packages/principles-core/src/runtime/internalization/philosopher-prompt-builder.ts',
  'packages/principles-core/src/runtime/internalization/scribe-prompt-builder.ts',
  'packages/principles-core/src/runtime/adapter/schema-prompt-adapter.ts',
  'packages/principles-core/src/runtime/core-principles/core-axiom-block.ts',
  'packages/principles-core/src/runtime/language-directive.ts',
];

const promptDir = path.join(outDir, 'runtime-prompts');
mkdirSync(promptDir, { recursive: true });

const records = [];
for (const v of variants) {
  const systemPrompt = v.build();
  const file = `runtime-prompts/${v.agent}.${v.name}.txt`;
  writeFileSync(path.join(outDir, file), systemPrompt, 'utf8');
  records.push({
    agent: v.agent,
    variant: v.name,
    flags: v.flags,
    file,
    sha256: sha256(systemPrompt),
    chars: systemPrompt.length,
  });
}

const manifest = {
  spec: 'PD-SPEC-001',
  phase: '0b — V1 runtime prompt baseline',
  baseCommit: head,
  baseRef: 'origin/main @ worktree ai/adhoc-20261115-prompt-v2-k4wz9t',
  scribePromptContractVersion: SCRIBE_PROMPT_CONTRACT_VERSION,
  notes: [
    'systemPrompt is payload-independent (static per flag combination); payload/message structure is documented in PROMPT_V1_BASELINE.md.',
    'outputLanguage directive omitted (production default at snapshot time); builders append a language directive when configured.',
    'Dumped from the worktree DIST build of the pinned base commit (clean tree asserted).',
  ],
  sourceFileSha256: Object.fromEntries(
    sourceFiles.map((f) => [f, sha256(readFileSync(path.join(worktree, f), 'utf8'))]),
  ),
  prompts: records,
};

writeFileSync(path.join(outDir, 'prompt-hashes.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`base=${head.slice(0, 10)} variants=${records.length} -> ${path.relative(worktree, outDir)}`);
for (const r of records) {
  console.log(`${r.agent}.${r.variant}  ${r.sha256.slice(0, 16)}  ${r.chars} chars`);
}
