import * as fs from 'fs';
import * as path from 'path';
import type { EvolutionLoopEvent } from './evolution-types.js';
import { stableContentHash } from './evolution-reducer.js';

export interface MigrationResult {
  importedEvents: number;
  streamPath: string;
}

function appendEvent(streamPath: string, event: EvolutionLoopEvent): void {
  fs.appendFileSync(streamPath, `${JSON.stringify(event)}\n`, 'utf8');
}

function loadImportedHashes(streamPath: string): Set<string> {
  if (!fs.existsSync(streamPath)) return new Set();
  const raw = fs.readFileSync(streamPath, 'utf8').trim();
  if (!raw) return new Set();

  const hashes = new Set<string>();
  for (const line of raw.split('\n')) {
    try {
      const event = JSON.parse(line) as EvolutionLoopEvent;
      if (event.type !== 'legacy_import') continue;
      const hash = event.data.contentHash;
      if (typeof hash === 'string') hashes.add(hash);
    } catch (e) {
      console.warn(`[PD:Migration] skip malformed line: ${String(e)}`);
    }
  }
  return hashes;
}

export function migrateLegacyEvolutionData(workspaceDir: string): MigrationResult {
  const streamPath = path.join(workspaceDir, 'memory', 'evolution.jsonl');
  fs.mkdirSync(path.dirname(streamPath), { recursive: true });

  const candidates: string[] = [
    path.join(workspaceDir, 'memory', 'ISSUE_LOG.md'),
    path.join(workspaceDir, 'memory', 'DECISIONS.md'),
    path.join(workspaceDir, '.principles', 'PRINCIPLES.md'),
  ];

  const existingHashes = loadImportedHashes(streamPath);
  let importedEvents = 0;

  for (const sourceFile of candidates) {
    if (!fs.existsSync(sourceFile)) {
      continue;
    }

    const content = fs.readFileSync(sourceFile, 'utf8').trim();
    if (!content) {
      continue;
    }

    const contentHash = stableContentHash(`${sourceFile}:${content}`);
    if (existingHashes.has(contentHash)) {
      continue;
    }

    appendEvent(streamPath, {
      ts: new Date().toISOString(),
      type: 'legacy_import',
      data: {
        sourceFile: path.relative(workspaceDir, sourceFile),
        content,
        contentHash,
      },
    });
    importedEvents += 1;
    existingHashes.add(contentHash);
  }

  return { importedEvents, streamPath };
}
