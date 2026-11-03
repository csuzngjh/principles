/**
 * syncMcpServerVersionMirror — regression tests for the pd-mcp-server
 * `SERVER_VERSION` component mirror (SPEC-PD-MCP-GATE4-001 §9.3).
 *
 * Contract under test:
 * - a stale mirror is rewritten to the package version and reports `true`,
 * - an already-mirrored constant is left untouched and reports `false`,
 * - absent component files report `false` (same shape as
 *   syncPluginVersionMirror),
 * - a present mirror without the declaration fails loud instead of
 *   silently shipping a stale identity (rc-3).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'vitest';

import { syncMcpServerVersionMirror } from '../release/lib/version-plan.mjs';

const VERSION_TS = `/**
 * Server identity.
 */
export const SERVER_NAME = 'pd-mcp-server' as const;

export const SERVER_VERSION = '0.1.0' as const;

export const MCP_SDK_PIN = '@modelcontextprotocol/server@2.4.0' as const;
`;

const created = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function scaffold(version, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-version-mirror-'));
  created.push(root);
  const pkgDir = path.join(root, 'packages', 'pd-mcp-server');
  fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@principles/pd-mcp-server', version }, null, 2) + '\n',
  );
  if (source !== undefined) fs.writeFileSync(path.join(pkgDir, 'src', 'version.ts'), source);
  return root;
}

function readMirror(root) {
  return fs.readFileSync(path.join(root, 'packages', 'pd-mcp-server', 'src', 'version.ts'), 'utf8');
}

describe('syncMcpServerVersionMirror', () => {
  it('rewrites a stale SERVER_VERSION to the package version', () => {
    const root = scaffold('0.2.0', VERSION_TS);

    assert.equal(syncMcpServerVersionMirror(root), true);

    const mirrored = readMirror(root);
    assert.match(mirrored, /export const SERVER_VERSION = '0\.2\.0' as const;/);
    // Everything else in the file is untouched.
    assert.match(mirrored, /export const MCP_SDK_PIN = '@modelcontextprotocol\/server@2\.4\.0' as const;/);
    assert.match(mirrored, /export const SERVER_NAME = 'pd-mcp-server' as const;/);
  });

  it('leaves an already-mirrored constant alone and reports no change', () => {
    const root = scaffold('0.2.0', VERSION_TS.replace("'0.1.0'", "'0.2.0'"));

    assert.equal(syncMcpServerVersionMirror(root), false);
    assert.equal(readMirror(root), VERSION_TS.replace("'0.1.0'", "'0.2.0'"));
  });

  it('reports no change when the component files are absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-version-mirror-'));
    created.push(root);

    assert.equal(syncMcpServerVersionMirror(root), false);
  });

  it('fails loud when the mirror exists without a SERVER_VERSION declaration', () => {
    const root = scaffold('0.2.0', 'export const SERVER_NAME = "pd-mcp-server";\n');

    assert.throws(
      () => syncMcpServerVersionMirror(root),
      /no SERVER_VERSION declaration/i,
    );
  });
});
