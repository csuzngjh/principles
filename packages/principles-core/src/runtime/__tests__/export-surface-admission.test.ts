/**
 * Export-surface admission gate (P0: freeze the public surface, block increments).
 *
 * `packages/principles-core` exposes 28 `package.json#exports` subpaths. The
 * audit in docs/reports/PD_CORE_EXPORT_SURFACE_RULE_DRAFT_20261112.md found the
 * surface growing twice as fast as real demand. PRI-775 froze only the two
 * barrels with a regex that cannot see `export type X = ...`.
 *
 * The gate itself is scripts/check-core-export-surface.mjs (TS AST, reference =
 * base commit). Its REAL-TREE verdict runs in its own unconditional CI job
 * (`Export Surface Gate` in ci.yml), not here: that verdict depends on git
 * topology (merge-base with origin/main), so running it inside
 * `Test principles-core` made a required unit-test job red whenever the base
 * branch advanced or a changeset window straddled two PRs. This file keeps the
 * part that is deterministic and topology-free:
 *   - in-process library calls with constructed objects for every failure path
 *     (no CLI flags, no temp "reference" files, no replayed clock: there is no
 *     argv surface that could relax a rule);
 *   - the CLI's own argument rules, which are rejected before any git read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildBaseline,
  evaluateSurface,
  extractEntrySymbols,
  type AdmissionRecord,
  type Admissions,
  type Baseline,
  type Surface,
} from '../../../../../scripts/check-core-export-surface.mjs';

describe('core export surface admission gate', () => {
  const GATE_SCRIPT = 'scripts/check-core-export-surface.mjs';
  const ENTRY = './host';
  const SYMBOL = 'HostEventResult';
  const CONSUMER = 'packages/consumer/src/consumer.ts';
  const NON_CONSUMER = 'packages/consumer/src/other.ts';
  const UNUSED_CONSUMER = 'packages/consumer/src/unused.ts';
  const PROPERTY_KEY_CONSUMER = 'packages/consumer/src/property-key.ts';
  const ALIASED_CONSUMER = 'packages/consumer/src/aliased.ts';
  const REEXPORT_CONSUMER = 'packages/consumer/src/reexport.ts';
  const NEW_CHANGESET = '.changeset/new-note.md';
  const OLD_CHANGESET = '.changeset/old-note.md';

  let repoRoot = '';
  let fixtureRoot = '';

  async function repoRootPath(): Promise<string> {
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    return pathMod.resolve(__dirname, '..', '..', '..', '..', '..');
  }

  async function runGate(args: string[], env: Record<string, string> = {}) {
    const childMod: typeof import('node:child_process') = await import('node:child_process'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    return childMod.spawnSync(
      process.execPath,
      [pathMod.join(repoRoot, GATE_SCRIPT), ...args],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } },
    );
  }

  /** Runs the CLI as if it were outside CI, so the non-CI argument rules are reachable. */
  async function runGateOutsideCi(args: string[]) {
    const childMod: typeof import('node:child_process') = await import('node:child_process'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const env: Record<string, string | undefined> = { ...process.env };
    for (const marker of ['CI', 'GITHUB_WORKFLOW', 'GITHUB_RUN_ID', 'GITHUB_SHA', 'GITHUB_ACTIONS']) {
      delete env[marker];
    }
    return childMod.spawnSync(
      process.execPath,
      [pathMod.join(repoRoot, GATE_SCRIPT), ...args],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, env },
    );
  }

  function output(result: { status: number | null; stdout: string; stderr: string }): string {
    return `exit=${String(result.status)}:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
  }

  /** Minimal surface used by the failure paths: one entry, two symbols. */
  function makeSurface(symbols = ['HostEvent', SYMBOL]): Surface {
    return { subpaths: [ENTRY], entries: { [ENTRY]: { source: 'src/host/index.ts', symbols } } };
  }

  function makeBaseline(symbols = ['HostEvent', SYMBOL]): Baseline {
    return buildBaseline(makeSurface(symbols));
  }

  function admission(overrides: Partial<AdmissionRecord> = {}): AdmissionRecord {
    return {
      entry: ENTRY,
      symbol: SYMBOL,
      kind: 'type',
      addedIn: 'PRI-9999',
      expiresAt: '2099-01-01',
      consumers: [CONSUMER],
      whyNotInternal: 'Host adapters need the value at runtime; no narrow subpath exposes it yet.',
      alternativeConsidered: 'Narrow subpath ./host/<domain>; rejected because it would be a one-symbol entry.',
      ...overrides,
    };
  }

  function admitted(overrides: Partial<AdmissionRecord> = {}): Admissions {
    return { schemaVersion: 2, admissions: [admission(overrides)], removals: [] };
  }

  function evaluate(overrides: {
    surface?: Surface;
    baseline?: Baseline;
    anchor?: Baseline;
    admissions?: Admissions;
    anchorAdmissions?: Admissions;
    baseChangesets?: string[];
    today?: string;
  }) {
    return evaluateSurface({
      surface: overrides.surface ?? makeSurface(),
      baseline: overrides.baseline ?? makeBaseline(),
      anchor: overrides.anchor ?? makeBaseline(['HostEvent']),
      admissions: overrides.admissions ?? { schemaVersion: 2, admissions: [], removals: [] },
      anchorAdmissions: overrides.anchorAdmissions ?? { schemaVersion: 2, admissions: [], removals: [] },
      anchorLabel: 'origin/main@00000000',
      baseChangesets: new Set(overrides.baseChangesets ?? [OLD_CHANGESET]),
      repoRoot: fixtureRoot,
      today: overrides.today ?? '2026-11-12',
    });
  }

  beforeAll(async () => {
    const fsMod: typeof import('node:fs') = await import('node:fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const osMod: typeof import('node:os') = await import('node:os'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    repoRoot = await repoRootPath();
    fixtureRoot = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'pd-export-surface-'));
    fsMod.mkdirSync(pathMod.join(fixtureRoot, 'packages', 'consumer', 'src'), { recursive: true });
    fsMod.mkdirSync(pathMod.join(fixtureRoot, '.changeset'), { recursive: true });
    fsMod.writeFileSync(
      pathMod.join(fixtureRoot, CONSUMER),
      "import type { HostEvent, HostEventResult } from '@principles/core/host';\n"
      + 'export type Both = [HostEvent, HostEventResult];\n',
    );
    fsMod.writeFileSync(
      pathMod.join(fixtureRoot, NON_CONSUMER),
      "import type { HostEvent } from '@principles/core/host';\nexport type Only = HostEvent;\n",
    );
    fsMod.writeFileSync(
      pathMod.join(fixtureRoot, UNUSED_CONSUMER),
      "import type { HostEventResult } from '@principles/core/host';\nexport type Nothing = string;\n",
    );
    fsMod.writeFileSync(
      pathMod.join(fixtureRoot, PROPERTY_KEY_CONSUMER),
      "import type { HostEventResult } from '@principles/core/host';\nexport const bag = { HostEventResult: 1 };\n",
    );
    fsMod.writeFileSync(
      pathMod.join(fixtureRoot, ALIASED_CONSUMER),
      "import type { HostEventResult as Result } from '@principles/core/host';\nexport type Aliased = Result;\n",
    );
    fsMod.writeFileSync(
      pathMod.join(fixtureRoot, REEXPORT_CONSUMER),
      "export { HostEventResult } from '@principles/core/host';\n",
    );
    fsMod.writeFileSync(pathMod.join(fixtureRoot, NEW_CHANGESET), '---\n---\n\nnew note\n');
    fsMod.writeFileSync(pathMod.join(fixtureRoot, OLD_CHANGESET), '---\n---\n\nold note\n');
  });

  afterAll(async () => {
    const fsMod: typeof import('node:fs') = await import('node:fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    if (fixtureRoot) fsMod.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  // ── The real tree ──────────────────────────────────────────────────────────

  // The real-tree VERDICT (`runGate([])` against `merge-base origin/main HEAD`)
  // now runs in the unconditional `Export Surface Gate` CI job. It is git-
  // topology dependent by design, so it must not gate `Test principles-core`:
  // a PR whose base branch advanced, or whose removal changeset was already at
  // the base commit, made this required unit-test job red for reasons that have
  // nothing to do with the unit under test.

  it('freezes every entry with a real symbol set', async () => {
    const fsMod: typeof import('node:fs') = await import('node:fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const baseline = JSON.parse(fsMod.readFileSync(
      pathMod.join(repoRoot, 'packages/principles-core/src/runtime/__tests__/fixtures/export-surface-baseline.json'),
      'utf-8',
    )) as Baseline;

    expect(baseline.entries).toHaveLength(baseline.subpaths.length);
    for (const entry of baseline.entries) {
      expect(entry.count, `${entry.entry} (${entry.source}) froze no symbols`).toBeGreaterThan(0);
    }
  });

  it('extracts `export type`, aliases and namespace exports with the AST', () => {
    expect(extractEntrySymbols('entry.ts', [
      'export type Alpha = { a: string };',
      'export interface Beta { b: number }',
      'export { internal as Public } from "./internal.js";',
      'export * as ns from "./ns.js";',
      'export const gamma = 1, delta = 2;',
    ].join('\n'))).toEqual(['Alpha', 'Beta', 'Public', 'delta', 'gamma', 'ns']);

    expect(() => extractEntrySymbols('entry.ts', 'export * from "./x.js";')).toThrow(/export \*/);
    expect(() => extractEntrySymbols('entry.ts', 'export default 1;')).toThrow(/default/);
  });

  // ── Failure paths, in-process ──────────────────────────────────────────────

  it('fails when a symbol is added without an admission record', () => {
    const result = evaluate({});
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(`[added-export] ${ENTRY} :: ${SYMBOL}`);
    expect(result.errors.join('\n')).toContain('whyNotInternal');
    expect(result.errors.join('\n')).toContain('alternativeConsidered');
  });

  it('does not launder an addition when the checked-in baseline is re-recorded', () => {
    // The working baseline already lists the symbol (what `--write` produces);
    // the reference does not. The addition must still be blocked.
    const surface = makeSurface();
    const baseline = makeBaseline();
    expect(baseline.entries[0]?.symbols).toContain(SYMBOL);
    const result = evaluate({ surface, baseline });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(`[added-export] ${ENTRY} :: ${SYMBOL}`);
  });

  it('fails when a symbol disappears without a removal record', () => {
    const result = evaluate({
      surface: makeSurface(['HostEvent']),
      baseline: makeBaseline(['HostEvent']),
      anchor: makeBaseline(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(`[removed-export] ${ENTRY} :: ${SYMBOL}`);
    expect(result.errors.join('\n')).toContain('changeset');
  });

  it('rejects a removal announced by a changeset that already exists at the base', () => {
    const result = evaluate({
      surface: makeSurface(['HostEvent']),
      baseline: makeBaseline(['HostEvent']),
      anchor: makeBaseline(),
      admissions: {
        schemaVersion: 2,
        admissions: [],
        removals: [{ entry: ENTRY, symbol: SYMBOL, removedIn: 'PRI-9999', changeset: OLD_CHANGESET }],
      },
      baseChangesets: [OLD_CHANGESET],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('already exists at the base commit');
  });

  it('accepts a removal announced by a changeset this PR adds', () => {
    const result = evaluate({
      surface: makeSurface(['HostEvent']),
      baseline: makeBaseline(['HostEvent']),
      anchor: makeBaseline(),
      admissions: {
        schemaVersion: 2,
        admissions: [],
        removals: [{ entry: ENTRY, symbol: SYMBOL, removedIn: 'PRI-9999', changeset: NEW_CHANGESET }],
      },
      baseChangesets: [OLD_CHANGESET],
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.removed).toHaveLength(1);
    expect(result.delta).toEqual({ added: 0, removed: 1 });
  });

  // REGRESSION (latch bug): a removal record that already lived in the base
  // commit's admissions is historical. Its changeset is necessarily at the
  // base by now. The previous test is the negative control: the *same* record
  // introduced by this PR, pointing at a base changeset, must still be rejected.
  it('accepts a removal record inherited from the base commit', () => {
    const inherited = { entry: ENTRY, symbol: SYMBOL, removedIn: 'PRI-9998', changeset: OLD_CHANGESET };
    const result = evaluate({
      surface: makeSurface(['HostEvent']),
      baseline: makeBaseline(['HostEvent']),
      anchor: makeBaseline(),
      admissions: { schemaVersion: 2, admissions: [], removals: [inherited] },
      anchorAdmissions: { schemaVersion: 2, admissions: [], removals: [inherited] },
      baseChangesets: [OLD_CHANGESET],
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.removed).toHaveLength(1);
    expect(result.delta).toEqual({ added: 0, removed: 1 });
  });

  it('requires one admission per symbol for a new subpath, not just the subpath record', () => {
    const result = evaluate({
      anchor: { schemaVersion: 1, subpaths: [], entries: [] },
      admissions: {
        schemaVersion: 2,
        admissions: [admission({ entry: ENTRY, symbol: ENTRY, kind: 'subpath' })],
        removals: [],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(`[new-subpath-symbol] ${ENTRY} :: HostEvent`);
  });

  it('fails when an admission has expired', () => {
    const result = evaluate({ admissions: admitted({ expiresAt: '2020-01-01' }) });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('admission expired on 2020-01-01');
  });

  it('fails when an admission has no expiry', () => {
    const record = admission();
    delete record.expiresAt;
    const result = evaluate({ admissions: { schemaVersion: 2, admissions: [record], removals: [] } });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('`expiresAt` must be a YYYY-MM-DD date');
  });

  it('fails when a consumer does not actually import the symbol', () => {
    const result = evaluate({ admissions: admitted({ consumers: [NON_CONSUMER] }) });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('does not import');
    expect(result.errors.join('\n')).toContain(SYMBOL);
  });

  // PRI-1197: an import statement alone is not evidence of demand.
  it('fails when a consumer imports the symbol but never uses it', () => {
    const result = evaluate({ admissions: admitted({ consumers: [UNUSED_CONSUMER] }) });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('never uses it');
    expect(result.errors.join('\n')).toContain(SYMBOL);
  });

  it('does not count an object key named like the symbol as a usage point', () => {
    const result = evaluate({ admissions: admitted({ consumers: [PROPERTY_KEY_CONSUMER] }) });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('never uses it');
  });

  it('accepts a consumer that uses the symbol only in a type position', () => {
    const result = evaluate({ admissions: admitted({ consumers: [CONSUMER] }) });
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('resolves an aliased import to its local binding name', () => {
    const result = evaluate({ admissions: admitted({ consumers: [ALIASED_CONSUMER] }) });
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('keeps a re-export as direct consumer evidence', () => {
    const result = evaluate({ admissions: admitted({ consumers: [REEXPORT_CONSUMER] }) });
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('accepts a subpath admission when that subpath is already public at the anchor', () => {
    // Base-branch push: HEAD is the base tip, so the anchor surface equals the
    // current surface. A subpath record's `symbol` is the entry path itself,
    // which never appears in the entry's symbol list; the pre-placement check
    // must compare subpaths, not symbols, for this kind.
    const record = admission({ entry: ENTRY, symbol: ENTRY, kind: 'subpath' });
    const records = { schemaVersion: 2, admissions: [record], removals: [] };
    const result = evaluate({
      surface: makeSurface(),
      baseline: makeBaseline(),
      anchor: makeBaseline(),
      admissions: records,
      anchorAdmissions: records,
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('rejects an admission that was recorded before the symbol became public', () => {
    const record = admission();
    const result = evaluate({
      admissions: { schemaVersion: 2, admissions: [record], removals: [] },
      anchorAdmissions: { schemaVersion: 2, admissions: [record], removals: [] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('must land in the same PR');
  });

  it('fails when an admission points at a symbol that exists nowhere', () => {
    const result = evaluate({ admissions: admitted({ symbol: 'GhostSymbol' }) });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('exists neither at the base commit nor in the current surface');
  });

  it('fails when the checked-in baseline drifts from the current surface', () => {
    const result = evaluate({ baseline: makeBaseline(['HostEvent']) });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('[baseline]');
  });

  it('passes when a new symbol has a live, import-verified admission', () => {
    const result = evaluate({ admissions: admitted() });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.delta).toEqual({ added: 1, removed: 0 });
    expect(result.admitted).toHaveLength(1);
    expect(result.admitted[0]?.symbol).toBe(SYMBOL);
  });

  // ── CLI: only two flags exist, and CI refuses both ─────────────────────────

  it('rejects the removed clock override flag', async () => {
    const result = await runGate(['--today', '1970-01-01']);
    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('unknown argument');
  });

  it('rejects an arbitrary commit as the anchor', async () => {
    const result = await runGateOutsideCi(['--anchor-ref', 'cd6a5d70']);
    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('is not allowed');
    expect(result.stderr).toContain('Only the base branch');
  });

  it('rejects HEAD as the anchor', async () => {
    const result = await runGateOutsideCi(['--anchor-ref', 'HEAD']);
    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('Only the base branch');
  });

  it('rejects --write in CI', async () => {
    const result = await runGate(['--write'], { CI: 'true' });
    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('not allowed in CI');
  });

  it('rejects --anchor-ref in CI even when it names the base branch', async () => {
    const result = await runGate(['--anchor-ref', 'origin/main'], { GITHUB_RUN_ID: '123' });
    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('not allowed in CI');
  });
});
