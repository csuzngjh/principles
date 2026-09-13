import { describe, expect, it } from 'vitest';
import * as fsSync from 'fs';
import * as pathSync from 'path';
import { DEFAULT_FEATURE_FLAGS } from '../feature-flag-contract.js';
import {
  QUIET_FLAG_LIFECYCLE,
  type QuietFlagLifecycleDecision,
  type QuietFlagLifecycleEntry,
} from '../feature-flag-lifecycle.js';

/**
 * PRI-610 — Feature Flag lifecycle contract.
 *
 * Enforces "feature purgatory = 0": no quiet flag may exist in the registry
 * without an evidence-backed lifecycle decision (KEEP_QUIET / GRADUATE /
 * RETIRE / STAGED), and no lifecycle entry may reference an unknown flag.
 * A new quiet flag added to DEFAULT_FEATURE_FLAGS without a lifecycle entry
 * here FAILS this test — the census must be updated in the same PR.
 */

const VALID_DECISIONS: readonly QuietFlagLifecycleDecision[] = ['KEEP_QUIET', 'GRADUATE', 'RETIRE', 'STAGED'];

const quietFlags = DEFAULT_FEATURE_FLAGS.filter(f => f.category === 'quiet');
const goneFlags = DEFAULT_FEATURE_FLAGS.filter(f => f.category === 'gone');
const legacyRetireFlags = DEFAULT_FEATURE_FLAGS.filter(f => f.category === 'legacy_retire');

