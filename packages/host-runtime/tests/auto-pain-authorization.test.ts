import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultPdConfig } from '@principles/core/runtime';
import {
  AUTO_PAIN_SUBMISSION_FLAG,
  isAutomaticPainSubmissionAuthorized,
} from '../src/auto-pain-authorization.js';

/**
 * SPEC-PD-AGENT-PAIN-INGRESS-001 §9.6: B-class automatic Pain submission
 * requires an independent per-Workspace Owner authorization — the flat
 * `automatic_pain_submission` feature flag in the Workspace's own
 * `.pd/config.yaml`. Default off; neighboring flags never imply it.
 */
describe('isAutomaticPainSubmissionAuthorized', () => {
  function makeWorkspace(features?: Record<string, { category: string; enabled: boolean }>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-autopain-'));
    fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
    const config = getDefaultPdConfig() as Record<string, unknown> & {
      features: Record<string, unknown>;
    };
    if (features !== undefined) config.features = { ...config.features, ...features };
    // JSON is valid YAML — the loader parses it identically to yaml.dump output.
    fs.writeFileSync(path.join(dir, '.pd', 'config.yaml'), JSON.stringify(config));
    return dir;
  }

  it('is BLOCKED when no config flag exists at all', () => {
    expect(isAutomaticPainSubmissionAuthorized(makeWorkspace())).toBe(false);
  });

  it('is BLOCKED when the flag is explicitly false', () => {
    const dir = makeWorkspace({ [AUTO_PAIN_SUBMISSION_FLAG]: { category: 'quiet', enabled: false } });
    expect(isAutomaticPainSubmissionAuthorized(dir)).toBe(false);
  });

  it('is authorized only when the Workspace enables the flag', () => {
    const dir = makeWorkspace({ [AUTO_PAIN_SUBMISSION_FLAG]: { category: 'quiet', enabled: true } });
    expect(isAutomaticPainSubmissionAuthorized(dir)).toBe(true);
  });

  it('is per-Workspace: enabling A does not authorize B', () => {
    const a = makeWorkspace({ [AUTO_PAIN_SUBMISSION_FLAG]: { category: 'quiet', enabled: true } });
    const b = makeWorkspace();
    expect(isAutomaticPainSubmissionAuthorized(a)).toBe(true);
    expect(isAutomaticPainSubmissionAuthorized(b)).toBe(false);
  });

  it('signal_collector=true alone is NOT an authorization', () => {
    const dir = makeWorkspace({ signal_collector: { category: 'quiet', enabled: true } });
    expect(isAutomaticPainSubmissionAuthorized(dir)).toBe(false);
  });

  it('internalization_auto_consumer=true alone is NOT an authorization', () => {
    const dir = makeWorkspace({ internalization_auto_consumer: { category: 'quiet', enabled: true } });
    expect(isAutomaticPainSubmissionAuthorized(dir)).toBe(false);
  });

  it('is BLOCKED for a missing workspace dir (fail-closed)', () => {
    expect(isAutomaticPainSubmissionAuthorized(path.join(os.tmpdir(), 'pd-autopain-nonexistent'))).toBe(false);
  });
});
