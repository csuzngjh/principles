/**
 * Security audit run-1: gate-failopen-allow-on-state-corruption (console side).
 *
 * When state.db is missing, the governance read model must let the Owner
 * distinguish "deleted/lost after initialization" (workspace config present —
 * enforcement silently degraded, fail-open) from an ordinary
 * never-initialized workspace. Same machine-readable state code (no UI i18n
 * surface change); the distinction lives in the human-readable reason/note.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GovernanceConsoleModel } from '../../src/server/models/GovernanceConsoleModel.js';

let tempWorkspaceDir: string;

beforeEach(() => {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gov-model-'));
});

afterEach(() => {
  fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
});

describe('GovernanceConsoleModel.getGovernanceQueue: state.db missing distinction', () => {
  it('reports degraded/enforcement-off wording when the workspace was initialized before', async () => {
    fs.mkdirSync(path.join(tempWorkspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(tempWorkspaceDir, '.pd', 'config.yaml'), 'flags: {}\n', 'utf8');

    const response = await new GovernanceConsoleModel(tempWorkspaceDir).getGovernanceQueue();

    expect(response.stateReasonCode).toBe('state_db_missing');
    expect(response.stateReason).toContain('MISSING');
    expect(response.stateReason).toContain('NOT being enforced');
    expect(response.note).toContain('fail-open');
    expect(response.nextAction).toContain('re-initialize');
  });

  it('keeps the never-initialized wording when no workspace state exists at all', async () => {
    const response = await new GovernanceConsoleModel(tempWorkspaceDir).getGovernanceQueue();

    expect(response.stateReasonCode).toBe('state_db_missing');
    expect(response.stateReason).toBe('State database not initialized. PD has not run in this workspace.');
    expect(response.note).toBe('state.db not found — workspace may not be initialized');
  });

  it('reports a degraded (corrupt) state when state.db exists but is unreadable', async () => {
    fs.mkdirSync(path.join(tempWorkspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(tempWorkspaceDir, '.pd', 'state.db'), 'this is not a sqlite database at all', 'utf8');

    const response = await new GovernanceConsoleModel(tempWorkspaceDir).getGovernanceQueue();

    expect(response.governanceState).toBe('degraded');
    expect(response.stateReasonCode).toBe('degraded_state');
    expect(response.stateReason).toContain('UNREADABLE');
    expect(response.stateReason).toContain('NOT being enforced');
    expect(response.note).toContain('state.db unreadable');
  });
});
