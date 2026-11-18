/**
 * WorkBuddy projects-root experiment boundary (Round 3 §4.3 / review N3Z).
 *
 * `resolveWorkbuddyProjectsRoot()` is the discovery authority for transcript
 * reads. In experiment mode the projects LEAF itself must be boundary-verified:
 * a `<root>/.workbuddy/projects` junction pointing at the production transcript
 * store would otherwise resolvePdHome cleanly (the leaf is not a PdHomePaths
 * field) and read production conversations. Production mode is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkbuddyProjectsRoot, validateWorkbuddyTranscriptPath } from '../../src/ingestion/transcript-path.js';

const savedEnv: Record<string, string | undefined> = {};
let created: string[] = [];

function tempDir(label: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `pd-wb-projects-boundary-${label}-`)));
  created.push(dir);
  return dir;
}

function linkDir(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

beforeEach(() => {
  created = [];
  savedEnv.PD_EXPERIMENT_ROOT = process.env.PD_EXPERIMENT_ROOT;
  savedEnv.WORKBUDDY_CONFIG_DIR = process.env.WORKBUDDY_CONFIG_DIR;
  savedEnv.OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
  savedEnv.OPENCLAW_HOME = process.env.OPENCLAW_HOME;
  savedEnv.HOME = process.env.HOME;
  delete process.env.WORKBUDDY_CONFIG_DIR;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_HOME;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps handles open; the run-level temp lifecycle reclaims it.
    }
  }
});

describe('resolveWorkbuddyProjectsRoot — experiment boundary on the projects leaf', () => {
  it('scenario 1: a normal experiment projects root resolves (lazily, no dir yet)', () => {
    const root = tempDir('ok-root');
    process.env.PD_EXPERIMENT_ROOT = root;

    const result = resolveWorkbuddyProjectsRoot();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.root).toBe(path.join(root, '.workbuddy', 'projects'));
  });

  it('scenario 2: a projects junction pointing at the production transcript store is refused', () => {
    const root = tempDir('esc-root');
    const productionProjects = tempDir('production-projects');
    fs.writeFileSync(path.join(productionProjects, 'session.jsonl'), '{"production":true}', 'utf8');
    const experimentWorkbuddy = path.join(root, '.workbuddy');
    fs.mkdirSync(experimentWorkbuddy, { recursive: true });
    linkDir(productionProjects, path.join(experimentWorkbuddy, 'projects'));
    process.env.PD_EXPERIMENT_ROOT = root;

    const result = resolveWorkbuddyProjectsRoot();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('workbuddy_projects_root_escapes_experiment');
      expect(result.nextAction).toContain('junction');
    }
  });

  it('scenario 3: a transcript symlink pointing at a production file stays outside the canonical root', (ctx) => {
    const root = tempDir('file-esc-root');
    const productionProjects = tempDir('production-projects');
    const productionFile = path.join(productionProjects, '99999999-8888-4777-8666-555555555555.jsonl');
    fs.writeFileSync(productionFile, '{"production":true}', 'utf8');
    const experimentProjects = path.join(root, '.workbuddy', 'projects', 'd-Code-principles');
    fs.mkdirSync(experimentProjects, { recursive: true });
    process.env.PD_EXPERIMENT_ROOT = root;

    // Windows unprivileged contexts cannot create file symlinks (EPERM); the
    // containment logic itself is platform-independent and stays covered by the
    // non-symlink containment test plus scenario 2's junction escape here.
    try {
      fs.symlinkSync(productionFile, path.join(experimentProjects, '99999999-8888-4777-8666-555555555555.jsonl'), 'file');
    } catch {
      ctx.skip();
    }

    const projectsRoot = path.join(root, '.workbuddy', 'projects');
    const validation = validateWorkbuddyTranscriptPath(
      path.join(experimentProjects, '99999999-8888-4777-8666-555555555555.jsonl'),
      projectsRoot,
    );

    // The canonical transcript path lands in the production tree, outside the
    // canonical projects root — the existing containment check refuses it.
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.reason).toBe('transcript_path_outside_projects_root');
  });

  it('scenario 4: a multi-hop link chain into production is refused', () => {
    const root = tempDir('chain-root');
    const productionProjects = tempDir('production-projects-chain');
    const experimentWorkbuddy = path.join(root, '.workbuddy');
    fs.mkdirSync(experimentWorkbuddy, { recursive: true });
    const mid = path.join(root, 'mid-link');
    linkDir(productionProjects, mid);
    linkDir(mid, path.join(experimentWorkbuddy, 'projects'));
    process.env.PD_EXPERIMENT_ROOT = root;

    const result = resolveWorkbuddyProjectsRoot();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('workbuddy_projects_root_escapes_experiment');
  });

  it('scenario 5: a missing projects root stays resolvable (lazy creation contract)', () => {
    const root = tempDir('lazy-root');
    fs.mkdirSync(path.join(root, '.workbuddy'), { recursive: true });
    process.env.PD_EXPERIMENT_ROOT = root;

    const result = resolveWorkbuddyProjectsRoot();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.root).toBe(path.join(root, '.workbuddy', 'projects'));
  });

  it('scenario 6: an unresolvable projects entry (dangling junction) is refused, not trusted', () => {
    const root = tempDir('dangling-root');
    const experimentWorkbuddy = path.join(root, '.workbuddy');
    fs.mkdirSync(experimentWorkbuddy, { recursive: true });
    // Dangling junction (no target): realpath fails, but the entry EXISTS, so
    // "cannot safely verify" must refuse instead of treating it as absent.
    fs.symlinkSync(path.join(root, 'target-never-created'), path.join(experimentWorkbuddy, 'projects'), 'junction');
    process.env.PD_EXPERIMENT_ROOT = root;

    const result = resolveWorkbuddyProjectsRoot();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('workbuddy_projects_root_unverifiable');
  });

  it('production mode without PD_EXPERIMENT_ROOT keeps the historical behavior', () => {
    delete process.env.PD_EXPERIMENT_ROOT;
    const home = tempDir('prod-home');
    process.env.HOME = home;
    delete process.env.WORKBUDDY_CONFIG_DIR;

    const result = resolveWorkbuddyProjectsRoot();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.root).toBe(path.join(home, '.workbuddy', 'projects'));
  });
});
