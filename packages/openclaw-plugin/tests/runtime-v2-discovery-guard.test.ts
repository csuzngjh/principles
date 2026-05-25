import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PLUGIN_SRC = path.resolve(__dirname, '..', 'src');

const DISALLOWED_RUNTIME_V2_IMPORTS = [
  'nocturnal-config',
  'nocturnal-runtime',
  'sleep-cycle',
  'checkWorkspaceIdle',
  'loadNocturnalConfigMerged',
  'idle-trigger',
];

describe('PRI-228: Runtime V2 discovery guard', () => {
  it('workspace-resolver does not import nocturnal or idle modules', () => {
    const filePath = path.join(PLUGIN_SRC, 'utils', 'workspace-resolver.ts');
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');

    for (const disallowed of DISALLOWED_RUNTIME_V2_IMPORTS) {
      expect(
        content.includes(disallowed),
        'workspace-resolver.ts must not import legacy discovery path: ' + disallowed,
      ).toBe(false);
    }
  });

  it('workspace-context does not import nocturnal or idle modules', () => {
    const filePath = path.join(PLUGIN_SRC, 'core', 'workspace-context.ts');
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');

    for (const disallowed of DISALLOWED_RUNTIME_V2_IMPORTS) {
      expect(
        content.includes(disallowed),
        'workspace-context.ts must not import legacy discovery path: ' + disallowed,
      ).toBe(false);
    }
  });

  it('workspace-dir-service does not import nocturnal or idle modules', () => {
    const filePath = path.join(PLUGIN_SRC, 'core', 'workspace-dir-service.ts');
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');

    for (const disallowed of DISALLOWED_RUNTIME_V2_IMPORTS) {
      expect(
        content.includes(disallowed),
        'workspace-dir-service.ts must not import legacy discovery path: ' + disallowed,
      ).toBe(false);
    }
  });

  it('path-resolver does not import nocturnal or idle modules', () => {
    const filePath = path.join(PLUGIN_SRC, 'core', 'path-resolver.ts');
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');

    for (const disallowed of DISALLOWED_RUNTIME_V2_IMPORTS) {
      expect(
        content.includes(disallowed),
        'path-resolver.ts must not import legacy discovery path: ' + disallowed,
      ).toBe(false);
    }
  });

  it('resolveWorkspaceDirForRuntimeV2 exists in workspace-resolver', () => {
    const filePath = path.join(PLUGIN_SRC, 'utils', 'workspace-resolver.ts');
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(
      content.includes('resolveWorkspaceDirForRuntimeV2'),
      'workspace-resolver.ts must export resolveWorkspaceDirForRuntimeV2 for PD-owned config resolution',
    ).toBe(true);
  });

  it('WorkspaceResolutionError exists in workspace-resolver', () => {
    const filePath = path.join(PLUGIN_SRC, 'utils', 'workspace-resolver.ts');
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(
      content.includes('WorkspaceResolutionError'),
      'workspace-resolver.ts must export WorkspaceResolutionError for fail-loud config resolution',
    ).toBe(true);
  });

  it('fromHookContextExplicit exists in workspace-context', () => {
    const filePath = path.join(PLUGIN_SRC, 'core', 'workspace-context.ts');
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(
      content.includes('fromHookContextExplicit'),
      'workspace-context.ts must export fromHookContextExplicit for PD-owned config resolution',
    ).toBe(true);
  });

  it('LEGACY_PATH_RESOLVER_FALLBACK warning exists in workspace-context', () => {
    const filePath = path.join(PLUGIN_SRC, 'core', 'workspace-context.ts');
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(
      content.includes('LEGACY_PATH_RESOLVER_FALLBACK'),
      'workspace-context.ts must log LEGACY_PATH_RESOLVER_FALLBACK when PathResolver fallback is used',
    ).toBe(true);
  });

  it('validateWorkspaceDir is called in workspace-context fromHookContext', () => {
    const filePath = path.join(PLUGIN_SRC, 'core', 'workspace-context.ts');
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(
      content.includes('validateWorkspaceDir'),
      'workspace-context.ts must call validateWorkspaceDir in fromHookContext',
    ).toBe(true);
  });
});