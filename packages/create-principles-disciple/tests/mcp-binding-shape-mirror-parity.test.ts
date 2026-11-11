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
  getCanonicalMcpServerEntry,
  validateMcpBinding,
} from '@principles/install-layout';
import { validateMcpBindingShape } from '../src/installers/mcp-binding-shape-mirror.js';

const root = path.join(path.sep, 'tmp', 'pd-binding-mirror-parity');

const PLATFORMS = ['win32', 'posix'] as const;

describe('installer MCP binding shape mirror', () => {
  for (const host of MCP_BINDING_HOSTS) {
    for (const fixture of MCP_BINDING_FIXTURES) {
      for (const platform of PLATFORMS) {
        it(`matches the shared declaration for ${host} / ${fixture.id} (${platform})`, () => {
          const runtimeDir = path.join(root, host, 'runtime');
          const raw = buildMcpBindingFixture(fixture.id, {
            host,
            runtimeDir,
            workspaceDir: path.join(root, host, 'workspace'),
            foreignServerEntry: path.join(root, host, 'elsewhere', 'dist', 'index.js'),
            versions: {mcpServer: '0.1.0', core: '0.7.0'},
          });

          const shared = validateMcpBinding(raw, host, platform);
          const mirror = validateMcpBindingShape(raw, host, platform);

          expect(mirror.ok).toBe(shared.ok);
          if (!shared.ok) {
            expect(mirror.ok ? '' : mirror.reason).toBe(shared.reason);
            return;
          }
          expect(mirror.ok).toBe(true);
          if (!mirror.ok) return;
          // Content, not just acceptance: the installer consumes these fields
          // (codex-host-installer.ts isMcpBindingHealthy), so a normalized or
          // dropped field would be drift the `ok`-only assertion missed.
          expect(mirror.binding.workspaceDir).toBe(shared.binding.workspaceDir);
          expect(mirror.binding.runtimeDir).toBe(shared.binding.runtimeDir);
          expect(mirror.binding.serverEntry).toBe(shared.binding.serverEntry);
          expect(mirror.binding.versions).toEqual(shared.binding.versions);
        });
      }
    }
  }

  it('honours the same win32 case rule as the shared declaration', () => {
    const runtimeDir = path.join(root, 'CaseSensitive', 'runtime');
    const raw = buildMcpBindingFixture('valid', {
      host: 'codex',
      runtimeDir,
      workspaceDir: path.join(root, 'workspace'),
      foreignServerEntry: path.join(root, 'elsewhere', 'dist', 'index.js'),
      versions: {mcpServer: '0.1.0', core: '0.7.0'},
    }) as Record<string, unknown>;
    const caseOnly = {...raw, serverEntry: getCanonicalMcpServerEntry('codex', runtimeDir.toUpperCase())};

    expect(validateMcpBinding(caseOnly, 'codex', 'win32').ok).toBe(true);
    expect(validateMcpBindingShape(caseOnly, 'codex', 'win32').ok).toBe(true);
    expect(validateMcpBindingShape(caseOnly, 'codex', 'posix')).toEqual({
      ok: false,
      reason: 'server_entry_not_canonical:codex',
    });
  });
});
