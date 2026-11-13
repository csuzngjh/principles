/**
 * Experiment install layout (P0, 2026-11-13 real-host E2E remediation).
 *
 * WHY this exists: the experiment console used to run from the repository
 * source through `tsx`, so the canonical install layout (`<home>/.pd/runtime`,
 * `<home>/.pd/install.json`) never existed under the experiment root. Console
 * components that resolve the pd-cli through @principles/install-layout then
 * reported `pd_cli_entry_missing` (or silently used the repo graph), which makes
 * the experiment environment structurally different from a real installation.
 *
 * This module materializes the SAME canonical layout under the experiment root
 * from the repository's built artifacts:
 *
 *   <root>/.pd/install.json                     {layoutVersion:1, mode:'canonical', ...}
 *   <root>/.pd/runtime/pd-cli/dist/index.js     -> pd_cli_entry_missing root cause
 *   <root>/.pd/runtime/console/dist/server.js
 *   <root>/.pd/runtime/{core,host-runtime,install-layout,pd-mcp-server}/...
 *
 * Only PD-owned artifacts are COPIED (dist + package.json + the package's own
 * node_modules). The shared hoisted dependency store is linked at
 * `<runtime>/node_modules` because this is a developer experiment: it is a
 * dependency cache, never governance state, and the link target is verified to
 * be the requesting repository (not a production install).
 *
 * Every consumer resolves paths through @principles/install-layout; nothing here
 * hardcodes a CLI path past that layout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { realWorkspacePath } from './experiment-workspace-isolation.mjs';

/** Component directory name -> repository package directory. */
export const EXPERIMENT_RUNTIME_COMPONENTS = Object.freeze([
  ['pd-cli', 'packages/pd-cli'],
  ['console', 'packages/pd-console'],
  ['core', 'packages/principles-core'],
  ['host-runtime', 'packages/host-runtime'],
  ['install-layout', 'packages/install-layout'],
  ['pd-mcp-server', 'packages/pd-mcp-server'],
]);

function refusal(reason, message, nextAction, details = {}) {
  return { ok: false, reason, message, nextAction, details };
}

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Remove only a directory this module owns: a reparse point is detached with
 * `unlink` and never traversed (ERR-098), a plain directory is removed
 * recursively. Callers must have proven the path is inside the experiment root.
 */
