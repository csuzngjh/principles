import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

describe('core template guidance', () => {
  it('documents sessions_spawn for dispatched internal workers', () => {
    const enAgents = fs.readFileSync(path.join(repoRoot, 'templates', 'langs', 'en', 'core', 'AGENTS.md'), 'utf8');
    const enTools = fs.readFileSync(path.join(repoRoot, 'templates', 'langs', 'en', 'core', 'TOOLS.md'), 'utf8');

    expect(enAgents).toContain('sessions_spawn');
    expect(enTools).toContain('sessions_spawn');
    expect(enAgents).toContain('pd-diagnostician');
    expect(enAgents).toContain('Tool Routing Addendum');
    expect(enTools).toContain('Agent Routing Clarification');
  });
});
