import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SelfContainedDependencyError,
  prepareBundledComponentDependencies,
} from '../src/installer.js';
import { toInstallJsonOutput } from '../src/index.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(() => Buffer.from('')),
  execSync: vi.fn(() => Buffer.from('')),
}));

const temporaryDirectories: string[] = [];

function createComponent(dependencies: string[]): string {
  const componentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-self-contained-'));
  temporaryDirectories.push(componentDir);
  fs.writeFileSync(path.join(componentDir, 'package.json'), JSON.stringify({
    dependencies: Object.fromEntries(dependencies.map((dependency) => [dependency, '1.0.0'])),
  }));
  for (const dependency of dependencies) {
    fs.mkdirSync(path.join(componentDir, 'node_modules', dependency), { recursive: true });
    fs.writeFileSync(path.join(componentDir, 'node_modules', dependency, 'package.json'), JSON.stringify({ name: dependency }));
  }
  return componentDir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('self-contained bundled component dependency contract', () => {
  it('validates complete runtime dependencies and better-sqlite3 without invoking npm', async () => {
    const componentDir = createComponent(['js-yaml', 'better-sqlite3']);

    await prepareBundledComponentDependencies(componentDir, 'Core');

    expect(childProcess.execSync).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      process.execPath,
      ['-e', "require('better-sqlite3')"],
      { cwd: componentDir, stdio: 'pipe' },
    );
  });

  it('fails with a stable recovery contract when a declared runtime dependency is missing', async () => {
    const componentDir = createComponent(['js-yaml', 'better-sqlite3']);
    fs.rmSync(path.join(componentDir, 'node_modules', 'js-yaml'), { recursive: true });

    const error = await prepareBundledComponentDependencies(componentDir, 'Core').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SelfContainedDependencyError);
    expect(error).toMatchObject({
      reason: 'self_contained_runtime_dependency_missing',
      nextAction: 'Install a complete platform release asset for this Node.js ABI and re-run the installer.',
      component: 'Core',
      dependency: 'js-yaml',
    });
    expect(childProcess.execSync).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it('surfaces better-sqlite3 load failure without invoking npm rebuild', async () => {
    const componentDir = createComponent(['better-sqlite3']);
    vi.mocked(childProcess.execFileSync).mockImplementationOnce(() => {
      throw new Error('wrong ABI');
    });

    const error = await prepareBundledComponentDependencies(componentDir, 'Host runtime').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SelfContainedDependencyError);
    expect(error).toMatchObject({
      reason: 'self_contained_native_module_unloadable',
      nextAction: 'Install the platform release asset matching this operating system, architecture, and Node.js ABI.',
      component: 'Host runtime',
      dependency: 'better-sqlite3',
    });
    expect(childProcess.execFileSync).toHaveBeenCalledOnce();
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });

  it('preserves structured dependency details in JSON failure output', () => {
    const output = toInstallJsonOutput({
      success: false,
      workspaceDir: '/workspace',
      configYamlPath: '/workspace/.pd/config.yaml',
      templatesCount: 0,
      components: { plugin: 'skipped', cli: 'skipped', console: 'skipped' },
      verification: { features: 'skipped', storyA: 'skipped' },
      enabledChannels: [],
      nextAction: 'Install the matching asset.',
      reason: 'self_contained_runtime_dependency_missing',
      component: 'PD CLI',
      dependency: 'commander',
    });

    expect(output).toMatchObject({
      reason: 'self_contained_runtime_dependency_missing',
      component: 'PD CLI',
      dependency: 'commander',
    });
  });
});
