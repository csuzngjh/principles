import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const INDEX_TS = fs.readFileSync(
  path.resolve(__dirname, '../src/index.ts'),
  'utf-8',
);

const WORKSPACE_RESOLVER_TS = fs.readFileSync(
  path.resolve(__dirname, '../src/utils/workspace-resolver.ts'),
  'utf-8',
);

describe('Hook workspace resolution NextAction contract', () => {
  it('HOOK_WORKSPACE_RESOLUTION_NEXT_ACTION constant references PD canonical config sources', () => {
    const constantMatch = INDEX_TS.match(
      /const HOOK_WORKSPACE_RESOLUTION_NEXT_ACTION\s*=\s*'([^']+)'/,
    );
    expect(constantMatch).not.toBeNull();
    const constantValue = constantMatch![1];
    expect(constantValue).toContain('PD_WORKSPACE_DIR');
    expect(constantValue).toContain('principles-disciple.json');
  });

  it('resolveHookWorkspaceDir failure result includes PD canonical config in nextAction', () => {
    const nextActionMatch = WORKSPACE_RESOLVER_TS.match(
      /nextAction:\s*'([^']+)'/s,
    );
    expect(nextActionMatch).not.toBeNull();
    const nextAction = nextActionMatch![1];
    expect(nextAction).toContain('PD_WORKSPACE_DIR');
    expect(nextAction).toContain('principles-disciple.json');
  });

  it('all hook failure paths use resolveHookWorkspaceDir with structured nextAction', () => {
    const hookUsages = INDEX_TS.match(/resolveHookWorkspaceDir\(/g);
    expect(hookUsages).not.toBeNull();
    expect(hookUsages!.length).toBeGreaterThanOrEqual(6);

    const wsResultOkChecks = INDEX_TS.match(/!wsResult\.ok/g);
    expect(wsResultOkChecks).not.toBeNull();
    expect(wsResultOkChecks!.length).toBeGreaterThanOrEqual(6);

    const nextActionRefs = INDEX_TS.match(/wsResult\.nextAction/g);
    expect(nextActionRefs).not.toBeNull();
    expect(nextActionRefs!.length).toBeGreaterThanOrEqual(6);
  });

  it('resolveHookWorkspaceDir failure result has reason and nextAction fields', () => {
    expect(WORKSPACE_RESOLVER_TS).toContain("reason: 'workspace_dir_unresolvable'");
    expect(WORKSPACE_RESOLVER_TS).toContain('nextAction:');
    expect(WORKSPACE_RESOLVER_TS).toContain('PD_WORKSPACE_DIR');
  });
});
