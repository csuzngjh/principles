import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isReleaseReadPathContained } from './release-containment';

/**
 * Regression: the CI publication directory arrives with MIXED separators on
 * Windows (`D:\a\_temp` from runner.temp + `/pd-publication-two` appended by
 * the workflow). Resolved read paths normalize to `\` while the raw env form
 * keeps `/`, so the pre-fix lexical prefix check rejected legitimate reads
 * ("Refusing to read outside the allowed roots", publish-npm failures on all
 * Windows nodes 2026-08-28). These tests pin the containment contract in
 * canonical form: same-directory mixed separators accepted; adjacent,
 * prefix-collision, and out-of-root paths rejected.
 */

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-containment-'));

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'pd-publication-two'), { recursive: true });
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }), 60_000);

/**
 * The pre-fix comparison (raw startsWith, no canonicalization) — used as the
 * NEGATIVE CONTROL on Windows: every mixed-separator case that must pass with
 * canonicalization must fail with this legacy form, proving the test
 * exercises the normalization mechanism rather than passing vacuously.
 */
function legacyContained(readPath: string, allowedRoot: string): boolean {
  return readPath === allowedRoot || readPath.startsWith(allowedRoot + path.sep);
}

/** Forward-slash form of a path (the distinguishing axis on Windows). */
function forwardSlashForm(inputPath: string): string {
  return inputPath.replaceAll('\\', '/');
}

describe('release read-path containment', () => {
  it('accepts a same-directory read regardless of separator style', () => {
    const archive = path.join(root, 'pd-publication-two', 'asset.tar');
    fs.writeFileSync(archive, 'x');
    const mixedPublication = forwardSlashForm(path.join(root, 'pd-publication-two'));

    // CI shape: allowedRoot keeps the env's raw form, read path is resolved
    // (path.resolve normalizes separators to path.sep on every platform).
    const readPath = path.resolve(archive);
    expect(isReleaseReadPathContained(readPath, [root, mixedPublication])).toBe(true);
  });

  it('rejects adjacent directories, prefix-collision siblings, and out-of-root paths', () => {
    const mixedPublication = forwardSlashForm(path.join(root, 'pd-publication-two'));

    // Adjacent sibling of the publication dir, outside every allowed root
    // (sits next to `root` in os.tmpdir(), not inside it).
    const adjacent = path.resolve(path.join(path.dirname(root), 'pd-publication-other', 'asset.tar'));
    expect(isReleaseReadPathContained(adjacent, [root, mixedPublication])).toBe(false);

    // Prefix collision: `pd-publication-two-evil` shares the string prefix of
    // the publication root but is NOT inside it — rejected through the
    // separator-suffix requirement even when both sides use forward slashes
    // (allowedRoots here is ONLY the publication root, no test root).
    const collision = path.resolve(path.join(root, 'pd-publication-two-evil', 'asset.tar'));
    expect(isReleaseReadPathContained(collision, [mixedPublication])).toBe(false);

    // Truly outside every allowed root.
    const outside = path.resolve(path.join(os.tmpdir(), 'elsewhere', 'asset.tar'));
    expect(isReleaseReadPathContained(outside, [root, mixedPublication])).toBe(false);
    expect(isReleaseReadPathContained(outside, [root])).toBe(false);
  });

  it('collapses parent-directory traversal before comparing', () => {
    const mixedPublication = forwardSlashForm(path.join(root, 'pd-publication-two'));

    // A `..` hop that RESOLVES back inside the publication is contained...
    const hopsBackIn = path.resolve(path.join(root, 'pd-publication-two', 'sub', '..', 'asset.tar'));
    expect(isReleaseReadPathContained(hopsBackIn, [root, mixedPublication])).toBe(true);
    // ...while two `..` hops from root/<dir> land in os.tmpdir() itself,
    // which is outside every allowed root.
    const escapes = path.resolve(path.join(root, 'pd-publication-two', '..', '..', 'asset.tar'));
    expect(escapes.startsWith(root + path.sep)).toBe(false);
    expect(isReleaseReadPathContained(escapes, [root, mixedPublication])).toBe(false);
  });
});

describe.skipIf(process.platform !== 'win32')('release read-path containment on Windows', () => {
  it('accepts the exact CI mixed-separator shape that failed publish-npm', () => {
    // Reproduce the literal workflow shape: `D:\a\_temp` (runner.temp,
    // backslashes) + `/pd-publication-two` (workflow literal, forward slash).
    const parent = path.dirname(path.join(root, 'pd-publication-two'));
    const ciMixedForm = `${parent}/pd-publication-two`;

    const readPath = path.resolve(path.join(root, 'pd-publication-two', 'asset.tar'));
    expect(readPath).toContain('\\');
    expect(ciMixedForm).toContain('/');

    // Fixed behavior: canonical comparison accepts the same directory.
    expect(isReleaseReadPathContained(readPath, [root, ciMixedForm])).toBe(true);
    // Pre-fix behavior (negative control): the raw prefix check rejected it.
    expect(legacyContained(readPath, ciMixedForm)).toBe(false);
  });
});
