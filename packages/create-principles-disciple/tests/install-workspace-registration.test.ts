/**
 * PRI-624 Slice C: the install manifest records every Workspace this install
 * serves so the Companion can discover its per-Workspace workers (SPEC §13
 * "canonical install manifest"). The installer's write path delegates to
 * install-layout's merge; these tests pin the merge contract it relies on.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { mergeInstallManifestWorkspaces, parseInstallManifest } from '@principles/install-layout';

describe('install workspace registration (PRI-624)', () => {
  it('a first install records the workspace; re-installing the same workspace stays idempotent', () => {
    const first = mergeInstallManifestWorkspaces(undefined, 'D:/Code/ws-a');
    expect(first).toHaveLength(1);
    // Re-install passes the SAME canonical spelling (path.resolve is
    // platform-separator-sensitive; a real re-install re-reads the manifest
    // and re-resolves identically).
    const second = mergeInstallManifestWorkspaces(
      { layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: first },
      path.resolve(first[0] ?? ''),
    );
    expect(second).toHaveLength(1);
    const parsed = parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: second });
    expect(parsed.manifest?.workspaces).toEqual(second);
  });

  it('a second workspace joins without disturbing the first (multi-workspace installs)', () => {
    const first = mergeInstallManifestWorkspaces(undefined, 'D:/Code/ws-a');
    const both = mergeInstallManifestWorkspaces(
      { layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: first },
      'D:/Code/ws-b',
    );
    expect(both).toHaveLength(2);
  });
});
