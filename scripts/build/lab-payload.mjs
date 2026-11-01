/**
 * The console loads the principle-learning-lab dynamically from `<lab>/lib`,
 * and the installer payload carries only what that loader can actually reach.
 * Shipping the whole lab lib would drag research/transport modules onto user
 * machines (some of them read API keys from the home directory), so the
 * payload is the transitive `import` closure of the console's entry modules.
 *
 * This module exists so the bundle step and its guard test share ONE
 * definition of "the lab subset" instead of two drifting lists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Modules the console imports by name (see pd-console/src/server/routes). */
export const LAB_ENTRY_MODULES = [
  'lib/examiner-study.mjs',
  'lib/challenge-runner.mjs',
  'lib/challenge-behavior-report.mjs',
  'lib/challenge-actor.mjs',
  'lib/examiner-injection-evidence.mjs',
  // Case generators imported by examiner-executor when a study is created.
  'lib/examiner-v07-cases.mjs',
  'lib/examiner-v2-cases.mjs',
];

const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;

/**
 * Resolve the closure. Fails loud on a missing module or on an import that
 * escapes `lib/` — both mean the payload shape assumption is broken, and a
 * payload assembled around a broken assumption must not ship.
 */
export function collectLabModuleClosure(labRoot) {
  const root = String(labRoot);
  const seen = new Set();
  const queue = [...LAB_ENTRY_MODULES];
  for (;;) {
    const rel = queue.shift();
    if (rel === undefined) break;
    if (seen.has(rel)) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      throw new Error(`lab module not found: ${abs}`);
    }
    seen.add(rel);
    const source = readFileSync(abs, 'utf8');
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(rel), match[1]));
      if (!target.startsWith('lib/')) {
        throw new Error(`lab module ${rel} imports outside lib/: ${match[1]} (${target})`);
      }
      queue.push(target);
    }
  }
  return [...seen].sort();
}
