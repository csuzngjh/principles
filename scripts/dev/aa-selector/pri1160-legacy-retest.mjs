#!/usr/bin/env node
/**
 * PRI-1160 minimal retest harness — legacy-stock governance (Owner decisions pending).
 *
 * PRE  : freezes the baseline = ORDINARY Native (no mapping) final directive text
 *        over a LOCAL sandbox copy of the workspace, through the CURRENT shared
 *        assembly entry, with the same 20 rounds (budgets + rotation) as the
 *        frozen PRI-1105 B-line baseline.
 * POST : after the Owner governs the items in the official Console, take a new
 *        consistent snapshot into a sandbox and run with --pre <frozen pre report>.
 *        The comparison below is fixed in advance; until then POST is NOT RUN.
 *
 * Identity is the principleId hash (sha256[0:12]) because a restore or revision
 * regenerates activation ids. Output is desensitized: hashes, counts, chars.
 * Zero model calls, zero network; the production workspace is never opened.
 * Tokens: unknown (no reliable tokenizer).
 *
 * Usage (repository root, host-runtime built):
 *   node scripts/dev/aa-selector/pri1160-legacy-retest.mjs --ws <sandbox> --items <items.tsv> --out <report.json>
 *     [--pre <frozen pre report.json>] [--baseline-ref <B-line baseline report.json>]
 * items.tsv: one line per governed item: <activationId>\t<artifactId>\t<12-hex principleId hash>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildActivePrinciplePromptContext, readPromptActivationCandidates } from '@principles/host-runtime';
import { resolvePromptBudget, measureSharedDirectiveBlockChars, sharedDirectiveBaseChars } from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const short = (text) => sha256(text).slice(0, 12);
const fileSha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function parseArgs(argv) {
  const args = { ws: null, items: null, out: null, pre: null, baselineRef: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--ws') { args.ws = value; i += 1; }
    else if (key === '--items') { args.items = value; i += 1; }
    else if (key === '--out') { args.out = value; i += 1; }
    else if (key === '--pre') { args.pre = value; i += 1; }
    else if (key === '--baseline-ref') { args.baselineRef = value; i += 1; }
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!args.ws || !args.items || !args.out) throw new Error('--ws, --items and --out are required');
  return args;
}

/** Same inputs, budgets and rotation as the frozen PRI-1105 B-line baseline. */
const ROUNDS = [
  ...Array.from({ length: 18 }, (_, k) => ({ label: `4000-k${k + 1}`, budgetChars: 4000, roundKey: k + 1 })),
  { label: '4000-FIFO', budgetChars: 4000, roundKey: undefined },
  { label: '15625-k1', budgetChars: 15625, roundKey: 1 },
];

async function snapshotRounds(workspaceDir) {
  const read = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
  if (read.aborted || read.warnings.length > 0) {
    throw new Error(`governance read degraded (${read.warnings.length} warnings): refusing to compare from a degraded state`);
  }
  const opts = { escapeFn: escapeXml, selfReportInstruction: read.selfReportEnabled };
  const principles = Object.fromEntries(read.principles.map((p) => [short(p.principleId), {
    blockChars: measureSharedDirectiveBlockChars(p, opts),
    authority: p.authority ?? 'unknown',
    activationIdHash: short(p.activationId),
  }]));
  const pidByActivation = new Map(read.principles.map((p) => [p.activationId, short(p.principleId)]));
  const budget = resolvePromptBudget();
  const rounds = [];
  for (const round of ROUNDS) {
    const t0 = process.hrtime.bigint();
    const r = await buildActivePrinciplePromptContext({
      workspaceDir,
      ...(round.roundKey !== undefined ? { roundKey: round.roundKey } : {}),
      promptBudget: { ...budget, budgetChars: round.budgetChars },
    });
    const builderMs = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;
    rounds.push({
      round: round.label,
      budgetChars: round.budgetChars,
      roundKey: round.roundKey ?? null,
      policy: r.selectionPolicy,
      finalChars: r.additionalContext.length,
      finalSha256: sha256(r.additionalContext),
      tokens: 'unknown',
      includedPidHashes: r.activationIds.map((id) => pidByActivation.get(id) ?? `unmapped:${short(id)}`),
      droppedCount: (r.droppedActivationIds ?? []).length,
      builderMs,
    });
  }
  return {
    sandbox: { promptActivations: read.principles.length, readerWarnings: read.warnings.length, selfReportEnabled: read.selfReportEnabled, baseChars: sharedDirectiveBaseChars(opts) },
    principles,
    rounds,
  };
}

