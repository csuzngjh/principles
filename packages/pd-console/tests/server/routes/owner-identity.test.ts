import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ADR-0022 (PRI-578): the owner-identity route imports the core module via
// `@principles/core/runtime-v2`, which resolves to the built package dist.
// This test injects the REAL core source implementations (relative import,
// same pattern as the PR-577 event-log alias) so the route test exercises the
// actual file I/O + resolution logic without depending on a dist rebuild.
vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/core/runtime-v2')>();
  const ownerIdentity = await import('../../../../principles-core/src/runtime-v2/owner-identity.js');
  return {
    ...actual,
    resolveOwnerIdentity: ownerIdentity.resolveOwnerIdentity,
    readOwnerIdentityFile: ownerIdentity.readOwnerIdentityFile,
    writeOwnerIdentityFile: ownerIdentity.writeOwnerIdentityFile,
    deleteOwnerIdentityFile: ownerIdentity.deleteOwnerIdentityFile,
  };
});

import { handleOwnerIdentityRoute } from '../../../src/server/routes/owner-identity.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-owner-route-'));
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

describe('ADR-0022 /api/v1/owner-identity route (PRI-578 PR-3-A)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('GET: none when neither env nor file is present', async () => {
    const home = tempHome();
    const res = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), res, home, '');
    expect(res.statusCode).toBe(200);
    const data = parseBody<{ data: { resolved: { source: string }; fileRecord: unknown } }>(res).data;
    expect(data.resolved.source).toBe('none');
    expect(data.fileRecord).toBeNull();
  });

  it('POST registers, then GET reports file source with the record', async () => {
    const home = tempHome();
    const postRes = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('POST', { ownerId: 'alice', credentialId: 'cred-1' }), postRes, home, '');
    expect(postRes.statusCode).toBe(200);
    expect(parseBody<{ data: { source: string } }>(postRes).data.source).toBe('file');

    const getRes = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), getRes, home, '');
    const data = parseBody<{
      data: { resolved: { source: string; ownerId: string | null }; fileRecord: { ownerId: string } | null };
    }>(getRes).data;
    expect(data.resolved.source).toBe('file');
    expect(data.resolved.ownerId).toBe('alice');
    expect(data.fileRecord?.ownerId).toBe('alice');
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
    );
    const res = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), res, home, '');
    const data = parseBody<{ data: { resolved: { source: string; ownerId: string | null } } }>(res).data;
    expect(data.resolved.source).toBe('env');
    expect(data.resolved.ownerId).toBe('env-owner');
  });

  it('POST rejects empty input with 400', async () => {
    const home = tempHome();
    const res = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('POST', { ownerId: '', credentialId: '' }), res, home, '');
    expect(res.statusCode).toBe(400);
  });

  it('DELETE unregisters and is idempotent', async () => {
    const home = tempHome();
    await handleOwnerIdentityRoute(
      createMockRequest('POST', { ownerId: 'alice', credentialId: 'c' }),
      createMockResponse(),
      home,
      '',
    );
    const del1 = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('DELETE'), del1, home, '');
    expect(del1.statusCode).toBe(200);
    expect(parseBody<{ data: { ok: boolean } }>(del1).data.ok).toBe(true);

    const del2 = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('DELETE'), del2, home, '');
    expect(del2.statusCode).toBe(200);

    const getRes = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), getRes, home, '');
    expect(parseBody<{ data: { resolved: { source: string } } }>(getRes).data.resolved.source).toBe('none');
  });

  it('rejects unknown subpaths with 404', async () => {
    const home = tempHome();
    const res = createMockResponse();
    await handleOwnerIdentityRoute(createMockRequest('GET'), res, home, '/nope');
    expect(res.statusCode).toBe(404);
  });
});
