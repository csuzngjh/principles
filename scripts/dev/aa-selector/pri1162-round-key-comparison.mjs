#!/usr/bin/env node
/**
 * PRI-1162 one-round same-input comparison — FIFO (post-#2455 Native baseline)
 * vs fair rotation (round key = persisted-turn ordinal), through the CURRENT
 * shared assembly entry.
 *
 * FROZEN INPUTS (Owner-approved card v0.1 §5, frozen before results were read):
 *   - candidate set: the WAL-0 verified snapshot copy (state.db sha256
 *     830fbd24…, 18 eligible prompt candidates, none oversized at the tested
 *     budgets), identical to the PRI-1160/PRI-1161 evidence source;
 *   - budgets: 4000 (primary tight round) and 2500 (auxiliary);
 *   - rotation drive: roundKey = k+1 for user turn k (the persisted-turn
 *     semantic: write this turn, read MAX(turn_index)+1) for k = 1..18 —
 *     N=18 candidates need N consecutive rounds for a full lead cycle;
 *   - FIFO arm: roundKey absent every round (exactly what an OpenClaw
 *     installation without the #2398 provider, or any degraded invocation,
 *     selects — byte-identical to the merged #2455 Native FIFO baseline).
 *
 * METRICS (frozen): per-candidate selection count, longest consecutive-absence
 * streak, chars per round, per-round elapsed ms. Candidates that cannot fit
 * even alone are reported separately as oversized with their raw failure —
 * they are a budget/classification fact, not a strategy difference.
 *
 * PASS LINE (frozen, card §5): rotation selected-count over the 12-round
 * window >= FIFO + 4 (floor 14); every FIFO-starved candidate appears at
 * least once within 18 consecutive rotation rounds; FIFO arm output is
 * byte-identical across rounds and matches the #2455 baseline behavior
 * (constant prefix, first non-fit stops the pack).
 *
 * Zero host starts, zero model calls, zero production writes; the production
 * workspace is never opened (sandbox read-only). Tokens: unknown (no reliable
 * tokenizer) — chars are the frozen unit.
 *
 * Usage (repository root, host-runtime built):
 *   node scripts/dev/aa-selector/pri1162-round-key-comparison.mjs --ws <sandbox> --out <report.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildActivePrinciplePromptContext, readPromptActivationCandidates } from '@principles/host-runtime';
import { resolvePromptBudget } from '@principles/core/runtime';

const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const short = (t) => sha256(t).slice(0, 12);

function parseArgs(argv) {
  const args = { ws: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--ws') { args.ws = value; i += 1; }
    else if (key === '--out') { args.out = value; i += 1; }
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!args.ws || !args.out) throw new Error('--ws and --out are required');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const workspaceDir = path.resolve(args.ws);

const read = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
if (read.aborted) throw new Error(`reader aborted: ${read.warnings.join('; ')}`);
if (read.warnings.length > 0) throw new Error(`degraded candidate read: ${read.warnings.join('; ')}`);
const baseBudget = resolvePromptBudget();
const candidates = read.principles;
const N = candidates.length;
const ids = candidates.map((p) => short(p.principleId));

const ROUNDS_FIFO = 12;
const ROUNDS_ROTATION_FULL = N; // 18: full lead cycle
const BUDGETS = [4000, 2500];

async function runArm(budgetChars, arm) {
  const rounds = [];
  const perRoundSelectedIds = [];
  const seenCount = new Map(ids.map((id) => [id, 0]));
  const streak = new Map(ids.map((id) => [id, 0]));
  const maxStreak = new Map(ids.map((id) => [id, 0]));
  const selectedRounds = new Map(ids.map((id) => [id, []]));
  for (let k = 1; k <= (arm === 'FIFO' ? ROUNDS_FIFO : ROUNDS_ROTATION_FULL); k += 1) {
    const roundKey = arm === 'ROTATION' ? k + 1 : undefined;
    const t0 = process.hrtime.bigint();
    const r = await buildActivePrinciplePromptContext({
      workspaceDir,
      ...(roundKey !== undefined ? { roundKey } : {}),
      promptBudget: { ...baseBudget, budgetChars },
    });
    const ms = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;
    const selected = new Set(r.principleIds.map((pid) => {
      const hit = candidates.find((c) => c.principleId === pid);
      return short(hit.principleId);
    }));
    perRoundSelectedIds.push([...selected]);
    for (const id of ids) {
      if (selected.has(id)) {
        seenCount.set(id, seenCount.get(id) + 1);
        streak.set(id, 0);
        selectedRounds.get(id).push(roundKey ?? `fifo-${k}`);
      } else {
        const s = streak.get(id) + 1;
        streak.set(id, s);
        maxStreak.set(id, Math.max(maxStreak.get(id), s));
      }
    }
    rounds.push({
      round: arm === 'ROTATION' ? `k${k}` : `fifo-${k}`,
      roundKey,
      policy: r.selectionPolicy,
      rotationStartIndex: r.rotationStartIndex ?? null,
      chars: r.additionalContext.length,
      selectedCount: r.principleIds.length,
      eligibleCount: r.eligibleCount,
      truncated: r.truncated,
      oversized: r.oversizedActivationIds ?? [],
      dropped: r.droppedActivationIds ?? [],
      ms,
    });
  }
  return { rounds, seenCount, maxStreak, selectedRounds, perRoundSelectedIds };
}

const report = {
  ticket: 'PRI-1162',
  comparison: 'one-round same-input FIFO vs fair rotation, current shared assembly entry (post-#2455)',
  frozenInputs: {
    stateDbSha256: '830fbd24b8abf502f22931a4fdbd2b1a321955e05713ace27863f589347796a5',
    candidates: N,
    candidateOrder: 'activated_at ASC (base order)',
    candidateHashes12: ids,
    budgets: BUDGETS,
    fifoRounds: ROUNDS_FIFO,
    rotationRounds: ROUNDS_ROTATION_FULL,
    rotationDrive: 'roundKey = k+1 (persisted-turn semantic)',
    fifoDrive: 'roundKey absent (installed-production / degraded semantics)',
    boundaries: { hostStarts: 0, modelCalls: 0, productionWrites: 0, tokenEstimates: 'unknown — no reliable tokenizer; chars are the unit' },
  },
  budgets: {},
};

for (const budgetChars of BUDGETS) {
  const fifo = await runArm(budgetChars, 'FIFO');
  const rotation = await runArm(budgetChars, 'ROTATION');

  // oversized: candidates that never fit even alone — strategy-independent;
  // kept with their raw failure instead of being folded into coverage math.
  const oversizedIds = new Set();
  for (const r of [...fifo.rounds, ...rotation.rounds]) {
    for (const a of r.oversized) {
      const hit = candidates.find((c) => c.activationId === a);
      if (hit) oversizedIds.add(short(hit.principleId));
    }
  }

  const fifoSelectedCount = [...fifo.seenCount.values()].filter((c) => c > 0).length;
  const rotSelectedCount = [...rotation.seenCount.values()].filter((c) => c > 0).length;
  const fifoStarved = ids.filter((id) => fifo.seenCount.get(id) === 0);
  const rotNeverSeen = ids.filter((id) => rotation.seenCount.get(id) === 0 && !oversizedIds.has(id));

  // Frozen 12-round window (card §5): distinct candidates selected within the
  // FIRST 12 rotation rounds.
  const rot12SelectedCount = new Set(rotation.perRoundSelectedIds.slice(0, 12).flat()).size;

  report.budgets[budgetChars] = {
    fifo: {
      policy: 'legacy_fifo_prefix_v1',
      rounds: fifo.rounds,
      perCandidate: ids.map((id) => ({
        id,
        selections: fifo.seenCount.get(id),
        longestAbsenceStreak: fifo.maxStreak.get(id),
        presentInRounds: fifo.selectedRounds.get(id).length,
      })),
      selectedCandidateCount: fifoSelectedCount,
      starved: fifoStarved,
      charsPerRound: fifo.rounds.map((r) => r.chars),
      byteIdenticalAcrossRounds: new Set(fifo.rounds.map((r) => r.chars)).size === 1,
    },
    rotation: {
      policy: 'fair_rotation_v1',
      rounds: rotation.rounds,
      perCandidate: ids.map((id) => ({
        id,
        selections: rotation.seenCount.get(id),
        longestAbsenceStreak: rotation.maxStreak.get(id),
        presentInRounds: rotation.selectedRounds.get(id).length,
      })),
      selectedCandidateCount: rotSelectedCount,
      neverSeenNonOversized: rotNeverSeen,
      charsPerRound: rotation.rounds.map((r) => r.chars),
      totalChars: rotation.rounds.reduce((s, r) => s + r.chars, 0),
    },
    oversized: {
      count: oversizedIds.size,
      ids: [...oversizedIds],
      note: 'kept separately with raw failure classification — not a strategy difference; raw per-round oversized lists preserved in both arms',
    },
    passLine: {
      rotationWindow12SelectedCount: rot12SelectedCount,
      minRequired: Math.max(fifoSelectedCount + 4, 14),
      pass_12roundWindow: rot12SelectedCount >= Math.max(fifoSelectedCount + 4, 14),
      fullCycle18SelectedCount: rotSelectedCount,
      everyFifoStarvedSeenIn18Rounds: fifoStarved.every((id) => rotation.seenCount.get(id) > 0),
      fifoByteIdenticalAcrossRounds: new Set(fifo.rounds.map((r) => r.chars)).size === 1,
      passLineVersion: 'card v0.1 §5 (frozen before this run)',
    },
  };
}

fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2));

// Console summary
for (const [budget, b] of Object.entries(report.budgets)) {
  console.log(`== budget ${budget}`);
  console.log(`FIFO: selected ${b.fifo.selectedCandidateCount}/${N}, starved ${b.fifo.starved.length}, chars/round ${b.fifo.charsPerRound[0]} (constant: ${b.fifo.byteIdenticalAcrossRounds})`);
  console.log(`ROTATION: selected ${b.rotation.selectedCandidateCount}/${N}, neverSeen(non-oversized) ${b.rotation.neverSeenNonOversized.length}, chars/round ${b.rotation.charsPerRound.join(',')}`);
  console.log(`passLine: ${JSON.stringify(b.passLine)}`);
  console.log(`oversized: ${b.oversized.count}`);
}
console.log(`report: ${path.resolve(args.out)}`);
