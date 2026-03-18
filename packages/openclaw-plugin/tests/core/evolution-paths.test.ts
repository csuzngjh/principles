import { describe, expect, it } from 'vitest';
import { PathResolver } from '../../src/core/path-resolver.js';
import { PD_FILES, resolvePdPath } from '../../src/core/paths.js';

describe('evolution path keys', () => {
  it('defines evolution stream related paths in PD_FILES', () => {
    expect(PD_FILES.EVOLUTION_STREAM).toBe('memory/evolution.jsonl');
    expect(PD_FILES.EVOLUTION_LOCK).toBe('memory/.locks/evolution');
    expect(PD_FILES.PRINCIPLE_BLACKLIST).toBe('.state/principle_blacklist.json');
  });

  it('resolves evolution paths via resolvePdPath and PathResolver', () => {
    const workspaceDir = '/tmp/workspace';
    expect(resolvePdPath(workspaceDir, 'EVOLUTION_STREAM')).toBe('/tmp/workspace/memory/evolution.jsonl');

    const resolver = new PathResolver({ workspaceDir });
    expect(resolver.resolve('EVOLUTION_STREAM')).toBe('/tmp/workspace/memory/evolution.jsonl');
    expect(resolver.resolve('EVOLUTION_LOCK')).toBe('/tmp/workspace/memory/.locks/evolution');
    expect(resolver.resolve('PRINCIPLE_BLACKLIST')).toBe('/tmp/workspace/.state/principle_blacklist.json');
  });
});
