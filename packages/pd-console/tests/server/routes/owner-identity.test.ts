import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ADR-0022 (PRI-578): the owner-identity route imports the core module via
// `@principles/core/runtime`, which resolves to the built package dist.
// This test injects the REAL core source implementations (relative import,
// same pattern as the PR-577 event-log alias) so the route test exercises the
// actual file I/O + resolution logic without depending on a dist rebuild.
vi.mock('@principles/core/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/core/runtime')>();
  const ownerIdentity = await import('../../../../principles-core/src/runtime/owner-identity.js');
  return {
    ...actual,
    resolveOwnerIdentity: ownerIdentity.resolveOwnerIdentity,
    readOwnerIdentityFile: vi.fn(ownerIdentity.readOwnerIdentityFile),
    writeOwnerIdentityFile: ownerIdentity.writeOwnerIdentityFile,
    deleteOwnerIdentityFile: ownerIdentity.deleteOwnerIdentityFile,
    defaultOwnerIdentityHomeDir: ownerIdentity.defaultOwnerIdentityHomeDir,
  };
});

import { handleOwnerIdentityRoute } from '../../../src/server/routes/owner-identity.js';
import { defaultOwnerIdentityHomeDir, readOwnerIdentityFile } from '@principles/core/runtime';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-owner-route-'));
}

function authConfig(enabled: boolean): { isEnabled(): boolean } {
  return { isEnabled: () => enabled };
}

