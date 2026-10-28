// SPEC-PD-EXAMINER-001 v0.4 / PRI-1037 (S5.2 §五) — the probe side-effect
// scanner. Extracted as a module so tests exercise the REAL production
// scanner rather than a parallel reimplementation.
//
// Policies:
//   - gold-hex scan recurses through scratchRoot AND roundsRoot (per-round
//     state dirs included — never exempt);
//   - round-dir TOP-LEVEL entries outside the allowlist are unauthorized
//     extra writes; the 'state' dir is allowed but its file count is reported
//     for audit (runtime-internal state is not enumerable, gold is still
//     scanned);
//   - production PD roots: any mtime inside the probe window is a write;
//   - workRoot files outside the controlled paths are external side effects.
// If a side effect cannot be proven zero, the scan is not clean (fail-closed).
import fs from 'node:fs';
import path from 'node:path';

export const ROUND_DIR_ALLOWLIST = new Set(['AGENTS.md', 'probe-message.txt', 'state']);

export function createProbeSideEffectScanner({ scratchRoot, roundsRoot, copyDir, workRoot, windowStart, goldHexRuns, productionRoots }) {
  const scanForGold = (root) => {
    let hits = 0;
    if (!fs.existsSync(root)) return hits;
    const walk = (dir, fn) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p, fn); else fn(p); } };
    walk(root, (p) => { try { const t = fs.readFileSync(p, 'utf8'); if (goldHexRuns.some((run) => t.includes(run))) hits += 1; } catch { /* binary/unreadable — not a leak signal */ } });
    return hits;
  };
  return () => {
    let crossGroupLeakage = 0;
    let productionWrites = 0;
    let externalSideEffects = 0;
    let unauthorizedExtraWrites = 0;
    let runtimeStateFiles = 0;
    const extraSamples = [];
    crossGroupLeakage += scanForGold(scratchRoot);
    crossGroupLeakage += scanForGold(roundsRoot); // includes every round's state dir — never exempt
    if (fs.existsSync(roundsRoot)) {
      for (const round of fs.readdirSync(roundsRoot, { withFileTypes: true })) {
        if (!round.isDirectory()) continue;
        const roundDir = path.join(roundsRoot, round.name);
        for (const f of fs.readdirSync(roundDir)) {
          if (!ROUND_DIR_ALLOWLIST.has(f)) {
            unauthorizedExtraWrites += 1;
            if (extraSamples.length < 5) extraSamples.push(path.join(round.name, f));
          } else if (f === 'state') {
            const stateDir = path.join(roundDir, 'state');
            if (fs.existsSync(stateDir)) {
              const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else runtimeStateFiles += 1; } };
              walk(stateDir);
            }
          }
        }
      }
    }
    const walk = (dir, fn) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p, fn); else fn(p); } };
    for (const pdRoot of productionRoots) {
      if (!fs.existsSync(pdRoot)) continue;
      walk(pdRoot, (p) => { const st = fs.statSync(p); if (st.mtimeMs >= windowStart) productionWrites += 1; });
    }
    walk(workRoot, (p) => { const st = fs.statSync(p); if (st.mtimeMs >= windowStart && !p.startsWith(scratchRoot) && !p.startsWith(copyDir) && !p.startsWith(roundsRoot)) externalSideEffects += 1; });
    const clean = unauthorizedExtraWrites === 0 && crossGroupLeakage === 0 && productionWrites === 0 && externalSideEffects === 0;
    return { clean, crossGroupLeakage, productionWrites, externalSideEffects, unauthorizedExtraWrites, runtimeStateFiles, extraSamples, controlledPathsScanned: [scratchRoot, roundsRoot], roundDirAllowlist: [...ROUND_DIR_ALLOWLIST].sort(), scopeNote: 'scratch+rounds(incl. state) gold-hex scan + round-dir allowlist + state file audit count + PD roots mtime window + workdir non-controlled writes; not a whole-disk claim', ...(clean ? {} : { nonCleanReason: 'a side effect could not be proven zero during the probe window' }) };
  };
}
