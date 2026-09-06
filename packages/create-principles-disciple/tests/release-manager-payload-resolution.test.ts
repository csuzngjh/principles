/**
 * PR #1525 review — the release-manager PAYLOAD's dependency resolution shape.
 *
 * The npm-distributed payload ships release-manager/ as package.json + dist
 * only. The authority module's static import chain (release-manager →
 * trust-metadata → tuf-js) therefore resolves ONLY when the component's own
 * dependencies are reachable from its real install path — which is exactly
 * what the installer's npm-install step provides (and what the review found
 * missing). These tests pin that shape against the REAL built module using
 * physical-path resolution (createRequire anchors resolution at the payload's
 * real file location — the same walk Node performs at runtime; the vitest
 * runner is deliberately not involved):
 *
 *   A. payload WITHOUT reachable deps → tuf-js unresolvable from the payload
 *      (the artifact-level form of the review's finding);
 *   B. payload WITH reachable deps (the installer-fixed state) → tuf-js
 *      resolves, and the built trust-metadata graph really links against it.
 *
 * Requires the built dist (tsc output); skipped on a clean checkout before a
 * build, loud in CI and local verify runs where the build ran.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = path.resolve(__dirname, '..');
const builtAuthority = path.join(packageRoot, 'dist', 'update', 'release-manager-authority.js');
const builtTrustMetadata = path.join(packageRoot, 'dist', 'update', 'trust-metadata.js');
const payloadPackageJson = path.join(packageRoot, 'release-manager', 'package.json');
const repoNodeModules = path.resolve(packageRoot, '..', '..', 'node_modules');

const hasBuiltPayload = fs.existsSync(builtAuthority) && fs.existsSync(builtTrustMetadata) && fs.existsSync(payloadPackageJson) && fs.existsSync(repoNodeModules);

let lab: string | undefined;

function makePayloadLab(): { payloadDir: string; authorityEntry: string } {
  lab = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rm-payload-'));
  const payloadDir = path.join(lab, 'release-manager');
  fs.mkdirSync(payloadDir, { recursive: true });
  // The npm-distributed payload shape: package.json + dist only.
  fs.copyFileSync(payloadPackageJson, path.join(payloadDir, 'package.json'));
  fs.cpSync(path.join(packageRoot, 'dist'), path.join(payloadDir, 'dist'), { recursive: true });
  return { payloadDir, authorityEntry: path.join(payloadDir, 'dist', 'update', 'release-manager-authority.js') };
}

afterEach(() => {
  if (lab && fs.existsSync(lab)) fs.rmSync(lab, { recursive: true, force: true });
  lab = undefined;
});

describe.skipIf(!hasBuiltPayload)('release-manager payload dependency resolution (PR #1525 review)', () => {
  it('documents the finding: the bare npm payload cannot reach its own deps (tuf-js)', () => {
    const { authorityEntry } = makePayloadLab();
    // Physical resolution from the authority's real location: the walk-up
    // finds no node_modules ancestor — exactly the installed npm shape.
    expect(() => createRequire(authorityEntry).resolve('tuf-js')).toThrow(/Cannot find module/);
  });

  it('with dependencies reachable from the payload dir, the authority graph resolves', () => {
    const { payloadDir, authorityEntry } = makePayloadLab();
    // Model the installer-fixed state: dependencies reachable from the
    // payload's real path (what npm install in that directory provides).
    fs.symlinkSync(repoNodeModules, path.join(payloadDir, 'node_modules'), 'junction');

    // The chain link the review named resolves from the payload's real path…
    const tufJsPath = createRequire(authorityEntry).resolve('tuf-js');
    expect(fs.realpathSync(tufJsPath)).toContain('tuf-js');
    // …and the built module graph really links against it.
    const trustSource = fs.readFileSync(path.join(payloadDir, 'dist', 'update', 'trust-metadata.js'), 'utf-8');
    expect(trustSource).toMatch(/from ['"]tuf-js['"]/);
  });
});
