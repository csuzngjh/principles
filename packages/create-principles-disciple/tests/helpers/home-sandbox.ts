/**
 * Real-home write guard for installer/update tests (issue: 2026-11-19 —
 * `1.230.2` in the Owner console's version history).
 *
 * Root cause of that incident: `installer-active-record.test.ts` pinned only
 * `process.env.HOME`, while several home consumers in the installer family
 * read `os.homedir()` (USERPROFILE on Windows) with no HOME-first indirection
 * (`agent-skill.ts`, `installers/index.ts`, `workspace-divergence.ts`, …).
 * On Windows a HOME-only sandbox therefore left those consumers pointed at the
 * REAL user profile, and a fixture-built payload identity
 * (`productVersion: 1.230.2`) reached the real `~/.pd/active.json`, where the
 * console reads it as the installed product version.
 *
 * Two complementary guarantees live here:
 *
 *  1. `pinHomeTo()` redirects BOTH home authorities (`HOME` and `USERPROFILE`)
 *     so no consumer — env-based or `os.homedir()`-based, in-process or in a
 *     spawned child that inherits the env — can reach the real profile.
 *  2. `snapshotRealHomeState()` / `assertRealHomeStateUnchanged()` are a
 *     sentinel over the REAL home's PD identity state. A leak turns CI red at
 *     the point of the write instead of silently corrupting the machine's
 *     deployment identity and being discovered weeks later in the UI.
 *
 * The sentinel is deliberately read-only and never creates, repairs or deletes
 * anything: it reports a violation, it does not fix one.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Redirect every home authority the installer family reads.
 *
 * Returns a handle whose `restore()` puts the previous raw values back
 * (including "was unset"), so a test cannot leak the sandbox into the next
 * file in the same worker.
 */
export interface HomePin {
  /** Absolute sandbox home both env keys now point at. */
  readonly home: string;
  restore(): void;
}

export function pinHomeTo(homeDir: string): HomePin {
  const home = path.resolve(homeDir);
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  let released = false;
  return {
    home,
    restore(): void {
      if (released) return;
      released = true;
      restoreKey('HOME', previous.HOME);
      restoreKey('USERPROFILE', previous.USERPROFILE);
    },
  };
}

function restoreKey(key: 'HOME' | 'USERPROFILE', previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

export interface HomeEntrySnapshot {
  /** Absolute path inspected. */
  readonly path: string;
  /** `absent`, `unreadable`, a content digest, or a directory listing digest. */
  readonly state: string;
}

export interface RealHomeSnapshot {
  /** Every home root the installer family can resolve through. */
  readonly roots: readonly string[];
  readonly entries: readonly HomeEntrySnapshot[];
}

/**
 * Home roots that must never be written to by a test: the OS account home
 * (`os.homedir()` = USERPROFILE on Windows) plus whatever `HOME` /
 * `USERPROFILE` the process inherited. Deduplicated and sorted so two
 * snapshots of the same environment compare equal.
 */
export function realHomeRoots(): string[] {
  const candidates = [os.homedir(), process.env.HOME, process.env.USERPROFILE];
  const roots = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    roots.add(path.resolve(trimmed));
  }
  return [...roots].sort();
}

/**
 * The PD identity state a fixture must never leak into. Content digests for
 * files (active.json/install.json carry the deployed product identity), name
 * listings for the two directories that record install/backup history, and a
 * presence marker for the OpenClaw extension slot (the plugin payload).
 */
function identityTargets(root: string): string[] {
  const pd = path.join(root, '.pd');
  return [
    path.join(pd, 'active.json'),
    path.join(pd, 'install.json'),
    path.join(pd, 'transactions'),
    path.join(pd, 'backups'),
    path.join(root, '.openclaw', 'extensions', 'principles-disciple'),
  ];
}

export function snapshotRealHomeState(): RealHomeSnapshot {
  const roots = realHomeRoots();
  const entries: HomeEntrySnapshot[] = [];
  for (const root of roots) {
    for (const target of identityTargets(root)) {
      entries.push({ path: target, state: describePath(target) });
    }
  }
  return { roots, entries };
}

function describePath(target: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? 'absent' : `unreadable:${code ?? 'unknown'}`;
  }
  if (stat.isDirectory()) {
    try {
      const names = fs.readdirSync(target).sort();
      const digest = createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 16);
      return `dir:${names.length}:${digest}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return `unreadable:${code ?? 'unknown'}`;
    }
  }
  try {
    const bytes = fs.readFileSync(target);
    return `file:${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return `unreadable:${code ?? 'unknown'}`;
  }
}

/**
 * Fail loud when the real home's PD identity state changed since `before`.
 *
 * The message names every changed path with its before/after state, so the
 * failure itself identifies which fixture escaped instead of only reporting
 * "expected 1 to be 2".
 */
export function assertRealHomeStateUnchanged(before: RealHomeSnapshot, context = 'this test file'): void {
  // Re-describe exactly the paths observed BEFORE the run. Roots are NOT
  // re-derived: a test may legitimately leave HOME/USERPROFILE pointing at its
  // own (now deleted) sandbox, which would change `realHomeRoots()` and turn
  // untouched real paths into false "absent" violations.
  const violations: string[] = [];
  for (const entry of before.entries) {
    const stateAfter = describePath(entry.path);
    if (stateAfter !== entry.state) {
      violations.push(`  ${entry.path}\n    before: ${entry.state}\n    after:  ${stateAfter}`);
    }
  }

  if (violations.length === 0) return;
  throw new Error(
    [
      `Real-home write detected while running ${context}.`,
      'A test wrote to the REAL user profile instead of its sandbox — this is the',
      'class of leak that put the fixture version 1.230.2 into ~/.pd/active.json.',
      'Pin BOTH authorities with pinHomeTo() from tests/helpers/home-sandbox.ts',
      '(HOME alone does not cover os.homedir()/USERPROFILE consumers).',
      '',
      'Changed identity state:',
      ...violations,
    ].join('\n'),
  );
}
