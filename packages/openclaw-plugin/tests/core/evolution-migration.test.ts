import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyEvolutionData } from '../../src/core/evolution-migration.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evolution-migration-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('migrateLegacyEvolutionData', () => {
  it('imports legacy files into evolution stream as legacy_import events', () => {
    const workspace = makeTempDir();
    fs.mkdirSync(path.join(workspace, '.principles'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'memory', 'ISSUE_LOG.md'), 'Issue A\nIssue B\n');
    fs.writeFileSync(path.join(workspace, '.principles', 'PRINCIPLES.md'), '# P\nRule A\n');

    const result = migrateLegacyEvolutionData(workspace);

    expect(result.importedEvents).toBe(2);
    const streamPath = path.join(workspace, 'memory', 'evolution.jsonl');
    const events = fs.readFileSync(streamPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events.every(event => event.type === 'legacy_import')).toBe(true);
  });

  it('is idempotent when migration runs multiple times', () => {
    const workspace = makeTempDir();
    fs.mkdirSync(path.join(workspace, '.principles'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'memory', 'ISSUE_LOG.md'), 'Issue A\n');

    const first = migrateLegacyEvolutionData(workspace);
    const second = migrateLegacyEvolutionData(workspace);

    expect(first.importedEvents).toBe(1);
    expect(second.importedEvents).toBe(0);
  });
});