function createMockRequest(method: string, body?: unknown): IncomingMessage {
  const req = { method } as unknown as IncomingMessage;
  if (body !== undefined) {
    const buf = Buffer.from(JSON.stringify(body));
    let yielded = false;
    (req as unknown as AsyncIterable<Buffer>)[Symbol.asyncIterator] = async function* () {
      if (!yielded) {
        yielded = true;
        yield buf;
      }
    };
  }
  return req;
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

interface RouteData {
  resolved: { source: string; ownerId: string | null; credentialId: string | null; error?: string };
  fileRecord: { ownerId: string } | null;
  fileError?: string;
  governance: { authenticationMode: string; ownerIdentityConfiguration: string };
  source?: string;
  ok?: boolean;
}

describe('ADR-0022 /api/owner-identity route (PRI-578 PR-3-A)', () => {
  const originalOwnerId = process.env.PD_OWNER_ID;
  const originalCredentialId = process.env.PD_OWNER_CREDENTIAL_ID;
  beforeEach(() => {
    delete process.env.PD_OWNER_ID;
    delete process.env.PD_OWNER_CREDENTIAL_ID;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalOwnerId === undefined) delete process.env.PD_OWNER_ID;
    else process.env.PD_OWNER_ID = originalOwnerId;
    if (originalCredentialId === undefined) delete process.env.PD_OWNER_CREDENTIAL_ID;
    else process.env.PD_OWNER_CREDENTIAL_ID = originalCredentialId;
  });

  it('GET: none when neither env nor file is present', async () => {
    const home = tempHome();
    const res = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), res, home, '', authConfig(false));
    expect(res.statusCode).toBe(200);
    const data = parseBody<{ data: RouteData }>(res).data;
    expect(data.resolved.source).toBe('none');
    expect(data.fileRecord).toBeNull();
    expect(data.governance).toEqual({ authenticationMode: 'no_auth', ownerIdentityConfiguration: 'missing' });
  });

  it('POST registers, then GET reports file source with the record and readiness', async () => {
    const home = tempHome();
    const postRes = createMockResponse();
    await handleOwnerIdentityRoute(
      createMockRequest('POST', { ownerId: 'alice', credentialId: 'cred-1' }),
      postRes,
      home,
      '',
      authConfig(true),
    );
    expect(postRes.statusCode).toBe(200);
    const postData = parseBody<{ data: RouteData }>(postRes).data;
    expect(postData.source).toBe('file');
    expect(postData.governance).toEqual({ authenticationMode: 'authenticated', ownerIdentityConfiguration: 'configured' });

    const getRes = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), getRes, home, '', authConfig(true));
    const data = parseBody<{ data: RouteData }>(getRes).data;
    expect(data.resolved.source).toBe('file');
    expect(data.resolved.ownerId).toBe('alice');
    expect(data.fileRecord?.ownerId).toBe('alice');
    expect(data.governance).toEqual({ authenticationMode: 'authenticated', ownerIdentityConfiguration: 'configured' });
  });

  it('GET: file registration remains configured when token auth is disabled', async () => {
    const home = tempHome();
    await handleOwnerIdentityRoute(
      createMockRequest('POST', { ownerId: 'alice', credentialId: 'c' }),
      createMockResponse(),
      home,
      '',
      authConfig(false),
    );
    const res = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), res, home, '', authConfig(false));
    const data = parseBody<{ data: RouteData }>(res).data;
    expect(data.resolved.source).toBe('file');
    expect(data.governance).toEqual({ authenticationMode: 'no_auth', ownerIdentityConfiguration: 'configured' });
  });

  it('env wins over the file in GET (highest precedence)', async () => {
    vi.stubEnv('PD_OWNER_ID', 'env-owner');
    vi.stubEnv('PD_OWNER_CREDENTIAL_ID', 'env-cred');
    const home = tempHome();
    await handleOwnerIdentityRoute(
      createMockRequest('POST', { ownerId: 'file-owner', credentialId: 'file-cred' }),
      createMockResponse(),
      home,
      '',
      authConfig(true),
    );
    const res = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), res, home, '', authConfig(true));
    const data = parseBody<{ data: RouteData }>(res).data;
    expect(data.resolved.source).toBe('env');
    expect(data.resolved.ownerId).toBe('env-owner');
  });

  it('GET: partial env pair over a valid file → fail-closed invalid_env, no file identity, governance invalid', async () => {
    vi.stubEnv('PD_OWNER_ID', 'env-owner');
    const home = tempHome();
    await handleOwnerIdentityRoute(
      createMockRequest('POST', { ownerId: 'file-owner', credentialId: 'file-cred' }),
      createMockResponse(),
      home,
      '',
      authConfig(true),
    );
    const res = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), res, home, '', authConfig(true));
    const data = parseBody<{ data: RouteData }>(res).data;
    expect(data.resolved.source).toBe('invalid_env');
    expect(data.resolved.ownerId).toBeNull();
    expect(data.resolved.credentialId).toBeNull();
    expect(data.resolved.error).toContain('owner_identity_invalid_env');
    // The stale file Owner must NOT leak through as the effective identity.
    expect(data.fileRecord?.ownerId).toBe('file-owner');
    expect(data.governance).toEqual({ authenticationMode: 'authenticated', ownerIdentityConfiguration: 'invalid' });
  });

  it('POST rejects empty input with 400', async () => {
    const home = tempHome();
    const res = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('POST', { ownerId: '', credentialId: '' }), res, home, '', authConfig(false));
    expect(res.statusCode).toBe(400);
  });

  it('DELETE unregisters, is idempotent, and reports post-delete readiness', async () => {
    const home = tempHome();
    await handleOwnerIdentityRoute(
      createMockRequest('POST', { ownerId: 'alice', credentialId: 'c' }),
      createMockResponse(),
      home,
      '',
      authConfig(false),
    );
    const del1 = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('DELETE'), del1, home, '', authConfig(false));
    expect(del1.statusCode).toBe(200);
    const del1Data = parseBody<{ data: RouteData }>(del1).data;
    expect(del1Data.ok).toBe(true);
    expect(del1Data.governance).toEqual({ authenticationMode: 'no_auth', ownerIdentityConfiguration: 'missing' });

    const del2 = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('DELETE'), del2, home, '', authConfig(false));
    expect(del2.statusCode).toBe(200);

    const getRes = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), getRes, home, '', authConfig(false));
    expect(parseBody<{ data: RouteData }>(getRes).data.resolved.source).toBe('none');
  });

  it('rejects unknown subpaths with 404', async () => {
    const home = tempHome();
    const res = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), res, home, '/nope', authConfig(false));
    expect(res.statusCode).toBe(404);
  });
});

