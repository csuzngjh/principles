import { describe, expect, it } from 'vitest';
import {
  INSTALL_LAYOUT_PACKAGE,
  classifyPrePublishCohort,
} from './helpers/prepublish-cohort.js';

// Negative/adversarial coverage for the PRI-669 gate's one admitted
// exception: the pre-publish Version Packages cohort window. Everything that
// is NOT provably that window must keep failing loudly.

const etarget = (range: string) =>
  `npm error code ETARGET\nnpm error notarget No matching version found for ${INSTALL_LAYOUT_PACKAGE}@${range}.\n`;

describe('classifyPrePublishCohort', () => {
  it('admits the cohort window: range floor equals the committed local version, registry behind it', () => {
    const note = classifyPrePublishCohort({
      npmErrorText: etarget('^0.2.7'),
      range: '^0.2.7',
      localVersion: '0.2.7',
      registryVersions: ['0.1.0', '0.2.0', '0.2.6'],
    });
    expect(note).not.toBeNull();
    expect(note).toContain('pre-publish Version Packages cohort');
    expect(note).toContain('nextAction');
  });

  it('rejects a feature-branch range ahead of the local version (the 2026-09-04 defect shape)', () => {
    expect(
      classifyPrePublishCohort({
        npmErrorText: etarget('^0.3.0'),
        range: '^0.3.0',
        localVersion: '0.2.7',
        registryVersions: ['0.2.0', '0.2.6'],
      }),
    ).toBeNull();
  });

  it('rejects when the range floor is not the committed local version', () => {
    expect(
      classifyPrePublishCohort({
        npmErrorText: etarget('^0.2.7'),
        range: '^0.2.7',
        localVersion: '0.2.6',
        registryVersions: ['0.2.0', '0.2.5'],
      }),
    ).toBeNull();
  });

  it('rejects when a registry-visible version already satisfies the range', () => {
    expect(
      classifyPrePublishCohort({
        npmErrorText: etarget('^0.2.7'),
        range: '^0.2.7',
        localVersion: '0.2.7',
        registryVersions: ['0.2.6', '0.2.7', '0.2.8'],
      }),
    ).toBeNull();
  });

  it('rejects when the local version itself is already visible on the registry', () => {
    expect(
      classifyPrePublishCohort({
        npmErrorText: etarget('^0.2.7'),
        range: '^0.2.7',
        localVersion: '0.2.7',
        registryVersions: ['0.2.6', '0.2.7'],
      }),
    ).toBeNull();
  });

  it('rejects a non-ETARGET install failure', () => {
    expect(
      classifyPrePublishCohort({
        npmErrorText: 'npm ERR! EACCES permission denied',
        range: '^0.2.7',
        localVersion: '0.2.7',
        registryVersions: [],
      }),
    ).toBeNull();
  });

  it('rejects an ETARGET for a different dependency', () => {
    expect(
      classifyPrePublishCohort({
        npmErrorText: 'npm error code ETARGET\nnpm error notarget No matching version found for commander@^99.0.0.\n',
        range: '^0.2.7',
        localVersion: '0.2.7',
        registryVersions: [],
      }),
    ).toBeNull();
  });

  it('rejects malformed range / local version / version inputs without throwing', () => {
    const base = { npmErrorText: etarget('^0.2.7'), registryVersions: ['0.2.0'] };
    expect(classifyPrePublishCohort({ ...base, range: undefined, localVersion: '0.2.7' })).toBeNull();
    expect(classifyPrePublishCohort({ ...base, range: 'not a range', localVersion: '0.2.7' })).toBeNull();
    expect(classifyPrePublishCohort({ ...base, range: '^0.2.7', localVersion: undefined })).toBeNull();
    expect(classifyPrePublishCohort({ ...base, range: '^0.2.7', localVersion: 'v0.2.7-beta!' })).toBeNull();
    expect(
      classifyPrePublishCohort({
        ...base,
        range: '^0.2.7',
        localVersion: '0.2.7',
        registryVersions: ['garbage', '0.999999.0-not-semver'],
      }),
    ).not.toBeNull();
  });

  it('admits non-caret ranges only when their floor is the local version', () => {
    expect(
      classifyPrePublishCohort({
        npmErrorText: etarget('>=0.2.7 <0.3.0'),
        range: '>=0.2.7 <0.3.0',
        localVersion: '0.2.7',
        registryVersions: ['0.2.6'],
      }),
    ).not.toBeNull();
    expect(
      classifyPrePublishCohort({
        npmErrorText: etarget('0.2.7'),
        range: '0.2.7',
        localVersion: '0.2.6',
        registryVersions: ['0.2.5'],
      }),
    ).toBeNull();
  });
});
