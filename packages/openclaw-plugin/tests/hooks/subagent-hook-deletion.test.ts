import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PLUGIN_SURFACE_REGISTRY } from '@principles/core/runtime-v2';

const repoRoot = path.resolve(__dirname, '../..');
const indexPath = path.join(repoRoot, 'src/index.ts');
const indexSrc = fs.readFileSync(indexPath, 'utf-8');

function extractApiOnRegistrations(source: string): Array<{ event: string; surfaceId: string | null }> {
  const registrations: Array<{ event: string; surfaceId: string | null }> = [];
  const apiOnPattern = /api\.on\s*\(\s*['"]([^'"]+)['"]\s*,\s*/g;
  let match: RegExpExecArray | null;
  while ((match = apiOnPattern.exec(source)) !== null) {
    const event = match[1];
    const afterMatch = source.slice(match.index + match[0].length);
    const guardHookMatch = afterMatch.match(/^guardHook\s*\(\s*['"]([^'"]+)['"]\s*,/);
    registrations.push({ event, surfaceId: guardHookMatch ? guardHookMatch[1] : null });
  }
  return registrations;
}

describe('PRI-448: subagent/shadow hook deletion', () => {
  it('index.ts no longer registers subagent_spawning or subagent_ended', () => {
    expect(indexSrc).not.toContain("api.on('subagent_spawning'");
    expect(indexSrc).not.toContain("api.on('subagent_ended'");
  });

  it('index.ts no longer imports or calls shadow-routing symbols', () => {
    const shadowSymbols = [
      'classifyTask',
      'recordShadowRouting',
      'completeShadowObservation',
      'computeRuntimeShadowTaskFingerprint',
      'PD_LOCAL_PROFILES',
      'pendingShadowObservations',
    ];
    for (const symbol of shadowSymbols) {
      expect(indexSrc).not.toContain(symbol);
    }
  });

  it('PLUGIN_SURFACE_REGISTRY no longer contains subagent/shadow hooks', () => {
    const shadowHooks = PLUGIN_SURFACE_REGISTRY.filter(
      s => s.kind === 'hook' && (s.id.includes('subagent') || s.id.includes('shadow')),
    );
    expect(shadowHooks).toEqual([]);
  });

  it('remaining core hooks are still present in the registry', () => {
    const expectedCoreHooks = [
      'hook:before_prompt_build',
      'hook:before_tool_call',
      'hook:after_tool_call',
      'hook:llm_output',
    ];
    const registryIds = new Set(PLUGIN_SURFACE_REGISTRY.map(s => s.id));
    for (const hookId of expectedCoreHooks) {
      expect(registryIds.has(hookId)).toBe(true);
    }
  });

  it('every api.on registration is guarded and has a matching registry entry', () => {
    const registrations = extractApiOnRegistrations(indexSrc);
    expect(registrations.length).toBeGreaterThan(0);

    const unguarded = registrations.filter(r => r.surfaceId === null);
    expect(unguarded).toEqual([]);

    const registryIds = new Set(PLUGIN_SURFACE_REGISTRY.map(s => s.id));
    const unregistered = registrations.filter(r => !registryIds.has(r.surfaceId!));
    expect(unregistered).toEqual([]);
  });
});