/** The fixed comparison (written before any governance happens). */
function compare(pre, post, governedHashes) {
  const perRound = pre.rounds.map((p, index) => {
    const q = post.rounds[index];
    if (!q || q.round !== p.round) throw new Error(`round mismatch at ${index}`);
    const preSet = new Set(p.includedPidHashes);
    const postSet = new Set(q.includedPidHashes);
    const kept = [...preSet].filter((h) => postSet.has(h));
    const removed = [...preSet].filter((h) => !postSet.has(h));
    const added = [...postSet].filter((h) => !preSet.has(h));
    const blockPre = (h) => pre.principles[h]?.blockChars ?? 0;
    const blockPost = (h) => post.principles[h]?.blockChars ?? 0;
    return {
      round: p.round,
      kept: kept.length,
      removedGoverned: removed.filter((h) => governedHashes.has(h)),
      removedOther: removed.filter((h) => !governedHashes.has(h)),
      added,
      addedNotInPreEligibleSet: added.filter((h) => !Object.hasOwn(pre.principles, h)),
      oldContentReductionChars: removed.filter((h) => governedHashes.has(h)).reduce((sum, h) => sum + blockPre(h), 0),
      otherRemovedChars: removed.filter((h) => !governedHashes.has(h)).reduce((sum, h) => sum + blockPre(h), 0),
      refillChars: added.reduce((sum, h) => sum + blockPost(h), 0),
      keptBlockChangeChars: kept.reduce((sum, h) => sum + (blockPost(h) - blockPre(h)), 0),
      netFinalChange: q.finalChars - p.finalChars,
      preFinalChars: p.finalChars,
      postFinalChars: q.finalChars,
      postTokens: 'NOT RUN (no reliable tokenizer)',
    };
  });
  const sum = (key) => perRound.reduce((acc, r) => acc + r[key], 0);
  return {
    perRound,
    totals: {
      oldContentReductionChars: sum('oldContentReductionChars'),
      otherRemovedChars: sum('otherRemovedChars'),
      refillChars: sum('refillChars'),
      keptBlockChangeChars: sum('keptBlockChangeChars'),
      netFinalChange: sum('netFinalChange'),
      preFinalChars: sum('preFinalChars'),
      postFinalChars: sum('postFinalChars'),
    },
    // Accounting identity of the strictly additive renderer:
    // net = -oldContentReduction - otherRemoved + refill + keptBlockChange (+ base chars when a round flips empty/non-empty).
    hardAnomalies: perRound.filter((r) => r.addedNotInPreEligibleSet.length > 0).map((r) => ({ round: r.round, newActivationsOutsideGovernance: r.addedNotInPreEligibleSet })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceDir = path.resolve(args.ws);
  const governedHashes = new Set(fs.readFileSync(args.items, 'utf8').trim().split('\n').map((line) => line.split('\t')[2]));
  const snap = await snapshotRounds(workspaceDir);
  const phase = args.pre ? 'post' : 'pre';
  const report = {
    harness: 'pri1160-legacy-retest',
    phase,
    generatedAt: new Date().toISOString(),
    modelCalls: 0,
    currency: 'chars (budgetChars unit, ordinary Native final directive text); tokens unknown',
    governedItems: [...governedHashes].map((h) => ({ hash: h, presentNow: Object.hasOwn(snap.principles, h), authorityNow: snap.principles[h]?.authority ?? 'absent', blockCharsNow: snap.principles[h]?.blockChars ?? 0 })),
    ...(args.baselineRef ? { baselineRef: { path: args.baselineRef, sha256: fileSha256(args.baselineRef) } } : {}),
    ...snap,
    aggregate: { sumFinalChars: snap.rounds.reduce((s, r) => s + r.finalChars, 0), sumBuilderMs: Math.round(snap.rounds.reduce((s, r) => s + r.builderMs, 0) * 1000) / 1000 },
  };
  if (phase === 'post') {
    const pre = JSON.parse(fs.readFileSync(args.pre, 'utf8'));
    report.preRef = { path: args.pre, sha256: fileSha256(args.pre) };
    report.comparison = compare(pre, snap, governedHashes);
  } else {
    report.comparison = 'NOT RUN — post-governance phase awaits the Owner\'s Console decisions';
  }
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 1)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, phase, out: args.out, rounds: snap.rounds.length, governed: report.governedItems.map((g) => `${g.hash}:${g.presentNow ? g.authorityNow : 'absent'}`).join(',') }));
}

await main();
