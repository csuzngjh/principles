/**
 * MCP launcher parity (Round 3 §4.4 / review N3d+N3k follow-up).
 *
 * The launcher ships in THREE tracked locations (the canonical Codex payload
 * plus the OpenClaw / WorkBuddy host copies) and MUST stay byte-identical:
 * `resolveHostRoots()` carries the HOME-first resolution and the
 * PD_EXPERIMENT_ROOT containment gate, this parity test is the drift guard so
 * a behavior fix applied to one copy and missed by another fails CI instead of
 * giving one host a different isolation contract. The cpd bundle scripts copy
 * the canonical at build time; the host-package copies are tracked files.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, '..', '..', '..');

/** Compile-time-fixed locations of the tracked launcher payloads. */
const LAUNCHER_LOCATIONS = [
  path.join(REPO_ROOT, 'plugins', 'principles-disciple', 'mcp', 'launcher.cjs'),
  path.join(REPO_ROOT, 'packages', 'openclaw-plugin', 'mcp', 'launcher.cjs'),
  path.join(REPO_ROOT, 'packages', 'workbuddy-adapter', 'plugin', 'mcp', 'launcher.cjs'),
] as const;

/** Mimosa-recommended containment check: every fixture path must stay inside the repo root. */
function assertInsideRepo(file: string): string {
  const resolved = path.resolve(file);
  if (resolved !== REPO_ROOT && !resolved.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`fixture path escaped the repo root: ${file}`);
  }
  return resolved;
}

describe('MCP launcher parity across the three tracked payloads', () => {
  it('all launcher copies are byte-identical to the canonical payload', () => {
    const digests = LAUNCHER_LOCATIONS.map((file) => {
      const inside = assertInsideRepo(file);
      const bytes = readFileSync(inside);
      return { file: inside, digest: createHash('sha256').update(bytes).digest('hex') };
    });

    const canonical = digests[0]!;
    for (const entry of digests.slice(1)) {
      expect(entry.digest, `${entry.file} drifted from the canonical ${canonical.file}`).toBe(canonical.digest);
    }
    // Guard the guard: the launcher must actually contain the isolation
    // entry points this parity contract exists for.
    expect(readFileSync(canonical.file, 'utf8')).toContain('resolveRealUserHomeLikeSharedResolver');
  });
});
