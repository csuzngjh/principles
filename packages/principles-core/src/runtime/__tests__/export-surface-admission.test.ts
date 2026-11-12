/**
 * Export-surface admission gate (P0: freeze the public surface, block increments).
 *
 * `packages/principles-core` exposes 27 `package.json#exports` subpaths. The
 * audit in docs/reports/PD_CORE_EXPORT_SURFACE_RULE_DRAFT_20261112.md found the
 * surface growing twice as fast as real demand (3-day window: +72 public
 * symbols, +35 externally referenced). PRI-775 froze only the two barrels, and
 * its regex extractor cannot see `export type X = ...`, so it cannot be widened
 * to the remaining 25 entries.
 *
 * The gate itself lives in scripts/check-core-export-surface.mjs (TS AST). This
 * test runs it inside the existing `Test principles-core` job — no new CI
 * process — and replays the failure paths against temporary fixture copies, so
 * a gate that silently passed everything would itself fail here.
 *
 * The reference surface comes from the base commit (`git merge-base origin/main
 * HEAD`), not from the checked-in baseline file: comparing a source tree with a
 * file that ships in the same commit is self-certification, and re-recording
 * the baseline would launder any addition.
 */
import { describe, expect, it } from 'vitest';

describe('core export surface admission gate', () => {
  const GATE_SCRIPT = 'scripts/check-core-export-surface.mjs';
  const FIXTURES = 'packages/principles-core/src/runtime/__tests__/fixtures';

  async function repoRoot(): Promise<string> {
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    return pathMod.resolve(__dirname, '..', '..', '..', '..', '..');
  }

  async function runGate(args: string[], env: Record<string, string> = {}) {
    const childMod: typeof import('node:child_process') = await import('node:child_process'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const root = await repoRoot();
    return childMod.spawnSync(
      process.execPath,
      [pathMod.join(root, GATE_SCRIPT), ...args],
      { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } },
    );
  }

  function output(result: { status: number | null; stdout: string; stderr: string }): string {
    return `exit=${String(result.status)}:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
  }

  interface BaselineFile {
    subpaths: string[];
    entries: { entry: string; source: string; count: number; symbols: string[] }[];
  }

  interface AdmissionRecord {
    entry: string;
    symbol: string;
    kind: string;
    addedIn: string;
    expiresAt?: string;
    consumers: string[];
    whyNotInternal: string;
    alternativeConsidered: string;
    exception?: Record<string, unknown>;
  }

  interface AdmissionFile {
    schemaVersion: number;
    admissions: AdmissionRecord[];
    removals: Record<string, unknown>[];
  }

  interface Fixtures {
    baseline: BaselineFile;
    admissions: AdmissionFile;
  }

  const HOST_ENTRY = './host';
  const HOST_SYMBOL = 'HostEventResult';
  const HOST_CONSUMER = 'packages/workbuddy-adapter/src/pd-hook.ts';
  const HOST_NON_CONSUMER = 'packages/workbuddy-adapter/src/explicit-owner-statement.ts';

  function hostAdmission(overrides: Partial<AdmissionRecord> = {}): AdmissionRecord {
    return {
      entry: HOST_ENTRY,
      symbol: HOST_SYMBOL,
      kind: 'type',
      addedIn: 'PRI-9999',
      expiresAt: '2099-01-01',
      consumers: [HOST_CONSUMER],
      whyNotInternal: 'Host adapters need the value at runtime; no narrow subpath exposes it yet.',
      alternativeConsidered: 'Narrow subpath ./host/<domain>; rejected because it would be a one-symbol entry.',
      ...overrides,
    };
  }

  /**
   * Runs the gate against temporary working and anchor copies. Both start from
   * the checked-in fixtures; `mutate` edits them in place. The temp files are
   * removed afterwards, so the checked-in fixtures are never touched.
   */
  async function runWithFixtures(
    mutate: (fixtures: { working: Fixtures; anchor: Fixtures }) => void,
    options: { baseChangesets?: string[] } = {},
  ) {
    const fsMod: typeof import('node:fs') = await import('node:fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const osMod: typeof import('node:os') = await import('node:os'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const root = await repoRoot();
    const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'pd-export-surface-'));

    try {
      const committed: Fixtures = {
        baseline: JSON.parse(fsMod.readFileSync(pathMod.join(root, FIXTURES, 'export-surface-baseline.json'), 'utf-8')) as BaselineFile,
        admissions: JSON.parse(fsMod.readFileSync(pathMod.join(root, FIXTURES, 'export-admissions.json'), 'utf-8')) as AdmissionFile,
      };
      const working: Fixtures = JSON.parse(JSON.stringify(committed)) as Fixtures;
      const anchor: Fixtures = JSON.parse(JSON.stringify(committed)) as Fixtures;
      mutate({ working, anchor });

      const write = (name: string, value: unknown): string => {
        const file = pathMod.join(dir, `${name}.json`);
        fsMod.writeFileSync(file, JSON.stringify(value), 'utf-8');
        return file;
      };

      return await runGate([
        '--baseline', write('working-baseline', working.baseline),
        '--admissions', write('working-admissions', working.admissions),
        '--anchor-baseline', write('anchor-baseline', anchor.baseline),
        '--anchor-admissions', write('anchor-admissions', anchor.admissions),
        '--base-changesets', write('base-changesets', options.baseChangesets ?? []),
      ], {
        // The guard test is the only code allowed to inject a reference; it is
        // CODEOWNED, and the gate refuses these flags in CI without this opt-in.
        PD_EXPORT_GATE_ALLOW_OVERRIDES: '1',
      });
    } finally {
      fsMod.rmSync(dir, { recursive: true, force: true });
    }
  }

  function dropHostSymbol(fixtures: Fixtures): void {
    const entry = fixtures.baseline.entries.find((e) => e.entry === HOST_ENTRY);
    if (!entry) throw new Error(`${HOST_ENTRY} missing from baseline`);
    entry.symbols = entry.symbols.filter((s) => s !== HOST_SYMBOL);
    entry.count = entry.symbols.length;
  }

  it('matches the base commit (0 added, 0 removed) on an untouched tree', async () => {
    const fsMod: typeof import('node:fs') = await import('node:fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const root = await repoRoot();
    const baseline = JSON.parse(
      fsMod.readFileSync(pathMod.join(root, FIXTURES, 'export-surface-baseline.json'), 'utf-8'),
    ) as BaselineFile;

    const result = await runGate([]);
    expect(result.status, output(result)).toBe(0);
    // On a push build the anchor resolves to HEAD and the gate states that
    // there is no PR diff to compare; branch protection only needs the PR path.
    if (!result.stdout.includes('there is no PR diff to compare against')) {
      expect(result.stdout).toContain(`${baseline.subpaths.length} entry points`);
      expect(result.stdout).toContain('0 added, 0 removed');
    }
  });

  it('freezes every entry with a real symbol set (an AST extractor, not a regex)', async () => {
    const fsMod: typeof import('node:fs') = await import('node:fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const root = await repoRoot();
    const baseline = JSON.parse(
      fsMod.readFileSync(pathMod.join(root, FIXTURES, 'export-surface-baseline.json'), 'utf-8'),
    ) as BaselineFile;

    // `./trajectory-types` is 31 `export type X = ...` declarations: the PRI-775
    // regex would freeze it as an empty set. Keeping this assertion means a
    // regression to regex extraction cannot land silently.
    expect(baseline.entries).toHaveLength(baseline.subpaths.length);
    for (const entry of baseline.entries) {
      expect(entry.count, `${entry.entry} (${entry.source}) froze no symbols`).toBeGreaterThan(0);
    }
  });

  it('fails when a symbol is added without an admission record', async () => {
    const result = await runWithFixtures(({ anchor }) => dropHostSymbol(anchor));

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain(`[added-export] ${HOST_ENTRY} :: ${HOST_SYMBOL}`);
    expect(result.stderr).toContain('export-admissions.json');
    expect(result.stderr).toContain('whyNotInternal');
    expect(result.stderr).toContain('alternativeConsidered');
  });

  it('does not launder an addition when the checked-in baseline is re-recorded', async () => {
    // This is the bypass the review reproduced: add an export, then rewrite the
    // baseline. The working copy here already lists the symbol (as `--write`
    // would); the anchor does not, so the addition must still be blocked.
    const result = await runWithFixtures(({ working, anchor }) => {
      dropHostSymbol(anchor);
      expect(working.baseline.entries.find((e) => e.entry === HOST_ENTRY)?.symbols).toContain(HOST_SYMBOL);
    });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain(`[added-export] ${HOST_ENTRY} :: ${HOST_SYMBOL}`);
  });

  it('fails when a symbol disappears without a removal record + changeset', async () => {
    const ghost = 'ZzGateGhostRemovedSymbol';
    const result = await runWithFixtures(({ anchor }) => {
      const entry = anchor.baseline.entries.find((e) => e.entry === HOST_ENTRY);
      if (!entry) throw new Error(`${HOST_ENTRY} missing from baseline`);
      entry.symbols = [...entry.symbols, ghost].sort();
      entry.count = entry.symbols.length;
    });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain(`[removed-export] ${HOST_ENTRY} :: ${ghost}`);
    expect(result.stderr).toContain('removals');
    expect(result.stderr).toContain('changeset');
  });

  it('requires one admission per symbol for a new subpath, not just the subpath record', async () => {
    const result = await runWithFixtures(({ working, anchor }) => {
      anchor.baseline.subpaths = anchor.baseline.subpaths.filter((s) => s !== HOST_ENTRY);
      working.admissions.admissions = [{
        entry: HOST_ENTRY,
        symbol: HOST_ENTRY,
        kind: 'subpath',
        addedIn: 'PRI-9999',
        expiresAt: '2099-01-01',
        consumers: ['packages/workbuddy-adapter/src/codec/input-decoder.ts'],
        whyNotInternal: 'Host adapters import this entry directly; a single shared barrel keeps the contract readable.',
        alternativeConsidered: 'Keep re-exporting through the root barrel; rejected because the root barrel is already wide.',
      }];
    });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain(`[new-subpath-symbol] ${HOST_ENTRY} :: `);
  });

  it('fails when an admission has expired', async () => {
    const result = await runWithFixtures(({ working, anchor }) => {
      dropHostSymbol(anchor);
      working.admissions.admissions = [hostAdmission({ expiresAt: '2020-01-01' })];
    });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('admission expired on 2020-01-01');
  });

  it('fails when an admission has no expiry', async () => {
    const result = await runWithFixtures(({ working, anchor }) => {
      dropHostSymbol(anchor);
      const record = hostAdmission();
      delete record.expiresAt;
      working.admissions.admissions = [record];
    });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('`expiresAt` must be a YYYY-MM-DD date');
  });

  it('fails when a consumer does not actually import the symbol', async () => {
    const result = await runWithFixtures(({ working, anchor }) => {
      dropHostSymbol(anchor);
      working.admissions.admissions = [hostAdmission({ consumers: [HOST_NON_CONSUMER] })];
    });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('does not import');
    expect(result.stderr).toContain(HOST_SYMBOL);
  });

  it('rejects an admission that was recorded before the symbol became public', async () => {
    const result = await runWithFixtures(({ working, anchor }) => {
      dropHostSymbol(anchor);
      const record = hostAdmission();
      working.admissions.admissions = [record];
      anchor.admissions.admissions = [record];
    });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('must land in the same PR');
  });

  it('passes when a new symbol has a live, import-verified admission', async () => {
    const result = await runWithFixtures(({ working, anchor }) => {
      dropHostSymbol(anchor);
      working.admissions.admissions = [hostAdmission()];
    });

    expect(result.status, output(result)).toBe(0);
    expect(result.stdout).toContain('+1 / -0');
    expect(result.stdout).toContain('this change relaxes the surface');
    expect(result.stdout).toContain(`+ ${HOST_ENTRY} :: ${HOST_SYMBOL}`);
    expect(result.stdout).toContain('expires 2099-01-01');
  });

  it('refuses an anchor that is HEAD or contains HEAD', async () => {
    // Pin the event so the assertion also holds on a push build of main.
    const result = await runGate(['--anchor-ref', 'HEAD'], { GITHUB_EVENT_NAME: 'pull_request' });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('resolves to HEAD');
    expect(result.stderr).toContain('grade its own commit');
  });

  it('requires the removal changeset to be added by this PR, not an existing one', async () => {
    const ghost = 'ZzGateGhostRemovedSymbol';
    const existing = '.changeset/host-tool-declaration-v2.md';
    const result = await runWithFixtures(({ working, anchor }) => {
      const entry = anchor.baseline.entries.find((e) => e.entry === HOST_ENTRY);
      if (!entry) throw new Error(`${HOST_ENTRY} missing from baseline`);
      entry.symbols = [...entry.symbols, ghost].sort();
      entry.count = entry.symbols.length;
      working.admissions.removals = [{
        entry: HOST_ENTRY,
        symbol: ghost,
        removedIn: 'PRI-9999',
        changeset: existing,
      }];
    }, { baseChangesets: [existing] });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('already exists at the base commit');
  });

  it('refuses a replayed clock in CI', async () => {
    const result = await runGate(['--today', '1970-01-01'], { GITHUB_ACTIONS: 'true' });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('--today 1970-01-01 is not allowed in CI');
  });

  it('refuses injected anchor files in CI without the guard-test opt-in', async () => {
    const result = await runGate(
      ['--anchor-baseline', 'anchor.json', '--admissions', 'admissions.json'],
      { GITHUB_ACTIONS: 'true' },
    );

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('not allowed in CI outside the guard test');
  });
});
