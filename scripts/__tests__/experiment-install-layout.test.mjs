import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EXPERIMENT_RUNTIME_COMPONENTS,
  experimentConsoleEntry,
  materializeExperimentInstallLayout,
  verifyExperimentInstallLayout,
} from '../dev/experiment-install-layout.mjs';
import { LAB_ENTRY_MODULES } from '../build/lab-payload.mjs';

function tempDir(label) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `pd-experiment-layout-${label}-`)));
}

/**
 * Fabricate the repository shape the materializer consumes: every component
 * package has dist/ + package.json, plus a shared hoisted dependency store.
 */
function makeFakeRepo() {
  const repo = tempDir('repo');
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  for (const [component, packageDir] of EXPERIMENT_RUNTIME_COMPONENTS) {
    const dir = path.join(repo, packageDir);
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@principles/${component}`, version: '1.0.0' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'export {};\n', 'utf8');
  }
  fs.mkdirSync(path.join(repo, 'packages', 'pd-console', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages', 'pd-console', 'dist', 'server.js'), 'export {};\n', 'utf8');
  // The Examiner lab is a repository directory, not a package.
  for (const rel of LAB_ENTRY_MODULES) {
    const file = path.join(repo, 'scripts', 'dev', 'principle-learning-lab', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export {};\n', 'utf8');
  }
  return repo;
}

function makeExperimentRoot() {
  const root = tempDir('root');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  return { root, workspace };
}

test('materializes a verifiable canonical layout with a pd-cli entry', () => {
  const repo = makeFakeRepo();
  const { root, workspace } = makeExperimentRoot();

  const result = materializeExperimentInstallLayout({ repoRoot: repo, experimentRoot: root, workspace });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(fs.existsSync(path.join(root, '.pd', 'install.json'))).toBe(true);
  expect(fs.existsSync(path.join(root, '.pd', 'runtime', 'pd-cli', 'dist', 'index.js'))).toBe(true);
  expect(fs.existsSync(path.join(root, '.pd', 'runtime', 'console', 'dist', 'server.js'))).toBe(true);
  expect(experimentConsoleEntry(root)).toBe(path.join(root, '.pd', 'runtime', 'console', 'dist', 'server.js'));

  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.pd', 'install.json'), 'utf8'));
  expect(manifest).toMatchObject({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'], workspaces: [workspace] });

  const verified = verifyExperimentInstallLayout({ experimentRoot: root, workspace });
  expect(verified.ok, JSON.stringify(verified)).toBe(true);
});

test('ships the Examiner lab payload a real installation carries', () => {
  const repo = makeFakeRepo();
  const { root, workspace } = makeExperimentRoot();
  expect(materializeExperimentInstallLayout({ repoRoot: repo, experimentRoot: root, workspace }).ok).toBe(true);

  const labEntry = path.join(root, '.pd', 'runtime', 'console', 'lab', 'lib', 'examiner-study.mjs');
  expect(fs.existsSync(labEntry)).toBe(true);

  // The regression that produced `503 examiner_lab_unavailable`: a layout
  // without the lab must be reported as such, never silently accepted.
  fs.rmSync(path.join(root, '.pd', 'runtime', 'console', 'lab'), { recursive: true, force: true });
  const verified = verifyExperimentInstallLayout({ experimentRoot: root, workspace });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toBe('experiment_examiner_lab_payload_missing');
});

test('reports the real pd-cli root cause instead of a generic failure', () => {
  const repo = makeFakeRepo();
  const { root, workspace } = makeExperimentRoot();
  expect(materializeExperimentInstallLayout({ repoRoot: repo, experimentRoot: root, workspace }).ok).toBe(true);

  fs.rmSync(path.join(root, '.pd', 'runtime', 'pd-cli', 'dist', 'index.js'));
  const verified = verifyExperimentInstallLayout({ experimentRoot: root, workspace });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toBe('experiment_pd_cli_entry_missing');
  expect(verified.nextAction).toMatch(/npm run build/);
});

test('refuses an unbuilt component instead of writing a partial layout', () => {
  const repo = makeFakeRepo();
  const { root, workspace } = makeExperimentRoot();
  fs.rmSync(path.join(repo, 'packages', 'pd-cli', 'dist'), { recursive: true, force: true });

  const result = materializeExperimentInstallLayout({ repoRoot: repo, experimentRoot: root, workspace });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('experiment_component_not_built');
  expect(fs.existsSync(path.join(root, '.pd', 'install.json'))).toBe(false);
});

test('refuses a manifest that does not record the experiment workspace', () => {
  const repo = makeFakeRepo();
  const { root, workspace } = makeExperimentRoot();
  expect(materializeExperimentInstallLayout({ repoRoot: repo, experimentRoot: root, workspace }).ok).toBe(true);

  fs.writeFileSync(
    path.join(root, '.pd', 'install.json'),
    JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'], workspaces: ['D:\\production\\workspace'] }),
    'utf8',
  );
  const verified = verifyExperimentInstallLayout({ experimentRoot: root, workspace });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toBe('experiment_install_manifest_workspace_mismatch');
});

test('refuses a runtime entry that resolves outside the experiment root', () => {
  const repo = makeFakeRepo();
  const { root, workspace } = makeExperimentRoot();
  expect(materializeExperimentInstallLayout({ repoRoot: repo, experimentRoot: root, workspace }).ok).toBe(true);

  const outside = tempDir('outside');
  fs.writeFileSync(path.join(outside, 'index.js'), 'export {};\n', 'utf8');
  const dist = path.join(root, '.pd', 'runtime', 'pd-cli', 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  try {
    fs.symlinkSync(outside, dist, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    throw new Error(`test environment cannot create a ${process.platform === 'win32' ? 'junction' : 'symlink'}: ${String(error)}`);
  }

  const verified = verifyExperimentInstallLayout({ experimentRoot: root, workspace });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toBe('experiment_runtime_entry_outside_root');
});
