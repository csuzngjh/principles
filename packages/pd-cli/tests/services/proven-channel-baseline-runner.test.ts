import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { isProductionWorkspace } from '../../src/services/proven-channel-baseline-runner.js';

describe('isProductionWorkspace (real implementation)', () => {
  it('blocks exact production workspace path', () => {
    const homedirWorkspace = path.join(os.homedir(), '.openclaw', 'workspace');
    expect(isProductionWorkspace(homedirWorkspace)).toBe(true);
  });

  it('blocks descendant of production workspace', () => {
    const homedirWorkspace = path.join(os.homedir(), '.openclaw', 'workspace', 'my-project');
    expect(isProductionWorkspace(homedirWorkspace)).toBe(true);
  });

  it('does NOT block sibling path with different prefix', () => {
    const sibling = path.join(os.homedir(), '.openclaw', 'workspace-extra');
    expect(isProductionWorkspace(sibling)).toBe(false);
  });

  it('does NOT block unrelated path', () => {
    expect(isProductionWorkspace('C:\\Users\\test\\project')).toBe(false);
  });

  it('does NOT block temp directory', () => {
    const tmp = os.tmpdir();
    expect(isProductionWorkspace(tmp)).toBe(false);
  });
});