function removeOwnedDirectory(target) {
  if (!exists(target)) return;
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  if (!stats.isDirectory()) throw new Error(`refusing to remove non-directory ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}

function copyIfPresent(source, destination) {
  if (!exists(source)) return;
  fs.cpSync(source, destination, { recursive: true, dereference: false, force: true });
}

/**
 * Create the canonical experiment layout. Re-running is idempotent: PD-owned
 * component directories are rebuilt from the current build outputs.
 */
export function materializeExperimentInstallLayout({ repoRoot, experimentRoot, workspace }) {
  const root = realWorkspacePath(experimentRoot);
  const runtimeDir = path.join(root, '.pd', 'runtime');

  if (!isDirectory(repoRoot)) {
    return refusal('experiment_repo_root_missing', `Repository root is not a directory: ${repoRoot}`, 'Run the launcher from a built checkout.');
  }
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
    return refusal('experiment_workspace_invalid', `Experiment workspace is not absolute: ${String(workspace)}`, 'Pass --workspace inside the experiment root.');
  }
  if (!isDirectory(workspace)) {
    return refusal('experiment_workspace_missing', `Experiment workspace does not exist: ${workspace}`, 'Create the workspace directory first.');
  }

  for (const [component, packageDir] of EXPERIMENT_RUNTIME_COMPONENTS) {
    const source = path.join(repoRoot, packageDir);
    const dist = path.join(source, 'dist');
    const manifest = path.join(source, 'package.json');
    if (!isDirectory(source) || !isDirectory(dist) || !exists(manifest)) {
      return refusal(
        'experiment_component_not_built',
        `Runtime component "${component}" is not built: ${dist} or ${manifest} is missing.`,
        'Run `npm run build` at the repository root, then restart the experiment launcher.',
        { component, source },
      );
    }
  }

  fs.mkdirSync(runtimeDir, { recursive: true });

  for (const [component, packageDir] of EXPERIMENT_RUNTIME_COMPONENTS) {
    const source = path.join(repoRoot, packageDir);
    const target = path.join(runtimeDir, component);
    removeOwnedDirectory(target);
    fs.mkdirSync(target, { recursive: true });
    copyIfPresent(path.join(source, 'dist'), path.join(target, 'dist'));
    copyIfPresent(path.join(source, 'package.json'), path.join(target, 'package.json'));
    copyIfPresent(path.join(source, 'node_modules'), path.join(target, 'node_modules'));
    copyIfPresent(path.join(source, 'README.md'), path.join(target, 'README.md'));
    copyIfPresent(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));
  }

  // Dependency resolution only: the hoisted workspace dependency store. The
  // experiment must not install its own copy of the monorepo in this phase.
  const dependencyStore = path.join(runtimeDir, 'node_modules');
  const repoNodeModules = realWorkspacePath(path.join(repoRoot, 'node_modules'));
  if (!isDirectory(repoNodeModules)) {
    return refusal('experiment_dependency_store_missing', `Repository node_modules is missing: ${repoNodeModules}`, 'Run `npm install` at the repository root, then retry.');
  }
  removeOwnedDirectory(dependencyStore);
  fs.symlinkSync(repoNodeModules, dependencyStore, process.platform === 'win32' ? 'junction' : 'dir');

  const manifestPath = path.join(root, '.pd', 'install.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        layoutVersion: 1,
        mode: 'canonical',
        hosts: ['openclaw'],
        workspaces: [realWorkspacePath(workspace)],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  return verifyExperimentInstallLayout({ experimentRoot: root, workspace });
}

/**
 * Verify the layout a consumer would actually resolve: the manifest shape, every
 * canonical entry, and containment of every entry inside the experiment root.
 * A missing pd-cli entry is reported as `experiment_pd_cli_entry_missing` — the
 * same root cause the console used to report as `pd_cli_entry_missing`.
 */
export function verifyExperimentInstallLayout({ experimentRoot, workspace }) {
  const root = realWorkspacePath(experimentRoot);
  const pdDir = path.join(root, '.pd');
  const runtimeDir = path.join(pdDir, 'runtime');
  const manifestPath = path.join(pdDir, 'install.json');

  if (!isDirectory(runtimeDir)) {
    return refusal('experiment_runtime_missing', `Experiment runtime directory is missing: ${runtimeDir}`, 'Run `npm run build` and restart the launcher.');
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return refusal(
      'experiment_install_manifest_missing',
      `Experiment install manifest is missing or unreadable: ${manifestPath} (${error instanceof Error ? error.message : String(error)}).`,
      'Restart the experiment launcher so it materializes .pd/install.json.',
    );
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return refusal('experiment_install_manifest_invalid', `Experiment install manifest is not an object: ${manifestPath}`, 'Restart the experiment launcher to regenerate the manifest.');
  }
  if (manifest.layoutVersion !== 1 || manifest.mode !== 'canonical') {
    return refusal('experiment_install_manifest_invalid', `Experiment install manifest must be {layoutVersion:1, mode:"canonical"}; got ${JSON.stringify({ layoutVersion: manifest.layoutVersion, mode: manifest.mode })}.`, 'Restart the experiment launcher to regenerate the manifest.');
  }
  if (!Array.isArray(manifest.hosts) || !manifest.hosts.includes('openclaw')) {
    return refusal('experiment_install_manifest_invalid', 'Experiment install manifest must register the openclaw host.', 'Restart the experiment launcher to regenerate the manifest.');
  }
  if (!Array.isArray(manifest.workspaces) || !manifest.workspaces.includes(realWorkspacePath(workspace))) {
    return refusal('experiment_install_manifest_workspace_mismatch', `Experiment install manifest does not record the experiment workspace ${workspace}.`, 'Restart the experiment launcher so the manifest matches --workspace.');
  }

  const entries = [
    ['pd-cli', path.join(runtimeDir, 'pd-cli', 'dist', 'index.js'), 'experiment_pd_cli_entry_missing'],
    ['console', path.join(runtimeDir, 'console', 'dist', 'server.js'), 'experiment_console_entry_missing'],
    ['core', path.join(runtimeDir, 'core', 'dist', 'index.js'), 'experiment_core_entry_missing'],
    ['host-runtime', path.join(runtimeDir, 'host-runtime', 'dist', 'index.js'), 'experiment_host_runtime_entry_missing'],
    ['install-layout', path.join(runtimeDir, 'install-layout', 'dist', 'index.js'), 'experiment_install_layout_entry_missing'],
    ['pd-mcp-server', path.join(runtimeDir, 'pd-mcp-server', 'dist', 'index.js'), 'experiment_mcp_server_entry_missing'],
  ];
  for (const [component, entry, reason] of entries) {
    if (!exists(entry)) {
      return refusal(reason, `Experiment runtime component "${component}" entry is missing: ${entry}`, 'Run `npm run build` at the repository root, then restart the experiment launcher.', { component, entry });
    }
    const real = realWorkspacePath(entry);
    const relative = path.relative(root, real);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      return refusal('experiment_runtime_entry_outside_root', `Experiment runtime entry resolves outside the root: ${entry} -> ${real}`, 'Remove the junction/symlink and restart the launcher; the runtime must live under the experiment root.', { component, entry, resolved: real });
    }
  }

  if (!isDirectory(path.join(runtimeDir, 'node_modules'))) {
    return refusal('experiment_dependency_store_missing', `Experiment runtime dependency store is missing: ${path.join(runtimeDir, 'node_modules')}`, 'Restart the experiment launcher so it links the repository dependency store.');
  }

  return { ok: true, manifestPath, runtimeDir, entries: entries.map(([component, entry]) => ({ component, entry })) };
}

/** Resolve the console server entry a launcher must execute (layout authority). */
export function experimentConsoleEntry(experimentRoot) {
  return path.join(realWorkspacePath(experimentRoot), '.pd', 'runtime', 'console', 'dist', 'server.js');
}
