import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { FeedbackReport } from '@principles/core/runtime-v2/feedback';
import { FeedbackReportConsoleModel } from '../../src/server/models/FeedbackReportConsoleModel.js';

function makeReport(id: string): FeedbackReport {
  return {
    id,
    createdAt: '2026-08-17T00:00:00.000Z',
    type: 'bug',
    title: 'Title',
    userText: { description: 'desc' },
    diagnosticSummary: { versions: {}, platform: {}, featureFlags: {}, canary: { status: 'unavailable' }, recentEvents: [] },
    privacy: { redactionNotes: [] },
    outputs: { markdown: 'md', emailText: '', githubIssueUrl: '', mailtoUrl: '' },
  };
}

let tmpDir: string;
let workspaceDir: string;
let model: FeedbackReportConsoleModel;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fb-model-test-'));
  workspaceDir = path.join(tmpDir, 'w');
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  model = new FeedbackReportConsoleModel(workspaceDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FeedbackReportConsoleModel.update', () => {
  it('merges a partial patch and atomic-writes while preserving other fields', async () => {
    const id = 'fb-model-1';
    const created = await model.create(makeReport(id));
    expect(created.ok).toBe(true);

    const updated = await model.update(id, { status: 'submitted', trackingId: 'fb-x1', externalUrl: 'https://linear.app/i/2' });
    expect(updated.ok).toBe(true);
    expect(updated.report?.status).toBe('submitted');
    expect(updated.report?.trackingId).toBe('fb-x1');
    expect(updated.report?.externalUrl).toBe('https://linear.app/i/2');
    // Untouched fields preserved.
    expect(updated.report?.title).toBe('Title');

    // No stray *.tmp files remain after the atomic rename.
    const files = fs.readdirSync(path.join(workspaceDir, '.pd', 'feedback', 'drafts'));
    expect(files).toEqual([`${id}.json`]);

    // Reload from disk reflects the merged patch.
    const reloaded = await model.get(id);
    expect(reloaded.report?.status).toBe('submitted');
  });

  it('returns NOT_FOUND for a missing draft without writing anything', async () => {
    const r = await model.update('fb-nope', { status: 'submitted' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('NOT_FOUND');
  });

  it('rejects path-traversal ids', async () => {
    const r = await model.update('../escape', { status: 'submitted' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_ID');
  });
});