import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkWorkspace,
  GENERATED_HEADER,
  loadHosts,
  loadSkillSources,
  renderWorkspace,
  SkillRenderError,
  writeWorkspace,
} from '../src/index.js';

const packageRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(packageRoot, '..', '..');

const sandboxes: string[] = [];

function makeSandbox(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'pd-skills-'));
  sandboxes.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
  return join(root, 'packages', 'pd-skills');
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const root = sandboxes.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('pd-skills renderer', () => {
  it('renders every declared destination for every source skill', () => {
    const hosts = loadHosts(packageRoot);
    const skills = loadSkillSources(packageRoot);
    const files = renderWorkspace(packageRoot);

    const expected = hosts.reduce(
      (total, host) => total + Object.keys(host.destinations).length * skills.length,
      0,
    );
    expect(files).toHaveLength(expected);

    const destinations = new Set(hosts.flatMap((host) => Object.values(host.destinations)));
    expect(destinations.size).toBeGreaterThan(1);
    for (const file of files) {
      expect(file.content.startsWith('---\n')).toBe(true);
      expect(file.content).toContain(GENERATED_HEADER);
    }
  });

  it('keeps the committed artifacts byte-identical to the single source', () => {
    expect(checkWorkspace(packageRoot)).toEqual([]);
  });

  it('renders the same skill set for every host', () => {
    const files = renderWorkspace(packageRoot);
    const byDestination = new Map<string, Set<string>>();
    for (const file of files) {
      const destination = file.relativePath.slice(0, -(file.skill.length + '/SKILL.md'.length));
      const set = byDestination.get(destination) ?? new Set<string>();
      set.add(file.skill);
      byDestination.set(destination, set);
    }
    const sets = [...byDestination.values()].map((set) => [...set].sort());
    const first = sets[0];
    expect(first).toBeDefined();
    for (const set of sets) expect(set).toEqual(first);
  });

  it('renders an unsupported capability as an explicit declaration, never as silence', () => {
    const files = renderWorkspace(packageRoot);
    const declared = files.filter((file) => /本宿主不支持：|This host does not support: /.test(file.content));
    expect(declared.length).toBeGreaterThan(0);
    for (const file of declared) {
      expect(file.content).toMatch(/本宿主不支持：\S|This host does not support: \S/);
      expect(file.content).toMatch(/应改走：\S|Use instead: \S/);
    }
  });

  it('fails closed when a capability is neither provided nor declared unsupported', () => {
    const root = makeSandbox({
      'packages/pd-skills/skills/demo/zh.md': [
        '---',
        'name: demo',
        'description: demo',
        '---',
        '',
        '{{capability demo.missing}}',
        '',
      ].join('\n'),
      'packages/pd-skills/hosts/demo-host.json': JSON.stringify({
        id: 'demo-host',
        displayName: 'Demo',
        destinations: { zh: 'out/skills' },
        capabilities: { zh: {} },
        unsupported: { zh: [] },
      }),
    });

    let error: unknown;
    try {
      renderWorkspace(root);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SkillRenderError);
    expect((error as SkillRenderError).problems.join('\n')).toContain('demo.missing');
  });

  it('reports stale skill directories so retirement cannot leave a partial copy', () => {
    const files = ['---', 'name: demo', 'description: demo', '---', '', 'body', ''].join('\n');
    const root = makeSandbox({
      'packages/pd-skills/skills/demo/zh.md': files,
      'packages/pd-skills/hosts/demo-host.json': JSON.stringify({
        id: 'demo-host',
        displayName: 'Demo',
        destinations: { zh: 'out/skills' },
        capabilities: { zh: {} },
        unsupported: { zh: [] },
      }),
      'out/skills/gone/SKILL.md': 'stale\n',
    });

    const problems = checkWorkspace(root);
    expect(problems.join('\n')).toContain('out/skills/gone');
  });

  it('writes artifacts that then pass the check', () => {
    const source = ['---', 'name: demo', 'description: demo', '---', '', 'body', ''].join('\n');
    const root = makeSandbox({
      'packages/pd-skills/skills/demo/zh.md': source,
      'packages/pd-skills/hosts/demo-host.json': JSON.stringify({
        id: 'demo-host',
        displayName: 'Demo',
        destinations: { zh: 'out/skills' },
        capabilities: { zh: {} },
        unsupported: { zh: [] },
      }),
    });

    expect(checkWorkspace(root).join('\n')).toContain('out/skills/demo/SKILL.md: missing');
    writeWorkspace(root);
    expect(checkWorkspace(root)).toEqual([]);
    expect(readFileSync(join(root, '..', '..', 'out/skills/demo/SKILL.md'), 'utf-8')).toContain('body');
  });
});
