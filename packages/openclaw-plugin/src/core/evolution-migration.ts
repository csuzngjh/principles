import * as fs from 'fs';
import * as path from 'path';
import type { EvolutionLoopEvent } from './evolution-types.js';

export interface MigrationResult {
  importedEvents: number;
  streamPath: string;
}

function appendEvent(streamPath: string, event: EvolutionLoopEvent): void {
  fs.appendFileSync(streamPath, `${JSON.stringify(event)}\n`, 'utf8');
}

export function migrateLegacyEvolutionData(workspaceDir: string): MigrationResult {
  const streamPath = path.join(workspaceDir, 'memory', 'evolution.jsonl');
  fs.mkdirSync(path.dirname(streamPath), { recursive: true });

  const candidates: string[] = [
    path.join(workspaceDir, 'memory', 'ISSUE_LOG.md'),
    path.join(workspaceDir, 'memory', 'DECISIONS.md'),
    path.join(workspaceDir, '.principles', 'PRINCIPLES.md'),
  ];

  let importedEvents = 0;

  for (const sourceFile of candidates) {
    if (!fs.existsSync(sourceFile)) {
      continue;
    }

    const content = fs.readFileSync(sourceFile, 'utf8').trim();
    if (!content) {
      continue;
    }

    appendEvent(streamPath, {
      ts: new Date().toISOString(),
      type: 'legacy_import',
      data: {
        sourceFile: path.relative(workspaceDir, sourceFile),
        content,
      },
    });
    importedEvents += 1;
  }

  return { importedEvents, streamPath };
}