describe('PRI-610 feature flag lifecycle census', () => {
  it('every quiet flag has a lifecycle decision (feature purgatory = 0)', () => {
    expect(quietFlags.length).toBeGreaterThan(0);
    for (const flag of quietFlags) {
      expect(
        Object.hasOwn(QUIET_FLAG_LIFECYCLE, flag.id),
        `quiet flag '${flag.id}' has no lifecycle entry — add one to QUIET_FLAG_LIFECYCLE (Purpose/Default/Rollback/Graduation/Retirement/Exit) in the same PR`,
      ).toBe(true);
    }
  });

  it('no lifecycle entry references an unregistered or non-quiet flag (no orphan census rows)', () => {
    const quietIds = new Set(quietFlags.map(f => f.id));
    for (const id of Object.keys(QUIET_FLAG_LIFECYCLE)) {
      expect(
        quietIds.has(id),
        `lifecycle entry '${id}' does not match a registered quiet flag — stale census row (removed flag? category change?)`,
      ).toBe(true);
    }
  });

  it('every lifecycle entry is complete: decision, consumers, evidence, decided date, exit criteria', () => {
    for (const [id, entry] of Object.entries(QUIET_FLAG_LIFECYCLE)) {
      expect(VALID_DECISIONS.includes(entry.decision), `${id}: invalid decision '${entry.decision}'`).toBe(true);
      expect(entry.consumers.length, `${id}: consumers evidence must not be empty`).toBeGreaterThan(0);
      expect(entry.evidence.length, `${id}: evidence must not be empty`).toBeGreaterThan(0);
      expect(entry.decided, `${id}: decided date required (YYYY-MM-DD)`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Exit path is mandatory for every lifecycle state — a flag with no
      // disappearance condition is permanent by construction (Phase 1 §G3).
      expect(entry.retirementCriteria.length, `${id}: retirementCriteria (exit path) required`).toBeGreaterThan(0);
      if (entry.decision === 'KEEP_QUIET' || entry.decision === 'STAGED') {
        expect(entry.graduationCriteria.length, `${id}: graduationCriteria required for ${entry.decision}`).toBeGreaterThan(0);
      }
    }
  });

  it('STAGED flags must document why they are staged (roadmap ownership)', () => {
    for (const [id, entry] of Object.entries(QUIET_FLAG_LIFECYCLE)) {
      if (entry.decision === 'STAGED') {
        expect(
          entry.consumers.some(c => c.includes('staged') || c.includes('none yet')),
          `${id}: STAGED flags must state that activation wiring is pending and where it lands`,
        ).toBe(true);
      }
    }
  });

  it('GRADUATE decisions record executed graduation evidence (no aspirational GRADUATE rows)', () => {
    for (const [id, entry] of Object.entries(QUIET_FLAG_LIFECYCLE)) {
      if (entry.decision === 'GRADUATE') {
        const registered = quietFlags.find(f => f.id === id);
        expect(registered, `${id}: GRADUATE flag must still be registered`).toBeDefined();
        expect(
          registered?.enabled,
          `${id}: GRADUATE decision means default-on in the registry`,
        ).toBe(true);
        expect(
          entry.graduationCriteria.toUpperCase().includes('MET') || entry.evidence.includes('graduated'),
          `${id}: GRADUATE rows must record executed graduation evidence, not a future intent (use KEEP_QUIET until validated)`,
        ).toBe(true);
        // 'decided' is the decision date (field contract). For an executed
        // graduation the decision IS the graduation, so the decided date must
        // be corroborated by the executed-graduation record itself (criteria
        // or evidence) — the ledger cannot claim a decision date that its own
        // graduation evidence does not support.
        expect(
          entry.graduationCriteria.includes(entry.decided) || entry.evidence.includes(entry.decided),
          `${id}: GRADUATE decided date '${entry.decided}' must appear in the executed graduation record (graduationCriteria or evidence)`,
        ).toBe(true);
      }
    }
  });

  it('gone flags are permanently disabled and never carry lifecycle entries (terminal state)', () => {
    expect(goneFlags.length).toBeGreaterThan(0);
    for (const flag of goneFlags) {
      expect(flag.enabled, `gone flag '${flag.id}' must default false`).toBe(false);
      expect(
        Object.hasOwn(QUIET_FLAG_LIFECYCLE, flag.id),
        `gone flag '${flag.id}' is terminal — lifecycle decisions apply to quiet flags only`,
      ).toBe(false);
    }
  });

  it('legacy_retire category is a recognized, currently-empty transition state (documented semantics)', () => {
    // Category semantics (docs/process/feature-flag-lifecycle-census.md):
    // - gone        = retired; can never be re-enabled; code deleted or inert.
    // - legacy_retire = deletion approved and scheduled; behaves like quiet
    //   (config override still honored) until the code removal PR lands, then
    //   flips to gone. Currently no flag is in transition.
    expect(legacyRetireFlags.length).toBe(0);
  });
});

// ── PRI-779: Feature Flag Consumer Reality Guard ────────────────────────────
//
// PRI-769 §6 A1 / M2: census `consumers` claims were never machine-checked,
// which is how empathy_observer ("observer wiring" that never existed),
// painEvidenceAdmission (kill switch whose Gate A subject was deleted by a
// later refactor) and evolution_worker (flag outliving its deleted worker)
// stayed rotten until manual audit campaigns. Three guards close that gap:
//
//   Guard 1 (path reality)   — a census consumers entry that IS a bare path
//                              must resolve to a real file under
//                              packages/*/src or plugins/*/src.
//   Guard 2 (zombie flags)   — every quiet flag whose census decision is not
//                              STAGED must have at least one executable
//                              consumer read in production sources.
//   Guard 3 (resurrection)   — gone tombstones must have ZERO executable
//                              consumer reads; a runtime read of a retired
//                              flag fails CI.
//
// Scope notes:
// - Core flags are out of scope: they have no census rows and are
//   Owner-approved by definition (AGENTS.md §5; PRI-769 §1.3).
// - "Executable read" is source-level (not AST): the flag id appears as a
//   complete quoted string, or as a `.flagId` member access on any receiver —
//   the read shapes observed across every currently-wired flag
//   (isFeatureEnabled / loadFeatureFlagFromConfig / loadFeatureFlagFromWorkspace
//   / resolveObserverConfig args, pdFlags.flags.x, ctx.featureFlags?.x,
//   userFeatures.x). Dynamic `flags[variable]` dispatch and string-built ids
//   are undetectable at this level and accepted as a known limit.
// - Comments, the registry module itself, the Console label map and
//   enumLabel() display lookups never count as reads (census doc: label maps
//   are display-only). Test files are excluded from the corpus.

const REPO_ROOT = pathSync.resolve(__dirname, '..', '..', '..', '..', '..', '..');

const CORPUS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']);
const CORPUS_EXCLUDED_DIRS = new Set(['__tests__', 'tests', 'node_modules', 'dist']);
// Registry/self-reference layer: the flag module defines the ids, it never
// "consumes" them. The Console label map is display-only per the census doc.
const CORPUS_EXCLUDED_FRAGMENTS = ['packages/principles-core/src/runtime-v2/feature-flags/'];
const CORPUS_EXCLUDED_FILE_NAMES = new Set(['enum-labels.ts', 'enum-labels.tsx']);

function isTestLikePath(path: string): boolean {
  return /(^|\/)(__tests__|tests)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/** Single exclusion predicate shared by the real-repo walker AND the matcher,
 *  so fixtures and production scans classify paths identically. */
function isExcludedConsumerPath(path: string): boolean {
  if (isTestLikePath(path)) return true;
  if (CORPUS_EXCLUDED_FRAGMENTS.some(fragment => path.includes(fragment))) return true;
  const fileName = path.split('/').pop() ?? '';
  return CORPUS_EXCLUDED_FILE_NAMES.has(fileName);
}

interface CorpusFile {
  path: string;
  content: string;
}

interface FlagReadMatch {
  path: string;
  line: number;
  snippet: string;
}

function collectConsumerCorpus(): CorpusFile[] {
  const files: CorpusFile[] = [];
  const walk = (dir: string): void => {
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skipped, never silent for files we matched
    }
    for (const entry of entries) {
      const fullPath = pathSync.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!CORPUS_EXCLUDED_DIRS.has(entry.name)) walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !CORPUS_EXTENSIONS.has(pathSync.extname(entry.name))) continue;
      const relPath = pathSync.relative(REPO_ROOT, fullPath).split(pathSync.sep).join('/');
      if (isExcludedConsumerPath(relPath)) continue;
      let content: string;
      try {
        content = fsSync.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }
      files.push({ path: relPath, content });
    }
  };
  for (const rootDir of ['packages', 'plugins']) {
    const root = pathSync.join(REPO_ROOT, rootDir);
    if (fsSync.existsSync(root)) walk(root);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

let realCorpusCache: CorpusFile[] | null = null;
function loadRealCorpus(): CorpusFile[] {
  if (!realCorpusCache) realCorpusCache = collectConsumerCorpus();
  return realCorpusCache;
}

// Display-layer label lookup (e.g. the empathy cost hint renders the retired
// id as a label): renders an id, never gates behavior.
const DISPLAY_LOOKUP_LINE = /\benumLabel\s*\(/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flagReadPatterns(id: string): RegExp[] {
  const quoted = escapeRegExp(id);
  return [
    // Quoted id: resolver/helper args (isFeatureEnabled(flags, 'id'),
    // loadFeatureFlagFromConfig(dir, 'id', …), Object.hasOwn(flags, 'id')),
    // and quoted flag-id constants.
    new RegExp(`['"]${quoted}['"]`),
    // Member access on any receiver: pdFlags.flags.gfi,
    // ctx.featureFlags?.governance_experience_v1, userFeatures.diagnostician_split_pipeline.
    // The lookbehind keeps import paths like './alpha_flag.js' out.
    new RegExp(`(?<![/.])\\.${quoted}\\b`),
  ];
}

/** Source-level comment stripping with cross-line block-comment state, so a
 *  quoted id inside a multi-line JSX/block comment never counts as a read.
 *  Naive by design: a string literal containing '//' or '/*' can truncate the
 *  code portion of its line — that only risks hiding a read (guard fails,
 *  human inspects), never inventing one. */
function stripComments(line: string, state: { inBlockComment: boolean }): string {
  let code = '';
  let index = 0;
  while (index < line.length) {
    if (state.inBlockComment) {
      const end = line.indexOf('*/', index);
      if (end === -1) {
        index = line.length;
      } else {
        state.inBlockComment = false;
        index = end + 2;
      }
      continue;
    }
    const blockStart = line.indexOf('/*', index);
    const lineStart = line.indexOf('//', index);
    if (lineStart !== -1 && (blockStart === -1 || lineStart < blockStart)) {
      code += line.slice(index, lineStart);
      index = line.length;
    } else if (blockStart === -1) {
      code += line.slice(index);
      index = line.length;
    } else {
      code += line.slice(index, blockStart);
      state.inBlockComment = true;
      index = blockStart + 2;
    }
  }
  return code;
}

const MAX_MATCHES_PER_FLAG = 20;

function globToPathRegExp(pattern: string): RegExp {
  const source = pattern
    .split('**')
    .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`(?:^|/)${source}$`);
}

function findFlagReads(files: CorpusFile[], ids: readonly string[]): Map<string, FlagReadMatch[]> {
  const patterns = new Map(ids.map(id => [id, flagReadPatterns(id)]));
  const reads = new Map(ids.map(id => [id, [] as FlagReadMatch[]]));
  for (const file of files) {
    if (isExcludedConsumerPath(file.path)) continue;
    const commentState = { inBlockComment: false };
    const lines = file.content.split('\n');
    for (const [index, line] of lines.entries()) {
      const code = stripComments(line, commentState);
      const trimmed = code.trim();
      if (trimmed.length === 0 || DISPLAY_LOOKUP_LINE.test(code)) continue;
      for (const [id, regexes] of patterns) {
        if (!regexes.some(regex => regex.test(code))) continue;
        const matches = reads.get(id);
        if (matches && matches.length < MAX_MATCHES_PER_FLAG) {
          matches.push({ path: file.path, line: index + 1, snippet: trimmed.slice(0, 160) });
        }
      }
    }
  }
  return reads;
}

function formatMatches(matches: readonly FlagReadMatch[]): string {
  return matches
    .slice(0, 5)
    .map(match => `${match.path}:${match.line} — ${match.snippet}`)
    .join('; ');
}

// PRI-779 minimal exemptions for Guard 3: exact-quoted gone ids that are
// validation/keyword metadata, not capability reads. Each entry needs a
// recorded reason; keep this list minimal.
const GONE_READ_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  // MVP_GONE_FLAGS: installer --channels input validation rejects retired
  // channel names; it validates user input, it never reads a flag.
  'packages/create-principles-disciple/src/mvp-config.ts',
  // LEGACY_KEYWORDS: legacy channel-name text probe in the proven-channel
  // baseline; keyword metadata, not a flag read.
  'packages/principles-core/src/runtime-v2/proven-channel-baseline.ts',
]);

