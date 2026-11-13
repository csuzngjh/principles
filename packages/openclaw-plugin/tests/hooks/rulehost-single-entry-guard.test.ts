/**
 * PRI-1208 Stage 1 — one production RuleHost entry.
 *
 * The shared host runtime (`createProductionHostRuntime` →
 * `createProductionRuleHostGate`) is the ONLY production verdict producer for
 * OpenClaw. The legacy `handleBeforeToolCall` and the plugin-local `RuleHost`
 * class remain only as test oracles until Stage 4 deletes them.
 *
 * This guard protects the invariant (one decision entry), not the file layout:
 * it asserts the production registration path and the absence of a second
 * consumer. It stays valid after the Stage 4 deletion.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

interface SourceFile {
  relative: string;
  content: string;
}

function readAllSources(dir: string = SRC_DIR): SourceFile[] {
  const entries: SourceFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...readAllSources(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      entries.push({
        relative: path.relative(SRC_DIR, absolute).replace(/\\/g, '/'),
        content: fs.readFileSync(absolute, 'utf8'),
      });
    }
  }
  return entries;
}

describe('RuleHost single production entry (PRI-1208 stage 1)', () => {
  it('registers before_tool_call through the shared runtime dispatch only', () => {
    const index = fs.readFileSync(path.join(SRC_DIR, 'index.ts'), 'utf8');
    expect(index).toContain('sharedHostRuntime.dispatchBeforeToolCall');
    expect(index).not.toMatch(/handleBeforeToolCall\s*\(/);
    expect(index).not.toMatch(/getRuleHost\s*\(/);
  });

  it('has no production caller of the retired legacy hook', () => {
    const offenders = readAllSources()
      .filter((file) => file.relative !== 'hooks/gate.ts')
      .filter((file) => /handleBeforeToolCall\s*\(/.test(file.content))
      .map((file) => file.relative);
    expect(offenders).toEqual([]);
  });

  it('has no production consumer of WorkspaceContext#getRuleHost outside the dead gate', () => {
    const offenders = readAllSources()
      .filter((file) => file.relative !== 'core/workspace-context.ts' && file.relative !== 'hooks/gate.ts')
      .filter((file) => /getRuleHost\s*\(/.test(file.content))
      .map((file) => file.relative);
    expect(offenders).toEqual([]);
  });
});
