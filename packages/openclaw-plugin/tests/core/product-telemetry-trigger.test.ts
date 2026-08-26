/**
 * Anonymous Product Telemetry v1 — plugin trigger wiring test (PRI-599).
 *
 * The one-time workspace init in before_prompt_build must schedule exactly
 * one fire-and-forget export attempt through the host-runtime service, and
 * the wrapper must not throw even if the service explodes (telemetry can
 * never break a hook).
 */

import { describe, expect, it, vi } from 'vitest';

const telemetryMock = vi.hoisted(() => ({
  createCalls: 0,
  scheduleCalls: [] as Array<{ workspaceDir: string; hasLogger: boolean }>,
  service: { maybeExportDaily: async () => ({ attempted: false, skipReason: 'consent_unset' }) },
}));

vi.mock('@principles/host-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/host-runtime')>();
  return {
    ...actual,
    createProductTelemetryService: () => {
      telemetryMock.createCalls += 1;
      return telemetryMock.service;
    },
    scheduleProductTelemetryExport: (
      _service: unknown,
      workspaceDir: string,
      _logger?: unknown,
    ) => {
      telemetryMock.scheduleCalls.push({ workspaceDir, hasLogger: _logger !== undefined });
    },
  };
});

import { scheduleTelemetryExportForWorkspace } from '../../src/core/product-telemetry-trigger.js';

describe('plugin telemetry trigger', () => {
  it('schedules one export attempt for the workspace through the host-runtime service', () => {
    const logger = { info: (_m: string) => {}, warn: (_m: string) => {} };
    scheduleTelemetryExportForWorkspace('/tmp/ws-a', logger);
    expect(telemetryMock.createCalls).toBe(1);
    expect(telemetryMock.scheduleCalls).toEqual([{ workspaceDir: '/tmp/ws-a', hasLogger: true }]);
  });

  it('works without a logger and never throws', () => {
    expect(() => scheduleTelemetryExportForWorkspace('/tmp/ws-b')).not.toThrow();
    expect(telemetryMock.scheduleCalls).toHaveLength(2);
  });
});
