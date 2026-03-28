import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleNocturnalTrainCommand } from '../../src/commands/nocturnal-train.js';
import type { PluginCommandContext } from '../../src/openclaw-sdk.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-train-test-'));
}

function rmdir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // ignore cleanup errors
  }
}

function makeCtx(workspaceDir: string, args = ''): PluginCommandContext {
  return {
    config: { workspaceDir, language: 'en' },
    args,
  } as unknown as PluginCommandContext;
}

function setupExport(workspaceDir: string, exportId = 'export-123'): void {
  const exportDir = path.join(workspaceDir, '.state', 'exports', 'orpo');
  fs.mkdirSync(exportDir, { recursive: true });
  const exportPath = path.join(exportDir, `${exportId}.jsonl`);
  fs.writeFileSync(
    exportPath,
    JSON.stringify({
      sampleFingerprint: 'sf-1',
      prompt: 'p',
      chosen: 'c',
      rejected: 'r',
      rationale: 'why',
    }) + '\n',
    'utf-8'
  );
  fs.writeFileSync(
    path.join(exportDir, `${exportId}-manifest.json`),
    JSON.stringify({
      exportId,
      datasetFingerprint: 'dataset-fp-123',
      exportPath,
      targetModelFamily: 'qwen2.5-7b-reader',
      sampleCount: 1,
      createdAt: new Date().toISOString(),
    }),
    'utf-8'
  );
}

describe('nocturnal-train command', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    setupExport(tmpDir);
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('persists durable spec files for manual create-experiment flow', () => {
    const result = handleNocturnalTrainCommand(
      makeCtx(
        tmpDir,
        'create-experiment --backend=peft-trl-orpo --family=qwen2.5-7b-reader --dataset=export-123'
      )
    );

    expect(result.text).toContain('Experiment created');

    const match = result.text.match(/Experiment ID:\s+([^\s]+)/);
    expect(match?.[1]).toBeTruthy();
    const experimentId = match![1];

    const pathLines = result.text
      .split('\n')
      .map((line) => line.trim())
      .map((line) => line.replace(/^-+\s*/, ''))
      .filter((line) => /^[A-Za-z]:\\/.test(line));

    expect(pathLines).toHaveLength(2);
    const [trainerSpecPath, workspaceSpecPath] = pathLines;

    expect(fs.existsSync(trainerSpecPath)).toBe(true);
    expect(fs.existsSync(workspaceSpecPath)).toBe(true);
    expect(result.text).toContain(trainerSpecPath);
  });
});
