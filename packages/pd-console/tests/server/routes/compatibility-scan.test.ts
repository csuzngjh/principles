/**
 * 5B-F: read-only compatibility-scan endpoint.
 *
 * Pins the console projection: reason-granular counts + bounded samples, never
 * the per-row findings array; method guard; and a loud degradation when the
 * scan throws (rc-9).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleCompatibilityScanRoute,
  toCompatibilityScanView,
  type CompatibilityScanner,
} from '../../../src/server/routes/compatibility-scan.js';

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writableEnded = false;
  writeHead(statusCode: number, headers: Record<string, string>): void {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
  }
  end(chunk?: string): void {
    this.body += chunk ?? '';
    this.writableEnded = true;
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.body) as Record<string, unknown>;
  }
}

function req(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}

const result = (overrides: Record<string, unknown>) => ({
  ok: true,
  workspaceDir: '/ws',
  status: 'incomplete' as const,
  findings: [],
  scannedActivations: 3,
  skipped: [{ reason: 'invalid_content_json', count: 2, sampleActivationIds: ['act-a', 'act-b'] }],
  reason: 'unscannable_active_rows',
  nextAction: 'run pd runtime compatibility-scan',
  ...overrides,
});

describe('toCompatibilityScanView (5B-F)', () => {
  it('projects reason-granular buckets and drops the per-row findings array', () => {
    const view = toCompatibilityScanView(
      result({
        findings: [
          {
            activationId: 'act-legacy',
            artifactId: 'art-legacy',
            ruleId: 'rule-legacy',
            symbols: ['recentThinking'],
          },
        ],
      }) as never,
    );
    expect(view).toEqual({
      status: 'incomplete',
      scannedActivations: 3,
      unscannable: [{ reason: 'invalid_content_json', count: 2, sampleActivationIds: ['act-a', 'act-b'] }],
      findingsTotal: 1,
      reason: 'unscannable_active_rows',
      nextAction: 'run pd runtime compatibility-scan',
    });
    expect(Object.hasOwn(view, 'findings')).toBe(false);
    expect(Object.hasOwn(view, 'workspaceDir')).toBe(false);
  });

  it('keeps reason/nextAction absent when the scan did not provide them', () => {
    const view = toCompatibilityScanView(result({ status: 'clean', reason: undefined, nextAction: undefined, skipped: [] }) as never);
    expect(Object.hasOwn(view, 'reason')).toBe(false);
    expect(Object.hasOwn(view, 'nextAction')).toBe(false);
    expect(view.unscannable).toEqual([]);
  });
});

describe('handleCompatibilityScanRoute (5B-F)', () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('GET returns the projected scan without mutating the workspace', () => {
    let seenWorkspace = '';
    const scanner: CompatibilityScanner = workspaceDir => {
      seenWorkspace = workspaceDir;
      return result({}) as never;
    };
    const res = new FakeResponse();
    handleCompatibilityScanRoute(req('GET'), res as unknown as ServerResponse, '/ws', scanner);
    expect(res.statusCode).toBe(200);
    expect(seenWorkspace).toBe('/ws');
    const body = res.json() as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data['status']).toBe('incomplete');
    expect(body.data['unscannable']).toEqual([
      { reason: 'invalid_content_json', count: 2, sampleActivationIds: ['act-a', 'act-b'] },
    ]);
  });

  it('non-GET is rejected with 405 and never runs the scan', () => {
    let called = false;
    const scanner: CompatibilityScanner = () => {
      called = true;
      return result({}) as never;
    };
    const res = new FakeResponse();
    handleCompatibilityScanRoute(req('POST'), res as unknown as ServerResponse, '/ws', scanner);
    expect(res.statusCode).toBe(405);
    expect(called).toBe(false);
  });

  it('a throwing scan is a loud 500 with a reason, not an empty list', () => {
    const scanner: CompatibilityScanner = () => {
      throw new Error('database is locked');
    };
    const res = new FakeResponse();
    handleCompatibilityScanRoute(req('GET'), res as unknown as ServerResponse, '/ws', scanner);
    expect(res.statusCode).toBe(500);
    const body = res.json() as { success: boolean; error: string; reason: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('compatibility_scan_failed');
    expect(body.reason).toBe('compatibility_scan_failed');
  });

  it('default scanner on a fresh workspace reports no_state_db (real core read model)', () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'pd-console-compat-'));
    cleanups.push(workspaceDir);
    const res = new FakeResponse();
    handleCompatibilityScanRoute(req('GET'), res as unknown as ServerResponse, workspaceDir);
    expect(res.statusCode).toBe(200);
    const data = (res.json() as { data: Record<string, unknown> }).data;
    expect(data['status']).toBe('no_state_db');
    expect(data['unscannable']).toEqual([]);
  });
});
