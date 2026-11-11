import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadHosts,
  parseHostConfig,
  renderWorkspace,
  SkillRenderError,
} from '../src/index.js';

const packageRoot = resolve(import.meta.dirname, '..');
const sandboxes: string[] = [];

function makeSandbox(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'pd-skills-host-'));
  sandboxes.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
  return join(root, 'packages', 'pd-skills');
}

function capture(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof SkillRenderError) return error.problems;
    throw error;
  }
  throw new Error('expected a SkillRenderError');
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const root = sandboxes.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('host config contract', () => {
  it('every committed host declares a destination and an unsupported map for each language', () => {
    for (const host of loadHosts(packageRoot)) {
      expect(Object.keys(host.destinations).length).toBeGreaterThan(0);
      for (const lang of Object.keys(host.destinations)) {
        expect(Object.hasOwn(host.unsupported, lang)).toBe(true);
        expect(Object.hasOwn(host.capabilities, lang)).toBe(true);
      }
    }
  });

  it('structurally cannot skip a skill: an unknown field such as "skills" is rejected', () => {
    const problems = capture(() =>
      parseHostConfig(
        {
          id: 'demo-host',
          displayName: 'Demo',
          destinations: { zh: 'out/skills' },
          capabilities: { zh: {} },
          unsupported: { zh: [] },
          skills: ['pd-control'],
        },
        'demo-host.json',
      ),
    );
    expect(problems.join('\n')).toContain('unknown field "skills"');
  });

  it('rejects a capability that is both provided and declared unsupported', () => {
    const problems = capture(() =>
      parseHostConfig(
        {
          id: 'demo-host',
          displayName: 'Demo',
          destinations: { zh: 'out/skills' },
          capabilities: { zh: { 'demo.cap': 'yes' } },
          unsupported: {
            zh: [{ capability: 'demo.cap', reason: 'no', alternative: 'elsewhere' }],
          },
        },
        'demo-host.json',
      ),
    );
    expect(problems.join('\n')).toContain('both provided and declared unsupported');
  });

  it('rejects an unsupported declaration for a language with no destination', () => {
    const problems = capture(() =>
      parseHostConfig(
        {
          id: 'demo-host',
          displayName: 'Demo',
          destinations: { zh: 'out/skills' },
          capabilities: { zh: {}, en: {} },
          unsupported: {
            zh: [],
            en: [{ capability: 'demo.cap', reason: 'no', alternative: 'elsewhere' }],
          },
        },
        'demo-host.json',
      ),
    );
    expect(problems.join('\n')).toContain('no destination declared for this language');
  });

  it('cannot render an undeclared capability in an unregistered language', () => {
    const root = makeSandbox({
      'packages/pd-skills/skills/demo/fr.md': [
        '---',
        'name: demo',
        'description: demo',
        '---',
        '',
        '{{capability demo.cap}}',
        '',
      ].join('\n'),
      'packages/pd-skills/hosts/demo-host.json': JSON.stringify({
        id: 'demo-host',
        displayName: 'Demo',
        destinations: { fr: 'out/skills' },
        capabilities: { fr: {} },
        unsupported: {
          fr: [{ capability: 'demo.cap', reason: 'absent', alternative: 'do it by hand' }],
        },
      }),
    });
    const problems = capture(() => renderWorkspace(root));
    expect(problems.join('\n')).toContain('no declaration wording registered for this language');
  });
});