function quietFlagReadViolations(
  files: CorpusFile[],
  decisions: Readonly<Record<string, QuietFlagLifecycleDecision>>,
): string[] {
  const ids = Object.keys(decisions);
  const reads = findFlagReads(files, ids);
  const violations: string[] = [];
  for (const id of ids) {
    if (decisions[id] === 'STAGED') continue; // wiring deliberately pending (roadmap-owned)
    const matches = reads.get(id) ?? [];
    if (matches.length === 0) {
      violations.push(
        `quiet flag '${id}' has no executable consumer read in production sources`
        + ' — wire the consumer in the same PR, or mark the census entry STAGED with the roadmap issue that will wire it (PRI-769 §4.2)',
      );
    }
  }
  return violations;
}

function goneFlagReadViolations(files: CorpusFile[], ids: readonly string[]): string[] {
  const reads = findFlagReads(files, ids);
  const violations: string[] = [];
  for (const id of ids) {
    const matches = (reads.get(id) ?? []).filter(match => !GONE_READ_EXEMPT_PATHS.has(match.path));
    if (matches.length > 0) {
      violations.push(
        `gone flag '${id}' must have zero executable consumer reads (terminal tombstone) but is read at: ${formatMatches(matches)}`
        + ' — remove the read, or re-register the capability through the census procedure if it is returning',
      );
    }
  }
  return violations;
}

