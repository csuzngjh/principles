import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const INDEX_TS = fs.readFileSync(
  path.resolve(__dirname, '../src/index.ts'),
  'utf-8',
);

describe('Hook workspace resolution NextAction contract', () => {
  const FORBIDDEN_NEXT_ACTION_PATTERNS = [
    /PD_WORKSPACE_DIR/,
    /principles-disciple\.json/,
  ];

  it('does not claim PD_WORKSPACE_DIR env var as recovery in NextAction', () => {
    const matches = INDEX_TS.match(/NextAction:[^`]*PD_WORKSPACE_DIR/g);
    expect(matches).toBeNull();
  });

  it('does not claim principles-disciple.json as recovery in NextAction', () => {
    const matches = INDEX_TS.match(/NextAction:[^`]*principles-disciple\.json/g);
    expect(matches).toBeNull();
  });

  it('all hook failure NextActions reference canonical workspace migration', () => {
    const nextActionLines = INDEX_TS.match(/NextAction: \${HOOK_WORKSPACE_RESOLUTION_NEXT_ACTION}/g);
    expect(nextActionLines).not.toBeNull();
    expect(nextActionLines!.length).toBeGreaterThanOrEqual(7);
  });

  it('HOOK_WORKSPACE_RESOLUTION_NEXT_ACTION constant exists and does not contain forbidden patterns', () => {
    const constantMatch = INDEX_TS.match(
      /const HOOK_WORKSPACE_RESOLUTION_NEXT_ACTION\s*=\s*'([^']+)'/,
    );
    expect(constantMatch).not.toBeNull();
    const constantValue = constantMatch![1];
    for (const pattern of FORBIDDEN_NEXT_ACTION_PATTERNS) {
      expect(pattern.test(constantValue)).toBe(false);
    }
  });
});
