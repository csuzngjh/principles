// Registry exact-version contract tests (SPEC v1.2 §18/§19 / §31 T1, T17-T20).
//
// T1/T17-T19 are additionally proven LIVE against registry.npmjs.org in the
// implementation PR evidence (see docs/release/changesets-cutover-migration.md);
// these tests pin the contract deterministically with an injected fetch.

import { describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_DIR = path.resolve(HERE, '..', 'release');

async function loadClient() {
  return await import(pathToFileURL(path.join(RELEASE_DIR, 'lib', 'registry-client.mjs')).href);
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('registry client: exact-version semantics', () => {
  it('404 packument => null (package absent), not an error', async () => {
    const { fetchPackument } = await loadClient();
    const out = await fetchPackument('@principles/never-existed', { fetchImpl: async () => jsonResponse(404, {}), attempts: 1 });
    expect(out).toBeNull();
  });

  it('5xx is a retryable REGISTRY_ERROR, never interpreted as absent (T20)', async () => {
    const { fetchPackument } = await loadClient();
    let calls = 0;
    await expect(
      fetchPackument('@principles/core', {
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(503, {});
        },
        attempts: 3,
        delayMs: 1,
      }),
    ).rejects.toThrow(/HTTP 503/);
    expect(calls).toBe(3);
  });

  it('network failure is a bounded retry, then an error', async () => {
    const { fetchExactManifest } = await loadClient();
    let calls = 0;
    await expect(
      fetchExactManifest('@principles/core', '1.0.0', {
        fetchImpl: async () => {
          calls += 1;
          throw new Error('ECONNREFUSED');
        },
        attempts: 2,
        delayMs: 1,
      }),
    ).rejects.toThrow(/network failure/);
    expect(calls).toBe(2);
  });

  it('malformed JSON is an error, not absent', async () => {
    const { fetchPackument } = await loadClient();
    await expect(
      fetchPackument('@principles/core', {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON');
          },
        }),
        attempts: 1,
      }),
    ).rejects.toThrow(/malformed JSON/);
  });

  it('classifyPresence: MATCH / CONFLICT / UNVERIFIED matrix (T18/T19)', async () => {
    const { classifyPresence } = await loadClient();
    const SHA = 'a'.repeat(40);
    expect(classifyPresence(null, { expectGitHead: SHA })).toBe('ABSENT');
    expect(classifyPresence({ gitHead: SHA }, { expectGitHead: SHA })).toBe('PRESENT_MATCH');
    expect(classifyPresence({ gitHead: 'b'.repeat(40) }, { expectGitHead: SHA })).toBe('PRESENT_CONFLICT');
    expect(classifyPresence({ gitHead: null }, { expectGitHead: SHA })).toBe('PRESENT_UNVERIFIED');
    expect(classifyPresence({ gitHead: SHA }, {})).toBe('PRESENT_UNVERIFIED');
  });
});

describe('registry-exact CLI: LOCAL_BEHIND_REGISTRY (T1 baseline gate)', () => {
  it('committed version behind the registry latest exits 6, not 0', async () => {
    const CLI = path.join(RELEASE_DIR, 'registry-exact.mjs');
    // Serve a packument whose latest is 9.9.9 while the caller asks about 1.0.0.
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          'dist-tags': { latest: '9.9.9' },
          versions: {
            '1.0.0': { name: 'x', version: '1.0.0', gitHead: 'c'.repeat(40) },
          },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [CLI, '@principles/core', '1.0.0', '--expect-git-head', 'c'.repeat(40)],
          {
            env: {
              ...process.env,
              PD_RELEASE_REGISTRY: `http://127.0.0.1:${port}`,
              PD_RELEASE_RETRY_DELAY_MS: '1',
            },
          },
          (err, stdout) => {
            if (err && (err as { code?: number }).code !== 6) reject(err);
            else resolve({ stdout: String(stdout) });
          },
        );
        void child;
      });
      expect(stdout).toContain('LOCAL_BEHIND_REGISTRY');
      expect(stdout).toContain('9.9.9');
    } finally {
      server.close();
    }
  });
});
