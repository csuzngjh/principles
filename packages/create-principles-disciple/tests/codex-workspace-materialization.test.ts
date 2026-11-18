/**
 * PRI-1247 review round (2026-11-18): the redirect/materialization pairing.
 *
 * Devin review 🔴 on PR #2700: an explicit `install --host codex --workspace
 * <foreign-host workspace>` REDIRECTS Codex to its own default workspace, but
 * the directory-creation condition only covered `--host all` non-explicit —
 * so the installer wrote a valid-shaped binding pointing at a MISSING
 * directory, which its own binding health check (`binding_workspace_missing`)
 * then failed. The Codex MCP surface stayed unusable while the install
 * reported a redirect note.
 *
 * Pinned here through the SAME decision the install flow executes
 * (`materializeCodexWorkspace`, injected I/O — no real fs):
 *   - a redirect (any install shape) MATERIALIZES the target;
 *   - the user's explicit, non-foreign workspace is never created;
 *   - the redirect note stays observable (rc-9).
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { installRunServesCodex, materializeCodexWorkspace, resolveHostRefreshTargets, runHostInstallers } from '../src/installer.js';
import type { HostInstallContext } from '@principles/core/host';

// Every workspace path in this file is produced by `path.resolve()` so the
// redirect comparison (`resolved !== path.resolve(explicit)`) stays
// platform-neutral: a raw POSIX string is relative on Windows and a raw
// Windows string is relative on Linux — both would masquerade as a redirect.
const FOREIGN = path.resolve('/data/openclaw');
const OWN_EXPLICIT = path.resolve('/data/my-own-project');
const CODEX_DEFAULT = path.resolve('/home/u/.codex/pd-workspace');

function io(codexDefault: string) {
  const ensured: string[] = [];
  const warnings: string[] = [];
  return {
    ensured,
    warnings,
    io: {
      resolve: (_options: { workspaceDir: string }, notes: string[]) => {
        // Mirrors resolveCodexHostWorkspace's redirect shape: a foreign target
        // falls back to Codex's own default and pushes the observable note.
        if (_options.workspaceDir === FOREIGN) {
          notes.push(`workspace "${FOREIGN}" is openclaw's declared PD workspace; Codex uses its own "${codexDefault}" instead (PRI-1247)`);
          return codexDefault;
        }
        return _options.workspaceDir;
      },
      ensureDir: async (dir: string) => {
        ensured.push(dir);
      },
      warn: (message: string) => {
        warnings.push(message);
      },
    },
  };
}

describe('materializeCodexWorkspace (PRI-1247 review: redirect ⇒ the target EXISTS before the binding is written)', () => {
  it('an explicit install against a foreign-host workspace redirects AND creates the Codex default', async () => {
    const { ensured, warnings, io: ioDeps } = io(CODEX_DEFAULT);
    const result = await materializeCodexWorkspace(
      { workspaceDir: FOREIGN },
      ioDeps,
    );
    expect(result.redirected).toBe(true);
    expect(result.codexWorkspaceDir).toBe(CODEX_DEFAULT);
    // THE regression: the redirect target is materialized, not just written
    // into a binding.
    expect(ensured).toEqual([CODEX_DEFAULT]);
    // rc-9: the redirect itself stays observable.
    expect(warnings.join(' ')).toContain('uses its own');
    expect(warnings.join(' ')).toContain('PRI-1247');
  });

  it('the user’s explicit non-foreign workspace is never created (it is theirs)', async () => {
    const { ensured, warnings, io: ioDeps } = io(CODEX_DEFAULT);
    const result = await materializeCodexWorkspace(
      { workspaceDir: OWN_EXPLICIT },
      ioDeps,
    );
    expect(result.redirected).toBe(false);
    expect(result.codexWorkspaceDir).toBe(OWN_EXPLICIT);
    expect(ensured).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

/**
 * Devin review 🔴 on PR #2700 (2026-11-18), second finding: the materialize
 * call ran for EVERY host install — an OpenClaw-only run from a foreign
 * workspace redirected to the Codex default and a single unwritable
 * CODEX_HOME aborted the whole transaction (OpenClaw rolled back with it).
 *
 * Pinned on the real decision points of install():
 *   - materialize runs ONLY when the run serves Codex (requested target or a
 *     persisted Codex sibling in the refresh set);
 *   - a materialize failure is Codex's own install/refresh result — never an
 *     exception crossing per-host error isolation.
 */
describe('Codex workspace materialization scope (review: only runs that serve Codex)', () => {
  it('the gate opens only for codex target or a codex refresh sibling', () => {
    expect(installRunServesCodex('codex', [])).toBe(true);
    expect(installRunServesCodex('all', [])).toBe(true);
    expect(installRunServesCodex('openclaw', ['codex'])).toBe(true);
    expect(installRunServesCodex('openclaw', [])).toBe(false);
    expect(installRunServesCodex('workbuddy', [])).toBe(false);
    expect(installRunServesCodex('openclaw', ['workbuddy'])).toBe(false);
  });

  it('a persisted Codex install makes even an OpenClaw run serve Codex (refresh path)', () => {
    const refresh = resolveHostRefreshTargets(['codex'], 'openclaw');
    expect(refresh).toContain('codex');
    expect(installRunServesCodex('openclaw', refresh)).toBe(true);
    expect(installRunServesCodex('openclaw', resolveHostRefreshTargets([], 'openclaw'))).toBe(false);
  });

  const ctx: HostInstallContext = {
    workspaceDir: path.resolve('/data/whatever'),
    pluginDir: path.resolve('/data/plugin'),
    language: 'en',
    mode: 'smart',
  };

  it('a materialize failure becomes Codex\'s own failed result — install() is never reached, the error does not escape', async () => {
    const results = await runHostInstallers('codex', ctx, {
      codexWorkspaceError: 'EACCES: permission denied, mkdir \'/ro/.codex/pd-workspace\'',
    });
    expect(results).toHaveLength(1);
    const codex = results[0]!;
    expect(codex.success).toBe(false);
    expect(codex.hostId).toBe('codex');
    expect(codex.configAction).toBe('skipped');
    expect(codex.reason).toContain('EACCES');
    expect(codex.nextAction).toContain('--host codex');
  });

  it('a materialize failure during refresh is Codex\'s refresh failure — siblings stay isolated', async () => {
    // Same call shape the refresh loop issues per target: the codex result
    // carries the failure, nothing throws across the loop.
    const results = await runHostInstallers('codex', ctx, {
      codexWorkspaceError: 'ENOENT: no such file or directory',
    });
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.reason).toContain('ENOENT');
  });
});
