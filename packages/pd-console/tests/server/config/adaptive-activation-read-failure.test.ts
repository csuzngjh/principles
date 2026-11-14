/**
 * PR #2641 review — degraded reader path.
 *
 * The candidate reader throwing must produce a structured warning and an
 * UNKNOWN-free but honest "read_failed" state, never an error message or a
 * filesystem path in the payload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { getDefaultPdConfig } from '@principles/core/runtime';

vi.mock('@principles/host-runtime', () => ({
  readPromptActivationCandidates: vi.fn(async () => {
    throw new Error('EACCES: permission denied, open C:/secret/state.db');
  }),
  readAdaptiveInjectionRecords: vi.fn(() => ({ filesRead: [], lines: 0, parseFailures: 0, records: [] })),
}));

import { AdaptiveActivationConsoleModel } from '../../../src/server/models/AdaptiveActivationConsoleModel.js';

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('AdaptiveActivationConsoleModel degraded candidate read', () => {
  it('reports read_failed with a bounded warning and leaks no path or errno', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-aa-readfail-'));
    workspaces.push(workspace);
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');

    const view = await new AdaptiveActivationConsoleModel(workspace).getView();
    expect(view.candidates.validCount).toBe(0);
    expect(view.candidates.emptyState).toBe('read_failed');
    expect(view.candidates.blockingWarnings).toEqual([
      'activation_db_unreadable; nextAction=check_workspace_pd_state_db',
    ]);
    const serialized = JSON.stringify(view.candidates);
    expect(serialized).not.toContain('EACCES');
    expect(serialized).not.toContain('C:/secret');
    // Evidence is independent of the candidate read and remains a proven absence.
    expect(view.evidence.status).toBe('not_observed');
  });
});
