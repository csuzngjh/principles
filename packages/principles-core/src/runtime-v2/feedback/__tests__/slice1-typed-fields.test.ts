/**
 * Slice 1 typed-field tests (PRI-543): frequency / blockingLevel / per-type
 * conditional text fields (goal, stuckAt, job, currentWorkaround, sawWhat,
 * whereSeen) and area. Verifies end-to-end from normalize → create → render:
 *   - normalizeFeedbackDraftInput accepts valid typed fields and rejects invalid ones
 *   - new text fields pass through the same redaction pipeline in createFeedbackReport
 *   - area propagates to report.area
 *   - renderReportMarkdown / buildEmailText render typed fields conditionally by type
 *   - old drafts (no new fields) still parse (no regression)
 *
 * ERR checklist:
 * - EP-01 / ERR-001: input is passed as unknown; no `as` casts in tests.
 * - ERR-003: redaction is segment-exact on the typed text fields.
 * - ERR-009/010: invalid enum / non-string typed fields fail loud with reason + nextAction.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeFeedbackDraftInput,
  createFeedbackReport,
  renderReportMarkdown,
  computeFeedbackFingerprint,
  type FeedbackDraftInput,
} from '../index.js';

const diagnostics = {};

function expectOk(input: unknown) {
  const result = createFeedbackReport(input, diagnostics);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected ok report');
  return result.report;
}

const baseInput: FeedbackDraftInput = {
  type: 'confusing',
  title: 'Can not save environment variable',
  description: 'I tried to save an env var and nothing happened',
};

describe('normalizeFeedbackDraftInput — typed field validation', () => {
  it('accepts typed text fields and area', () => {
    const input: FeedbackDraftInput = {
      ...baseInput,
      area: 'principles',
      goal: 'to set a default env var',
      stuckAt: 'the save button',
    };
    const r = normalizeFeedbackDraftInput(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.area).toBe('principles');
      expect(r.value.userText.goal).toBe('to set a default env var');
      expect(r.value.userText.stuckAt).toBe('the save button');
    }
  });

  it('accepts frequency and blockingLevel enums', () => {
    const input: FeedbackDraftInput = {
      type: 'bug',
      title: 'Runner crashes',
      description: 'crashes on load',
      frequency: 'always',
      blockingLevel: 'blocked',
    };
    const r = normalizeFeedbackDraftInput(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.userText.frequency).toBe('always');
      expect(r.value.userText.blockingLevel).toBe('blocked');
    }
  });

  it('rejects invalid frequency', () => {
    const input: FeedbackDraftInput = {
      type: 'bug',
      title: 't',
      description: 'd',
      frequency: 'every_time',
    };
    const r = normalizeFeedbackDraftInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const f = r.errors.find((e) => e.field === 'frequency');
      expect(f).toBeDefined();
      expect(f?.reason).toContain('always, often, sometimes, once');
      expect(f?.nextAction).toBeTruthy();
    }
  });

  it('rejects invalid blockingLevel', () => {
    const input: FeedbackDraftInput = {
      type: 'bug',
      title: 't',
      description: 'd',
      blockingLevel: 'severely',
    };
    const r = normalizeFeedbackDraftInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const f = r.errors.find((e) => e.field === 'blockingLevel');
      expect(f).toBeDefined();
      expect(f?.reason).toContain('blocked, workaround, minor');
    }
  });

  it('rejects non-string typed text field', () => {
    const input: FeedbackDraftInput = {
      type: 'confusing',
      title: 't',
      description: 'd',
      goal: 42,
    };
    const r = normalizeFeedbackDraftInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const f = r.errors.find((e) => e.field === 'goal');
      expect(f).toBeDefined();
      expect(f?.reason).toContain('must be a string');
    }
  });

  it('accepts a legacy draft with no new fields (no regression)', () => {
    const r = normalizeFeedbackDraftInput(baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.area).toBeUndefined();
      expect(r.value.userText.goal).toBeUndefined();
    }
  });
});

describe('createFeedbackReport — typed field propagation + redaction', () => {
  it('carries typed text fields into userText', () => {
    const report = expectOk({
      ...baseInput,
      area: 'failed_tasks',
      goal: 'to retry a failed task',
      stuckAt: 'the retry button',
    });
    expect(report.area).toBe('failed_tasks');
    expect(report.userText.goal).toBe('to retry a failed task');
    expect(report.userText.stuckAt).toBe('the retry button');
  });

  it('redacts absolute paths inside typed text fields and records a note', () => {
    const report = expectOk({
      ...baseInput,
      goal: 'open the file at C:\\Users\\alice\\config.json',
    });
    expect(report.userText.goal).not.toContain('C:\\Users\\alice');
    expect(report.privacy.redactionNotes.some((n) => n.startsWith('goal'))).toBe(true);
  });

  it('carries frequency and blockingLevel through to the report', () => {
    const report = expectOk({
      type: 'bug',
      title: 't',
      description: 'd',
      frequency: 'sometimes',
      blockingLevel: 'workaround',
    });
    expect(report.userText.frequency).toBe('sometimes');
    expect(report.userText.blockingLevel).toBe('workaround');
  });

  it('does not set area when input omits it', () => {
    const report = expectOk(baseInput);
    expect(report.area).toBeUndefined();
  });
});

describe('renderReportMarkdown — conditional typed sections', () => {
  it('renders confusing sections only for confusing reports', () => {
    const report = expectOk({
      ...baseInput,
      goal: 'to do X',
      stuckAt: 'step 2',
    });
    const md = report.outputs.markdown;
    expect(md).toContain('What I wanted to do');
    expect(md).toContain('to do X');
    expect(md).toContain('Where I got stuck');
    expect(md).not.toContain('Goal');
    expect(md).not.toContain('Current workaround');
  });

  it('renders feature_request sections for feature_request reports', () => {
    const report = expectOk({
      type: 'feature_request',
      title: 'want export',
      description: 'd',
      job: 'export the report to a file',
      currentWorkaround: 'I screenshot it',
    });
    const md = report.outputs.markdown;
    expect(md).toContain('Goal');
    expect(md).toContain('export the report to a file');
    expect(md).toContain('Current workaround');
    expect(md).not.toContain('What I wanted to do');
  });

  it('renders privacy_concern sections for privacy_concern reports', () => {
    const report = expectOk({
      type: 'privacy_concern',
      title: 'token visible',
      description: 'd',
      sawWhat: 'a bearer token',
      whereSeen: 'the status page',
    });
    const md = report.outputs.markdown;
    expect(md).toContain('What I saw');
    expect(md).toContain('Where I saw it');
  });

  it('emits frequency / blockingLevel / area lines when present', () => {
    const md = expectOk({
      type: 'bug',
      title: 't',
      description: 'd',
      area: 'failed_tasks',
      frequency: 'always',
      blockingLevel: 'blocked',
    }).outputs.markdown;
    expect(md).toContain('Frequency: `always`');
    expect(md).toContain('Blocking level: `blocked`');
    expect(md).toContain('Area: `failed_tasks`');
  });

  it('omits typed sections for the "other" type', () => {
    const md = expectOk({
      type: 'other',
      title: 't',
      description: 'just saying hi',
    }).outputs.markdown;
    expect(md).not.toContain('Current workaround');
    expect(md).not.toContain('What I wanted to do');
  });

  it('does not render empty typed sections when fields are absent', () => {
    const md = renderReportMarkdown(
      expectOk({
        type: 'confusing',
        title: 't',
        description: 'no typed details',
      }),
    );
    expect(md).not.toContain('What I wanted to do');
    expect(md).not.toContain('Where I got stuck');
  });
});

describe('buildEmailText — conditional typed sections', () => {
  it('renders confusing email sections', () => {
    const report = expectOk({
      ...baseInput,
      goal: 'to do X',
      stuckAt: 'step 2',
    });
    const email = report.outputs.emailText;
    expect(email).toContain('— What I wanted to do —');
    expect(email).toContain('to do X');
    expect(email).toContain('— Where I got stuck —');
  });

  it('renders feature_request email sections', () => {
    const email = expectOk({
      type: 'feature_request',
      title: 'want export',
      description: 'd',
      job: 'export it',
      currentWorkaround: 'screenshot',
    }).outputs.emailText;
    expect(email).toContain('— Goal —');
    expect(email).toContain('— Current workaround —');
  });

  it('emits frequency / blockingLevel / area lines when present', () => {
    const email = expectOk({
      type: 'bug',
      title: 't',
      description: 'd',
      area: 'failed_tasks',
      frequency: 'often',
      blockingLevel: 'minor',
    }).outputs.emailText;
    expect(email).toContain('Frequency: often');
    expect(email).toContain('Blocking level: minor');
    expect(email).toContain('Area: failed_tasks');
  });

  it('omits typed sections for "other" type', () => {
    const email = expectOk({
      type: 'other',
      title: 't',
      description: 'hi',
    }).outputs.emailText;
    expect(email).not.toContain('— Goal —');
  });
});

describe('fingerprint used together with area in reports', () => {
  it('computes a deterministic fingerprint for a reported entity area', () => {
    const fp1 = computeFeedbackFingerprint({ type: 'bug', title: 'Peers never finish', area: 'failed_tasks' });
    const fp2 = computeFeedbackFingerprint({ type: 'bug', title: ' Peers, never finish! ', area: 'failed_tasks' });
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });
});