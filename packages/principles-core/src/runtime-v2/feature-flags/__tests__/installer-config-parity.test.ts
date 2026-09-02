import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_FEATURE_FLAGS } from '../feature-flag-contract.js';

// PRI-645: the installer's hardcoded .pd/config.yaml template
// (create-principles-disciple/src/mvp-config.ts) must NOT duplicate registry
// defaults. The old PRI-574 contract kept a full default snapshot "aligned"
// with the registry; the converged contract is that the duplicate must not
// exist at all — config records intent, the registry owns defaults.
//
// The installer package deliberately has no dependency on @principles/core
// (independent installability), so this contract lives on the core side and
// parses the installer SOURCE instead of importing it.

const REGISTRY_BY_ID = new Map(DEFAULT_FEATURE_FLAGS.map(f => [f.id, f]));

function findInstallerSource(): string {
  let dir = process.cwd();
  const relative = path.join('packages', 'create-principles-disciple', 'src', 'mvp-config.ts');
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`installer source not found: ${relative} — run from the monorepo checkout`);
}

interface InstallerFlagEntry {
  id: string;
  category: string;
  enabled: boolean;
}

function parseInstallerFeatures(source: string): InstallerFlagEntry[] {
  // Entries look like:
  //   prompt:             { category: 'core',  enabled: true, source: 'system' },
  //   'host.codex':        { category: 'core', enabled: true, source: 'system' },
  const entryPattern = /(^|\n)\s{6}'?([a-z0-9_.]+)'?:\s*\{\s*category:\s*'([a-z_]+)',\s*enabled:\s*(true|false),?\s*(?:source:\s*'[a-z_]+',?\s*)?\}/g;
  const entries: InstallerFlagEntry[] = [];
  for (const match of source.matchAll(entryPattern)) {
    // match[0] = whole match, match[1] = (^|\n) — skip both before the fields.
    const [, , id, category, enabledRaw] = match;
    if (!id || !category || !enabledRaw) {
      throw new Error(`malformed installer feature entry matched at index ${match.index}`);
    }
    entries.push({ id, category, enabled: enabledRaw === 'true' });
  }
  return entries;
}

describe('PRI-645 installer bootstrap config ↔ registry sparse-override contract', () => {
  const source = fs.readFileSync(findInstallerSource(), 'utf8');
  const entries = parseInstallerFeatures(source);

  it("declares an empty features map in the fresh template (no snapshot of registry defaults)", () => {
    // Template-shape guard: the literal `features: {}` must be present in
    // generateConfigYamlContent. If this fails, the template shape changed —
    // update this contract deliberately (an intentional bootstrap override is
    // legal but must satisfy the contracts below).
    expect(source).toContain('features: {},');
  });

  it('materializes zero default-equivalent registry entries (duplicate defaults must not exist)', () => {
    // Contract A: any entry the installer writes whose category AND enabled
    // equal the registry default is a forbidden default snapshot — it would
    // freeze today's defaults against future registry flips.
    const snapshots = entries
      .filter(e => {
        const def = REGISTRY_BY_ID.get(e.id);
        return def !== undefined && def.category === e.category && def.enabled === e.enabled;
      })
      .map(e => e.id);
    expect(
      snapshots,
      `installer materializes registry-default-equivalent entries: ${snapshots.join(', ')} — remove them; defaults belong to the registry`,
    ).toEqual([]);
  });

  it('every bootstrap entry exists in the runtime registry (no orphans)', () => {
    const orphans = entries.filter(e => !REGISTRY_BY_ID.has(e.id)).map(e => e.id);
    expect(orphans, `installer writes flags unknown to the registry: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every bootstrap entry differs from the registry default (intentional override only)', () => {
    // Contract C: a bootstrap entry is legal only as a DELIBERATE deviation.
    // There is no allowlist: if an entry equals the default, Contract A
    // already fails it. This test keeps the intent explicit for future edits.
    const equivalences = entries
      .filter(e => {
        const def = REGISTRY_BY_ID.get(e.id);
        return def !== undefined && def.category === e.category && def.enabled === e.enabled;
      })
      .map(e => e.id);
    expect(equivalences).toEqual([]);
    // Current expected steady state: zero bootstrap overrides at all.
    expect(entries, 'if adding a bootstrap override, document the product/safety reason in mvp-config.ts and update this expectation').toEqual([]);
  });
});
