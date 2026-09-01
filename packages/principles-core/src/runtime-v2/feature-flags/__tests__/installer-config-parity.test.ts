import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_FEATURE_FLAGS } from '../feature-flag-contract.js';

// PRI-574: prevent silent drift between the installer's hardcoded
// .pd/config.yaml template (create-principles-disciple/src/mvp-config.ts)
// and the runtime registry (DEFAULT_FEATURE_FLAGS). The installer package
// deliberately has no dependency on @principles/core (independent
// installability), so this contract lives on the core side and parses the
// installer SOURCE instead of importing it.

const REGISTRY_IDS = new Set(DEFAULT_FEATURE_FLAGS.map(f => f.id));
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
  // (PRI-637: entries carry a system provenance label — tolerated, not required.)
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
  if (entries.length === 0) {
    throw new Error('parsed zero installer feature entries — mvp-config.ts template shape changed; update this parser');
  }
  return entries;
}

describe('PRI-574 installer config template ↔ runtime flag registry parity', () => {
  const source = fs.readFileSync(findInstallerSource(), 'utf8');
  const entries = parseInstallerFeatures(source);

  it('every flag written by the installer exists in the runtime registry (no orphans)', () => {
    const orphans = entries.filter(e => !REGISTRY_IDS.has(e.id)).map(e => e.id);
    expect(orphans, `installer writes flags unknown to the registry: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every installer flag category matches the registry category', () => {
    const mismatches = entries
      .filter(e => REGISTRY_IDS.has(e.id))
      .filter(e => REGISTRY_BY_ID.get(e.id)?.category !== e.category)
      .map(e => `${e.id}: installer=${e.category} registry=${REGISTRY_BY_ID.get(e.id)?.category}`);
    expect(mismatches, `category drift detected: ${mismatches.join('; ')}`).toEqual([]);
  });

  it('keeps installer enabled values aligned with runtime defaults', () => {
    const mismatches = entries
      .filter(e => REGISTRY_IDS.has(e.id))
      .filter(e => e.enabled !== REGISTRY_BY_ID.get(e.id)?.enabled)
      .map(e => `${e.id}: installer=${e.enabled} registry=${REGISTRY_BY_ID.get(e.id)?.enabled}`);
    expect(mismatches, `enabled-value drift detected: ${mismatches.join('; ')}`).toEqual([]);
  });
});
