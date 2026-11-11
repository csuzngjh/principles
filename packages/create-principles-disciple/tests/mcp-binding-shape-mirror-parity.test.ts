/**
 * Pins the installer's mirrored MCP binding shape gate to the shared
 * declaration in @principles/install-layout.
 *
 * The mirror exists because the packaged installer must load against the
 * PUBLISHED install-layout (registry-parity smoke, PRI-669/RF-02) and a normal
 * PR cannot raise the dependency floor. This test is what keeps that mirror
 * from drifting: for every host and every fixture the shared validator and the
 * mirror must agree on both `ok` and the exact `reason` string.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  MCP_BINDING_FIXTURES,
  MCP_BINDING_HOSTS,
  buildMcpBindingFixture,
  validateMcpBinding,
} from '@principles/install-layout';
import { validateMcpBindingShape } from '../src/installers/mcp-binding-shape-mirror.js';

const root = path.join(path.sep, 'tmp', 'pd-binding-mirror-parity');

describe('installer MCP binding shape mirror', () => {
  for (const host of MCP_BINDING_HOSTS) {
    for (const fixture of MCP_BINDING_FIXTURES) {
      it(`matches the shared declaration for ${host} / ${fixture.id}`, () => {
        const runtimeDir = path.join(root, host, 'runtime');
        const raw = buildMcpBindingFixture(fixture.id, {
          host,
          runtimeDir,
          workspaceDir: path.join(root, host, 'workspace'),
          foreignServerEntry: path.join(root, host, 'elsewhere', 'dist', 'index.js'),
          versions: {mcpServer: '0.1.0', core: '0.7.0'},
        });

        const shared = validateMcpBinding(raw, host);
        const mirror = validateMcpBindingShape(raw, host);

        expect(mirror.ok).toBe(shared.ok);
        if (!shared.ok) {
          expect(mirror.ok ? '' : mirror.reason).toBe(shared.reason);
        }
      });
    }
  }
});
