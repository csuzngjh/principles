import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils/io.js';
import { createDefaultKeywordStore } from '@principles/core/prompt-builder';
import type { EmpathyKeywordStore } from '@principles/core/prompt-builder';

export {
  matchEmpathyKeywords,
  createDefaultKeywordStore,
  applyKeywordUpdates,
  shouldTriggerOptimization,
  getKeywordStoreSummary,
} from '@principles/core/prompt-builder';

export type {
  EmpathyKeywordStore,
  EmpathyKeywordEntry,
  EmpathyKeywordStats,
  EmpathyMatchResult,
  EmpathyKeywordConfig,
} from '@principles/core/prompt-builder';

const KEYWORD_STORE_FILE = 'empathy_keywords.json';

export function loadKeywordStore(stateDir: string, language?: 'zh' | 'en'): EmpathyKeywordStore {
  const filePath = path.join(stateDir, KEYWORD_STORE_FILE);

  try {
    if (!fs.existsSync(filePath)) {
      const store = createDefaultKeywordStore(language);
      saveKeywordStore(stateDir, store);
      return store;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    if (!parsed.terms || !parsed.stats || !parsed.version) {
      console.warn('[PD:Empathy] Invalid keyword store format, creating default');
      const store = createDefaultKeywordStore(language);
      saveKeywordStore(stateDir, store);
      return store;
    }

    // Merge missing seed terms into existing store (PRI-274)
    const store = parsed as EmpathyKeywordStore;
    const defaultStore = createDefaultKeywordStore(language);
    let addedCount = 0;
    for (const [term, entry] of Object.entries(defaultStore.terms)) {
      if (!store.terms[term]) {
        store.terms[term] = { ...entry };
        addedCount++;
      }
    }
    if (addedCount > 0) {
      console.warn(`[PD:Empathy] Merged ${addedCount} new seed terms into existing store`);
      saveKeywordStore(stateDir, store);
    }

    return store;
  } catch (e) {
    console.warn(`[PD:Empathy] Failed to load keyword store: ${e}`);
    const store = createDefaultKeywordStore(language);
    saveKeywordStore(stateDir, store);
    return store;
  }
}

export function saveKeywordStore(stateDir: string, store: EmpathyKeywordStore): void {
  const filePath = path.join(stateDir, KEYWORD_STORE_FILE);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  store.lastUpdated = new Date().toISOString();
  atomicWriteFileSync(filePath, JSON.stringify(store, null, 2));
}
