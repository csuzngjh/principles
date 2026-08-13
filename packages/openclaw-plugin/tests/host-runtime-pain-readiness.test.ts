import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenClawHostRuntime } from '../src/host-runtime/openclaw-host-runtime.js';

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) fs.rmSync(workspace, { recursive: true, force: true });
});

describe('OpenClaw shared pain readiness boundary', () => {
  it.each(['missing', 'corrupt'] as const)('does not run host enrichment or continuation when the trajectory database is %s', async (state) => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `pd-openclaw-${state}-`));
    workspaces.push(workspaceDir);
    if (state === 'corrupt') {
      fs.mkdirSync(path.join(workspaceDir, '.state'));
      fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), 'not sqlite');
    }
    const painEnrichmentProvider = vi.fn(() => ({}));
    const onAfterToolResult = vi.fn();
    const runtime = createOpenClawHostRuntime({
      beforePromptBuild: async () => undefined,
      painEnrichmentProvider,
      onAfterToolResult,
    });

    await expect(runtime.dispatchAfterToolCall(
      { toolName: 'write_file', params: { file_path: 'src/a.ts' }, error: 'denied' },
      { workspaceDir, sessionId: 'session-readiness' },
    )).resolves.toBeUndefined();

    expect(painEnrichmentProvider).not.toHaveBeenCalled();
    expect(onAfterToolResult).not.toHaveBeenCalled();
    expect(fs.readdirSync(workspaceDir)).toEqual(state === 'corrupt' ? ['.state'] : []);
  });
});