/** Guard 1: a census consumers entry that is exactly one path-like token
 *  (contains '/' and no whitespace) must resolve to at least one real corpus
 *  file, with or without the packages/ or plugins/ prefix. Mixed prose
 *  entries carry no checkable path claim — their reality burden falls on
 *  Guard 2 (flag-level executable reads). */
function censusPathViolations(census: Readonly<Record<string, QuietFlagLifecycleEntry>>, corpusPaths: readonly string[]): string[] {
  const strippedPaths = corpusPaths.map(p => p.replace(/^(?:packages|plugins)\//, ''));
  const violations: string[] = [];
  for (const [id, entry] of Object.entries(census)) {
    for (const consumer of entry.consumers) {
      const token = consumer.trim();
      if (/\s/.test(token) || !token.includes('/')) continue;
      const regex = globToPathRegExp(token);
      const resolves = corpusPaths.some(p => regex.test(p)) || strippedPaths.some(p => regex.test(p));
      if (!resolves) {
        violations.push(
          `census consumers entry '${token}' (${id}) does not resolve to any file under packages/*/src or plugins/*/src`
          + ' — update the census entry to the real current path (PRI-769 §5: consumers must be real paths)',
        );
      }
    }
  }
  return violations;
}

describe('PRI-779 consumer reality guard — matcher units (synthetic fixtures)', () => {
  const file = (path: string, content: string): CorpusFile => ({ path, content });

  it('Case 1: quiet flag with a resolver read satisfies the zombie guard', () => {
    const files = [file('packages/x/src/a.ts', "const on = isFeatureEnabled(flags, 'alpha_flag');\n")];
    const violations = quietFlagReadViolations(files, { alpha_flag: 'KEEP_QUIET' });
    expect(violations).toEqual([]);
  });

  it('Case 2: census consumer path that does not exist fails the path guard', () => {
    const census = {
      alpha_flag: { decision: 'KEEP_QUIET', consumers: ['packages/foo/not-exist.ts'] } as unknown as QuietFlagLifecycleEntry,
    };
    const violations = censusPathViolations(census, ['packages/x/src/a.ts']);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('packages/foo/not-exist.ts');
  });

  it('Case 3: quiet flag with no executable read fails the zombie guard with an actionable message', () => {
    const violations = quietFlagReadViolations([], { alpha_flag: 'KEEP_QUIET' });
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("'alpha_flag'");
  });

  it('Case 4: STAGED flag with no consumer is exempt from the zombie guard', () => {
    const violations = quietFlagReadViolations([], { alpha_flag: 'STAGED' });
    expect(violations).toEqual([]);
  });

  it('Case 5: a runtime read of a gone flag fails the resurrection guard', () => {
    const files = [file('packages/x/src/a.ts', "return isFeatureEnabled(flags, 'retired_flag');\n")];
    const violations = goneFlagReadViolations(files, ['retired_flag']);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('packages/x/src/a.ts:1');
  });

  it('Case 6: display-layer, label-map, comment and test references never count as executable reads', () => {
    const files = [
      file('packages/x/src/a.test.ts', "const on = isFeatureEnabled(flags, 'alpha_flag');\n"),
      file('packages/x/src/__tests__/b.ts', "const on = isFeatureEnabled(flags, 'alpha_flag');\n"),
      file('packages/x/src/enum-labels.ts', "    'alpha_flag': '标签',\n"),
      file('packages/x/src/c.tsx', "const label = enumLabel('featureId', 'alpha_flag', t);\n"),
      file('packages/x/src/d.ts', "// the 'alpha_flag' flag was retired\n"),
      file('packages/x/src/e.ts', ' * - feature flag alpha_flag off\n'),
      // Multi-line JSX block comment (the empathy_observer ControlCenter case).
      file('packages/x/src/h.tsx', "{/*\n 'alpha_flag' (snake_case) is the featureId used for display. */}\n"),
      // Near-miss strings must not match: quoted id must be exact, not a prefix.
      file('packages/x/src/f.ts', "reason: 'alpha_flag_disabled',\n"),
      file('packages/x/src/g.ts', "track('alpha_flag_result', {}),\n"),
      // Import path './alpha_flag.js' is not a member access on a receiver.
      file('packages/x/src/i.ts', "import { x } from './alpha_flag.js';\n"),
    ];
    const violations = quietFlagReadViolations(files, { alpha_flag: 'KEEP_QUIET' });
    expect(violations.length).toBe(1);
  });

  it('Guard 3 exemptions are file-scoped: exempt paths hide validation metadata only', () => {
    const files = [file('packages/create-principles-disciple/src/mvp-config.ts', "const GONE = ['retired_flag'];\n")];
    const violations = goneFlagReadViolations(files, ['retired_flag']);
    expect(violations).toEqual([]);
  });
});

describe('PRI-779 consumer reality guard — real sources', () => {
  const corpus = loadRealCorpus();
  const corpusPaths = corpus.map(f => f.path);

  it('scanner sanity: the corpus walks real production sources (fail loud on empty scan)', () => {
    expect(corpusPaths.length).toBeGreaterThan(500);
  });

  it('Guard 1: single-token census consumer paths resolve to real files', () => {
    const violations = censusPathViolations(QUIET_FLAG_LIFECYCLE, corpusPaths);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('Guard 2: every non-STAGED quiet flag has at least one executable consumer read', () => {
    const decisions: Record<string, QuietFlagLifecycleDecision> = {};
    for (const flag of quietFlags) {
      const entry = QUIET_FLAG_LIFECYCLE[flag.id];
      if (!entry) throw new Error(`quiet flag '${flag.id}' has no census entry (PRI-610 test should have caught this)`);
      decisions[flag.id] = entry.decision;
    }
    const violations = quietFlagReadViolations(corpus, decisions);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('Guard 3: gone tombstones have zero executable consumer reads', () => {
    const violations = goneFlagReadViolations(corpus, goneFlags.map(f => f.id));
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
