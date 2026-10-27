// SPEC-PD-EXAMINER-001 — CEB-002 paired-statistics instrument (exploratory).
//
// Exact-binomial McNemar machinery for the preregistered B-vs-C paired
// comparison (16 cases, 2 repetitions per arm-pair) and its power analysis.
// Everything is pure exact arithmetic over the binomial law — no asymptotic
// approximation, no RNG.
//
// Definitions (kept explicit per the Owner statistical-closeout instruction):
//   p10 = P(B fails AND C passes) on one pair  ("B-worse" discordance)
//   p01 = P(B passes AND C fails) on one pair  ("C-worse" discordance)
//   pd  = p10 + p01                            (discordance probability)
//   delta = p10 - p01                          (marginal paired difference)
// The exact two-sided McNemar test conditions on the observed number of
// discordant pairs n_d = b + c and evaluates b ~ Binom(n_d, 0.5) under H0.
//
// ANALYSIS STRUCTURE (CEB-002, preregistered):
//   PRIMARY: discriminative tier (L2+L3) — n=8 INDEPENDENT case-level paired
//   units; each case's 2 repetitions are repeated measurements of ONE unit,
//   reduced by reduceCaseLevel. The exact McNemar at n=8 rejects when >=6
//   discordant units all point the same way ((6,0)/(7,0)/(8,0) + symmetric).
//   REFERENCE VIEW 1: all 16 cases (heterogeneous tier mix — L1 anchor +
//   boundary + discriminative) as case-level pairs — NOT the primary object.
//   REFERENCE VIEW 2: 32 repetition-level pairs — NON-INDEPENDENT (same-case
//   repetitions are correlated); must never inflate the independent n.
//
// mcnemarExactPower accepts any  value as a GENERAL statistical tool;
// passing pairs=16 or pairs=32 computes power for those views but does NOT
// upgrade them to primary-analysis status. The primary analysis is n=8.
//
// Zero network, zero clock, deterministic.

/** log C(n, k) */
function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - i + 1) / i);
  return s;
}

/** Exact two-sided McNemar p-value for b (B-worse) vs c (C-worse) discordant pairs. */
export function mcnemarExactPValue(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let cumulative = 0;
  for (let i = 0; i <= k; i++) cumulative += Math.exp(logChoose(n, i));
  return Math.min(1, (cumulative / 2 ** n) * 2);
}

/**
 * EXACT power of the two-sided McNemar test (alpha) for n PAIRS whose
 * discordance directions are independent draws with P(B-worse)=p10,
 * P(C-worse)=p01. Enumerates every (b, c) outcome, keeps those with
 * p-value <= alpha, and sums the exact Binom(n, p10/(p10+p01)) probability
 * of b among the discordant count, weighted by P(discordant count = b + c).
 */
export function mcnemarExactPower({ pairs, p10, p01, alpha = 0.05 }) {
  if (pairs <= 0) throw new Error('pairs must be positive');
  if (p10 < 0 || p01 < 0 || p10 + p01 > 1) throw new Error('invalid discordance probabilities');
  const pd = p10 + p01;
  if (pd === 0) return 0; // no discordance ever — test can never reject
  const p = p10 / pd; // P(B-worse | discordant)
  let power = 0;
  for (let b = 0; b <= pairs; b++) {
    for (let c = 0; c <= pairs - b; c++) {
      if (mcnemarExactPValue(b, c) > alpha) continue;
      const nD = b + c;
      const logPdiscordCount = logChoose(pairs, nD) + (nD > 0 ? Math.log(pd) * nD : 0) + (pairs - nD > 0 ? Math.log(1 - pd) * (pairs - nD) : 0);
      const logPdirection = logChoose(nD, b) + (b > 0 ? Math.log(p) * b : 0) + (nD - b > 0 ? Math.log(1 - p) * (nD - b) : 0);
      power += Math.exp(logPdiscordCount + logPdirection);
    }
  }
  return Math.min(1, power);
}

/** Per-case reduction for the case-level (clustering-unit) analysis:
 *  a case counts as "B-worse" if B failed in >=1 rep while C failed in 0;
 *  symmetric for "C-worse"; ties/both/neither are concordant for this view. */
export function reduceCaseLevel(reps) {
  // reps: [{bFail: boolean, cFail: boolean}, ...] one per repetition
  const bWorse = reps.some((r) => r.bFail) && reps.every((r) => !r.cFail);
  const cWorse = reps.some((r) => r.cFail) && reps.every((r) => !r.bFail);
  return { bWorse, cWorse };
}
