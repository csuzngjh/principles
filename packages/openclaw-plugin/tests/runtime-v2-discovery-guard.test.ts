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
  const guardedFiles = [
    { name: 'workspace-resolver.ts', path: path.join(PLUGIN_SRC, 'utils', 'workspace-resolver.ts') },
    { name: 'workspace-context.ts', path: path.join(PLUGIN_SRC, 'core', 'workspace-context.ts') },
    { name: 'workspace-dir-service.ts', path: path.join(PLUGIN_SRC, 'core', 'workspace-dir-service.ts') },
    { name: 'path-resolver.ts', path: path.join(PLUGIN_SRC, 'core', 'path-resolver.ts') },
  ];

  for (const file of guardedFiles) {
    describe(`${file.name} isolation`, () => {
      it(`does not import nocturnal or idle modules`, () => {
        if (!fs.existsSync(file.path)) return;
        const content = fs.readFileSync(file.path, 'utf-8');
        for (const disallowed of DISALLOWED_RUNTIME_V2_IMPORTS) {
          expect(
            content.includes(disallowed),
            `${file.name} must not import legacy discovery path: ${disallowed}`,
          ).toBe(false);
        }
      });
    });
  }

  describe('resolveWorkspaceDirForRuntimeV2 does not use legacy fallback chain', () => {
    it('does not call resolveWorkspaceDirFromApi', () => {
      const filePath = path.join(PLUGIN_SRC, 'utils', 'workspace-resolver.ts');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      const fnMatch = content.match(/function resolveWorkspaceDirForRuntimeV2[\s\S]*?^}/m);
      if (!fnMatch) {
        expect.unreachable('resolveWorkspaceDirForRuntimeV2 function not found');
        return;
      }
      const fnBody = fnMatch[0];
      expect(
        fnBody.includes('resolveWorkspaceDirFromApi'),
        'resolveWorkspaceDirForRuntimeV2 must NOT call resolveWorkspaceDirFromApi (legacy fallback)',
      ).toBe(false);
      expect(
        fnBody.includes('PathResolver'),
        'resolveWorkspaceDirForRuntimeV2 must NOT reference PathResolver (legacy fallback)',
      ).toBe(false);
    });

    it('only accepts explicit ctx.workspaceDir', () => {
      const filePath = path.join(PLUGIN_SRC, 'utils', 'workspace-resolver.ts');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      const fnMatch = content.match(/function resolveWorkspaceDirForRuntimeV2[\s\S]*?^}/m);
      if (!fnMatch) return;
      const fnBody = fnMatch[0];
      expect(fnBody.includes('ctx.workspaceDir')).toBe(true);
      expect(fnBody.includes('validateWorkspaceDir')).toBe(true);
    });
  });

  describe('fromHookContextExplicit does not delegate dangerous paths to fromHookContext', () => {
    it('validates workspaceDir BEFORE calling fromHookContext', () => {
      const filePath = path.join(PLUGIN_SRC, 'core', 'workspace-context.ts');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      const fnMatch = content.match(/static fromHookContextExplicit[\s\S]*?^\s{4}\}/m);
      if (!fnMatch) {
        expect.unreachable('fromHookContextExplicit method not found');
        return;
      }
      const fnBody = fnMatch[0];
      const validatePos = fnBody.indexOf('validateWorkspaceDir');
      const delegatePos = fnBody.indexOf('this.fromHookContext(');
      expect(validatePos).toBeGreaterThan(-1);
      expect(delegatePos).toBeGreaterThan(-1);
      expect(
        validatePos,
        'validateWorkspaceDir must be called BEFORE delegating to fromHookContext',
      ).toBeLessThan(delegatePos);
    });

    it('throws on missing workspaceDir (does not just warn)', () => {
      const filePath = path.join(PLUGIN_SRC, 'core', 'workspace-context.ts');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      const fnMatch = content.match(/static fromHookContextExplicit[\s\S]*?^\s{4}\}/m);
      if (!fnMatch) return;
      const fnBody = fnMatch[0];
      expect(fnBody).toContain('throw');
      expect(fnBody).toContain('workspace_dir_missing');
    });

    it('throws on invalid workspaceDir (does not just warn)', () => {
      const filePath = path.join(PLUGIN_SRC, 'core', 'workspace-context.ts');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      const fnMatch = content.match(/static fromHookContextExplicit[\s\S]*?^\s{4}\}/m);
      if (!fnMatch) return;
      const fnBody = fnMatch[0];
      expect(fnBody).toContain('workspace_dir_invalid');
    });
  });

  describe('LEGACY_PATH_RESOLVER_FALLBACK marker in fromHookContext', () => {
    it('fromHookContext logs LEGACY_PATH_RESOLVER_FALLBACK on dangerous paths', () => {
      const filePath = path.join(PLUGIN_SRC, 'core', 'workspace-context.ts');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('LEGACY_PATH_RESOLVER_FALLBACK');
    });
  });
});