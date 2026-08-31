import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { GovernanceExperienceSnapshotSchema } from '@principles/core/runtime-v2';
import {
  handleGovernanceExperienceRoute,
  resolveOwnerConfigSnapshot,
} from '../../../src/server/routes/governance.js';
import { GovernanceProjectionCollector } from '../../../src/server/models/GovernanceProjectionCollector.js';

// Mock req/res construction is the standard test-double pattern for node:http
// classes (rc-2 applies to production paths, not test infrastructure).
function createMockRequest(method: string): IncomingMessage {
  return { method } as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _body: '',
    writeHead: vi.fn(function (this: unknown, statusCode: number) {
      (res as unknown as { statusCode: number }).statusCode = statusCode;
      return this;
    }),
    end: vi.fn(function (this: unknown, data?: string) {
      if (data !== undefined) {
        (res as unknown as { _body: string })._body = data;
      }
      return this;
    }),
  };
  return res as unknown as ServerResponse;
}

function parseBody<T>(res: ServerResponse): T {
  return JSON.parse((res as unknown as { _body: string })._body) as T;
}

const OWNER_CONFIG = { authenticationMode: 'no_auth' as const, ownerIdentityConfiguration: 'missing' as const };

let tempDir: string;
let workspaceDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-governance-experience-route-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  // Minimal ledger so the flag-on path has one principle to project.
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'principle_training_state.json'), JSON.stringify({
    _tree: {
      principles: {
        'principle-1': { id: 'principle-1', status: 'candidate', createdAt: '2026-08-20T08:00:00.000Z', updatedAt: '2026-08-20T09:00:00.000Z' },
      },
      rules: {}, implementations: {}, metrics: {}, lastUpdated: '2026-08-24T10:00:00.000Z',
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('PRI-585 GET /api/v1/governance/experience — flag contract (SPEC §14)', () => {
  it('flag OFF → 403 feature_disabled BEFORE any table read (no DB access)', async () => {
    const spy = vi.spyOn(GovernanceProjectionCollector, 'readTables');
    const res = createMockResponse();
    await handleGovernanceExperienceRoute(createMockRequest('GET'), res, {
      workspaceDir,
      featureFlags: { governance_experience_v1: { enabled: false } },
      ownerConfig: OWNER_CONFIG,
    });
    expect(res.statusCode).toBe(403);
    const body = parseBody<{ success: boolean; error: string; nextAction?: string }>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe('feature_disabled');
    expect(body.nextAction).toContain('governance_experience_v1');
    expect(spy).not.toHaveBeenCalled();
  });

  it('flag missing entirely → fail-closed 403 feature_disabled', async () => {
    const res = createMockResponse();
    await handleGovernanceExperienceRoute(createMockRequest('GET'), res, {
      workspaceDir,
      featureFlags: {},
      ownerConfig: OWNER_CONFIG,
    });
    expect(res.statusCode).toBe(403);
    expect(parseBody<{ error: string }>(res).error).toBe('feature_disabled');
  });

  it('flag ON → 200 with a schema-valid snapshot', async () => {
    const res = createMockResponse();
    await handleGovernanceExperienceRoute(createMockRequest('GET'), res, {
      workspaceDir,
      featureFlags: { governance_experience_v1: { enabled: true } },
      ownerConfig: OWNER_CONFIG,
    });
    expect(res.statusCode).toBe(200);
    const body = parseBody<{ success: boolean; data: unknown }>(res);
    expect(body.success).toBe(true);
    expect(Value.Check(GovernanceExperienceSnapshotSchema, body.data)).toBe(true);
  });

  it('flag ON with a workspace that has no state.db → degraded snapshot, not 500', async () => {
    const res = createMockResponse();
    await handleGovernanceExperienceRoute(createMockRequest('GET'), res, {
      workspaceDir,
      featureFlags: { governance_experience_v1: { enabled: true } },
      ownerConfig: OWNER_CONFIG,
    });
    // The ledger exists but state.db does not: sources degrade, still 200.
    expect(res.statusCode).toBe(200);
    const body = parseBody<{ data: { activity: { primaryAttention: string } } }>(res);
    expect(['degraded', 'setup_required']).toContain(body.data.activity.primaryAttention);
  });

  it('non-GET → 405 method_not_allowed', async () => {
    const res = createMockResponse();
    await handleGovernanceExperienceRoute(createMockRequest('POST'), res, {
      workspaceDir,
      featureFlags: { governance_experience_v1: { enabled: true } },
      ownerConfig: OWNER_CONFIG,
    });
    expect(res.statusCode).toBe(405);
    expect(parseBody<{ error: string }>(res).error).toBe('method_not_allowed');
  });
});

describe('PRI-584 resolveOwnerConfigSnapshot — authority evidence (SPEC §6)', () => {
  it('keeps identity configuration independent from Console authentication', () => {
    expect(resolveOwnerConfigSnapshot({ isEnabled: () => false }, { ownerId: 'owner-1', credentialId: 'cred-1', source: 'env' })).toEqual({
      authenticationMode: 'no_auth',
      ownerIdentityConfiguration: 'configured',
    });
  });

  it('surfaces invalid identity configuration independently from authentication', () => {
    expect(resolveOwnerConfigSnapshot({ isEnabled: () => true }, {
      ownerId: null, credentialId: null, source: 'invalid_env', error: 'owner_identity_env_pair_incomplete',
    })).toEqual({ authenticationMode: 'authenticated', ownerIdentityConfiguration: 'invalid' });
  });

  it('auth enabled + both identity fields → configured owner identity', () => {
    expect(resolveOwnerConfigSnapshot({ isEnabled: () => true }, { ownerId: 'owner-1', credentialId: 'cred-1', source: 'env' })).toEqual({
      authenticationMode: 'authenticated',
      ownerIdentityConfiguration: 'configured',
    });
  });

  it('auth enabled + missing credential → missing identity (matches server/index.ts authority wiring)', () => {
    expect(resolveOwnerConfigSnapshot({ isEnabled: () => true }, { ownerId: 'owner-1', credentialId: null, source: 'none' })).toEqual({
      authenticationMode: 'authenticated',
      ownerIdentityConfiguration: 'missing',
    });
  });
});
