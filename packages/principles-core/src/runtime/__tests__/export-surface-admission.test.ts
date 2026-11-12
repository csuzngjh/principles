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
 * process — and replays the failure paths against temporary copies of the
 * fixtures, so a gate that silently passed everything would itself fail here.
 *
 * P0 blocks increments only: the baseline contains the current 2,351 symbols
 * and an empty admissions file, so the first run is green by construction.
 */
import { describe, expect, it } from 'vitest';

describe('core export surface admission gate', () => {
  const GATE_SCRIPT = 'scripts/check-core-export-surface.mjs';
  const FIXTURES = 'packages/principles-core/src/runtime/__tests__/fixtures';

  async function repoRoot(): Promise<string> {
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    return pathMod.resolve(__dirname, '..', '..', '..', '..', '..');
  }

  async function runGate(args: string[]) {
    const childMod: typeof import('node:child_process') = await import('node:child_process'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const root = await repoRoot();
    return childMod.spawnSync(
      process.execPath,
      [pathMod.join(root, GATE_SCRIPT), ...args],
      { cwd: root, encoding: 'utf8', timeout: 120_000 },
    );
  }

  function output(result: { status: number | null; stdout: string; stderr: string }): string {
    return `exit=${String(result.status)}:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
  }

  interface BaselineFile {
    entries: { entry: string; source: string; count: number; symbols: string[] }[];
    subpaths: string[];
  }

  interface AdmissionFile {
    admissions: Record<string, unknown>[];
    removals: Record<string, unknown>[];
  }

  /**
   * Runs the gate against a temporary baseline/admissions copy. `mutate` edits
   * the parsed fixtures in place; the temp files are removed afterwards so the
   * checked-in fixtures are never touched.
   */
  async function runWithFixtures(
    mutate: (fixtures: { baseline: BaselineFile; admissions: AdmissionFile }) => void,
    args: string[] = [],
  ) {
    const fsMod: typeof import('node:fs') = await import('node:fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const osMod: typeof import('node:os') = await import('node:os'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const root = await repoRoot();
    const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'pd-export-surface-'));

    try {
      const baseline = JSON.parse(
        fsMod.readFileSync(pathMod.join(root, FIXTURES, 'export-surface-baseline.json'), 'utf-8'),
      ) as BaselineFile;
      const admissions = JSON.parse(
        fsMod.readFileSync(pathMod.join(root, FIXTURES, 'export-admissions.json'), 'utf-8'),
      ) as AdmissionFile;
      mutate({ baseline, admissions });

      const baselinePath = pathMod.join(dir, 'baseline.json');
      const admissionsPath = pathMod.join(dir, 'admissions.json');
      fsMod.writeFileSync(baselinePath, JSON.stringify(baseline), 'utf-8');
      fsMod.writeFileSync(admissionsPath, JSON.stringify(admissions), 'utf-8');

      return await runGate([
        '--baseline', baselinePath,
        '--admissions', admissionsPath,
        ...args,
      ]);
    } finally {
      fsMod.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('the 27 entry points match the frozen baseline (0 added, 0 removed)', async () => {
    const result = await runGate([]);
    expect(result.status, output(result)).toBe(0);
    expect(result.stdout).toContain('27 entry points');
    expect(result.stdout).toContain('matches the frozen baseline (0 added, 0 removed)');
  });

  it('every frozen entry yields at least one symbol (an AST extractor, not a regex)', async () => {
    const fsMod: typeof import('node:fs') = await import('node:fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('node:path') = await import('node:path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const root = await repoRoot();
    const baseline = JSON.parse(
      fsMod.readFileSync(pathMod.join(root, FIXTURES, 'export-surface-baseline.json'), 'utf-8'),
    ) as BaselineFile;

    // `./trajectory-types` is 31 `export type X = ...` declarations: the PRI-775
    // regex would freeze it as an empty set. Keeping this assertion means a
    // regression to regex extraction cannot land silently.
    expect(baseline.entries).toHaveLength(27);
    for (const entry of baseline.entries) {
      expect(entry.count, `${entry.entry} (${entry.source}) froze no symbols`).toBeGreaterThan(0);
    }
  });

  it('fails when a symbol is added without an admission record', async () => {
    const result = await runWithFixtures(({ baseline }) => {
      const target = baseline.entries.find((e) => e.entry === './runtime');
      if (!target) throw new Error('./runtime missing from baseline');
      const dropped = target.symbols[target.symbols.length - 1];
      target.symbols = target.symbols.filter((s) => s !== dropped);
      target.count = target.symbols.length;
    });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('[added-export] ./runtime :: ');
    expect(result.stderr).toContain('export-admissions.json');
    expect(result.stderr).toContain('whyNotInternal');
    expect(result.stderr).toContain('alternativeConsidered');
  });

  it('fails when a symbol disappears without a removal record + changeset', async () => {
    const ghost = 'ZzGateGhostRemovedSymbol';
    const result = await runWithFixtures(({ baseline }) => {
      const target = baseline.entries.find((e) => e.entry === './runtime');
      if (!target) throw new Error('./runtime missing from baseline');
      target.symbols = [...target.symbols, ghost].sort();
      target.count = target.symbols.length;
    });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain(`[removed-export] ./runtime :: ${ghost}`);
    expect(result.stderr).toContain('removals');
    expect(result.stderr).toContain('changeset');
  });

  it('fails when an entry point appears without a subpath admission', async () => {
    const result = await runWithFixtures(({ baseline }) => {
      baseline.subpaths = baseline.subpaths.filter((s) => s !== './host');
    });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('[new-subpath] ./host');
  });

  it('fails when an admitted exception has expired', async () => {
    const result = await runWithFixtures(({ admissions }) => {
      admissions.admissions = [{
        entry: './runtime',
        symbol: 'ZzGateAdmittedSymbol',
        kind: 'value',
        addedIn: 'PRI-9999',
        consumers: ['packages/codex-adapter/src/pd-hook.ts'],
        whyNotInternal: 'Host adapters need the value at runtime; no narrow subpath exposes it yet.',
        alternativeConsidered: 'Narrow subpath ./runtime/zz-gate; rejected because it would be a one-symbol entry.',
        exception: {
          approvedBy: 'owner',
          reason: 'Temporary bridge while the store port lands.',
          ticket: 'PRI-9999',
          expiresAt: '2020-01-01',
        },
      }];
    });

    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain('exception expired on 2020-01-01');
  });
});
