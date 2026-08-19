import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

describe('core template guidance (Round 3)', () => {
  it('AGENTS.md documents PD boundary and does not ship generic orchestration', () => {
    const enAgents = fs.readFileSync(path.join(repoRoot, 'templates', 'langs', 'en', 'core', 'AGENTS.md'), 'utf8');
    const zhAgents = fs.readFileSync(path.join(repoRoot, 'templates', 'langs', 'zh', 'core', 'AGENTS.md'), 'utf8');

    // PD boundary must be stated explicitly.
    expect(enAgents).toContain('does not own');
    expect(zhAgents).toContain('不拥有');

    // Generic orchestration / peer-session routing is a host/OpenClaw concern,
    // not PD's — removed in Round 3 (PRI-547).
    expect(enAgents).not.toContain('sessions_spawn');
    expect(enAgents).not.toContain('pd-explorer');
    expect(enAgents).not.toContain('Tool Routing Addendum');
  });

  it('TOOLS.md only documents PD-specific commands', () => {
    const enTools = fs.readFileSync(path.join(repoRoot, 'templates', 'langs', 'en', 'core', 'TOOLS.md'), 'utf8');
    const zhTools = fs.readFileSync(path.join(repoRoot, 'templates', 'langs', 'zh', 'core', 'TOOLS.md'), 'utf8');

    expect(enTools).toContain('pd pain record');
    expect(enTools).toContain('pd candidate list');
    expect(zhTools).toContain('pd pain record');
    expect(zhTools).toContain('pd candidate list');

    // No generic agent-routing documentation.
    expect(enTools).not.toContain('sessions_spawn');
    expect(enTools).not.toContain('Agent Routing Clarification');
    expect(zhTools).not.toContain('sessions_spawn');
  });
});
