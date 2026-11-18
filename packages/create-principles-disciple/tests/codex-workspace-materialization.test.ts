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
import { materializeCodexWorkspace } from '../src/installer.js';

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
        if (_options.workspaceDir === '/data/openclaw') {
          notes.push(`workspace "/data/openclaw" is openclaw's declared PD workspace; Codex uses its own "${codexDefault}" instead (PRI-1247)`);
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
    const { ensured, warnings, io: ioDeps } = io('C:\\Users\\u\\.codex\\pd-workspace');
    const result = await materializeCodexWorkspace(
      { workspaceDir: '/data/openclaw' },
      ioDeps,
    );
    expect(result.redirected).toBe(true);
    expect(result.codexWorkspaceDir).toBe('C:\\Users\\u\\.codex\\pd-workspace');
    // THE regression: the redirect target is materialized, not just written
    // into a binding.
    expect(ensured).toEqual(['C:\\Users\\u\\.codex\\pd-workspace']);
    // rc-9: the redirect itself stays observable.
    expect(warnings.join(' ')).toContain('uses its own');
    expect(warnings.join(' ')).toContain('PRI-1247');
  });

  it('the user’s explicit non-foreign workspace is never created (it is theirs)', async () => {
    const { ensured, warnings, io: ioDeps } = io('C:\\Users\\u\\.codex\\pd-workspace');
    const result = await materializeCodexWorkspace(
      { workspaceDir: 'D:\\my-own-project' },
      ioDeps,
    );
    expect(result.redirected).toBe(false);
    expect(result.codexWorkspaceDir).toBe('D:\\my-own-project');
    expect(ensured).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