// ── P0-2: Owner identity isolation for experiment instances ────────────────
describe('P0-2 /api/owner-identity — experiment instance isolation', () => {
  const originalExperimentRoot = process.env.PD_EXPERIMENT_ROOT;
  const originalOwnerId = process.env.PD_OWNER_ID;
  const originalCredentialId = process.env.PD_OWNER_CREDENTIAL_ID;

  function writeProductionOwnerFile(home: string): { file: string; content: string; mtimeMs: number } {
    const file = path.join(home, '.pd', 'owner.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const content = JSON.stringify({
      schemaVersion: 1,
      ownerId: 'production-owner',
      credentialId: 'production-credential',
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
    fs.writeFileSync(file, content);
    return { file, content, mtimeMs: fs.statSync(file).mtimeMs };
  }

  beforeEach(() => {
    delete process.env.PD_OWNER_ID;
    delete process.env.PD_OWNER_CREDENTIAL_ID;
    delete process.env.PD_EXPERIMENT_ROOT;
  });

  afterEach(() => {
    if (originalExperimentRoot === undefined) delete process.env.PD_EXPERIMENT_ROOT;
    else process.env.PD_EXPERIMENT_ROOT = originalExperimentRoot;
    if (originalOwnerId === undefined) delete process.env.PD_OWNER_ID;
    else process.env.PD_OWNER_ID = originalOwnerId;
    if (originalCredentialId === undefined) delete process.env.PD_OWNER_CREDENTIAL_ID;
    else process.env.PD_OWNER_CREDENTIAL_ID = originalCredentialId;
  });

  it('resolves the identity home to <PD_EXPERIMENT_ROOT> and never reads production owner.json when env identity is active', async () => {
    const experimentRoot = tempHome();
    const productionHome = tempHome();
    const production = writeProductionOwnerFile(productionHome);
    const readOwnerFile = vi.mocked(readOwnerIdentityFile);
    readOwnerFile.mockClear();

    process.env.PD_EXPERIMENT_ROOT = experimentRoot;
    process.env.PD_OWNER_ID = 'env-owner';
    process.env.PD_OWNER_CREDENTIAL_ID = 'env-credential';

    const identityHome = defaultOwnerIdentityHomeDir();
    expect(path.resolve(identityHome)).toBe(path.resolve(experimentRoot));

    const res = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), res, identityHome, '', authConfig(true));
    const data = parseBody<{ data: RouteData & { fileRecordSkipped?: string } }>(res).data;

    expect(data.resolved.source).toBe('env');
    expect(data.resolved.ownerId).toBe('env-owner');
    expect(data.resolved.credentialId).toBe('env-credential');
    expect(data.fileRecord).toBeNull();
    expect(data.fileRecordSkipped).toBe('env_identity');

    // File-access audit: the production registration file was never opened or
    // even handed to the reader.
    expect(readOwnerFile).not.toHaveBeenCalled();
    expect(fs.readFileSync(production.file, 'utf8')).toBe(production.content);
    expect(fs.statSync(production.file).mtimeMs).toBe(production.mtimeMs);
  });

  it('registration in experiment mode writes <root>/.pd/owner.json and leaves production untouched', async () => {
    const experimentRoot = tempHome();
    const productionHome = tempHome();
    const production = writeProductionOwnerFile(productionHome);

    process.env.PD_EXPERIMENT_ROOT = experimentRoot;
    const identityHome = defaultOwnerIdentityHomeDir();

    const postRes = createMockResponse();
    await handleOwnerIdentityRoute(
      createMockRequest('POST', { ownerId: 'experiment-owner', credentialId: 'experiment-credential' }),
      postRes,
      identityHome,
      '',
      authConfig(true),
    );
    expect(postRes.statusCode).toBe(200);

    const experimentFile = path.join(experimentRoot, '.pd', 'owner.json');
    expect(fs.existsSync(experimentFile)).toBe(true);
    const written = JSON.parse(fs.readFileSync(experimentFile, 'utf8')) as { ownerId: string };
    expect(written.ownerId).toBe('experiment-owner');

    expect(fs.readFileSync(production.file, 'utf8')).toBe(production.content);
    expect(fs.statSync(production.file).mtimeMs).toBe(production.mtimeMs);
  });

  it('production mode (no PD_EXPERIMENT_ROOT) keeps the real user home', () => {
    expect(path.resolve(defaultOwnerIdentityHomeDir())).toBe(path.resolve(os.homedir()));
  });

  it('fails closed on a relative experiment root instead of falling back to production', () => {
    process.env.PD_EXPERIMENT_ROOT = 'relative/root';
    expect(() => defaultOwnerIdentityHomeDir()).toThrow(/must be an absolute path/);
  });
});
