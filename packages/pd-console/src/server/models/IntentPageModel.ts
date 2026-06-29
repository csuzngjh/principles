import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  INTENT_MAX_BYTES,
  getIntentFilename,
  createIntentTemplate,
  parseIntentDocSections,
  computeIntentContentHash,
  validateIntentDocSections,
  SqliteConnection,
  SqliteIntentDocVersionStore,
  type IntentDocSections,
  type IntentDocWarning,
  type IntentDocVersion,
  type IntentLang,
} from '@principles/core/runtime-v2';

export interface IntentPageResult {
  ok: boolean;
  found: boolean;
  flagEnabled: boolean;
  warnings: IntentDocWarning[];
  path?: string;
  contentHash?: string;
  lastEditedAt?: string;
  sections?: Record<string, string>;
  reason?: string;
  nextAction?: string;
}

export interface IntentInitResult {
  ok: boolean;
  created: boolean;
  path?: string;
  reason?: string;
  nextAction?: string;
}

export interface IntentSaveResult {
  ok: boolean;
  saved: boolean;
  path?: string;
  contentHash?: string;
  lastEditedAt?: string;
  warnings?: IntentDocWarning[];
  reason?: string;
  nextAction?: string;
}

export interface IntentRawContentResult {
  ok: boolean;
  content?: string;
  path?: string;
  reason?: string;
  nextAction?: string;
}

export interface IntentVersionResult {
  ok: boolean;
  versions?: IntentDocVersion[];
  reason?: string;
  nextAction?: string;
}

const INTENT_DIR = '.principles';

function stateDbExists(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, '.pd', 'state.db'));
}

/** Best-effort version record — never blocks save on failure. */
function recordVersion(args: {
  workspaceDir: string;
  lang: IntentLang;
  content: string;
  reason: string;
}): void {
  // Note: no stateDbExists short-circuit. SqliteConnection creates the .pd
  // dir and state.db file (with intent_doc_versions table via CREATE TABLE
  // IF NOT EXISTS) on first open. Short-circuiting here would silently drop
  // the first-write version history on fresh workspaces — the operator
  // would see an empty history panel after their very first save.
  try {
    const connection = new SqliteConnection({ workspaceDir: args.workspaceDir });
    try {
      const store = new SqliteIntentDocVersionStore(connection);
      store.saveVersion({ lang: args.lang, content: args.content, reason: args.reason });
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  } catch {
    // Version recording is best-effort — never block save on failure.
  }
}

export class IntentPageModel {
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getSummary(flagEnabled: boolean, lang: IntentLang): Promise<IntentPageResult> {
    if (!flagEnabled) {
      return {
        ok: false,
        found: false,
        flagEnabled: false,
        warnings: [],
        reason: 'flag_disabled',
        nextAction: `Enable the intent_engineering feature flag in .pd/config.yaml to read ${getIntentFilename(lang)}.`,
      };
    }

    const filePath = path.join(this.workspaceDir, INTENT_DIR, getIntentFilename(lang));

    try {
      if (!fs.existsSync(filePath)) {
        return {
          ok: false,
          found: false,
          flagEnabled: true,
          warnings: [],
          reason: 'not_found',
          nextAction: `Create .principles/${getIntentFilename(lang)} using "pd intent init".`,
        };
      }

      const stat = fs.statSync(filePath);
      if (stat.size > INTENT_MAX_BYTES) {
        return {
          ok: false,
          found: true,
          flagEnabled: true,
          warnings: [],
          reason: 'oversized',
          nextAction: `${getIntentFilename(lang)} exceeds ${INTENT_MAX_BYTES} bytes (${stat.size} bytes). Reduce content.`,
        };
      }

      const raw = fs.readFileSync(filePath, 'utf8');
      const sections: IntentDocSections = parseIntentDocSections(raw);
      const warnings = validateIntentDocSections(sections);
      const contentHash = computeIntentContentHash(raw);
      const sectionRecord: Record<string, string> = {};
      if (sections.why !== undefined) { sectionRecord.why = sections.why; }
      if (sections.desiredOutcome !== undefined) { sectionRecord.desiredOutcome = sections.desiredOutcome; }
      if (sections.nonNegotiables !== undefined) { sectionRecord.nonNegotiables = sections.nonNegotiables; }
      if (sections.stopEscalation !== undefined) { sectionRecord.stopEscalation = sections.stopEscalation; }
      if (sections.currentStrategicFocus !== undefined) { sectionRecord.currentStrategicFocus = sections.currentStrategicFocus; }

      return {
        ok: true,
        found: true,
        flagEnabled: true,
        warnings,
        path: filePath,
        contentHash,
        lastEditedAt: stat.mtime.toISOString(),
        sections: sectionRecord,
      };
    } catch (err) {
      console.error(`[IntentPageModel] failed to read ${getIntentFilename(lang)}:`, err);
      return {
        ok: false,
        found: false,
        flagEnabled: true,
        warnings: [],
        reason: 'read_error',
        nextAction: `Check filesystem permissions for .principles/${getIntentFilename(lang)}.`,
      };
    }
  }

  async getRawContent(flagEnabled: boolean, lang: IntentLang): Promise<IntentRawContentResult> {
    if (!flagEnabled) {
      return {
        ok: false,
        reason: 'flag_disabled',
        nextAction: 'Enable the intent_engineering feature flag first.',
      };
    }

    const filePath = path.join(this.workspaceDir, INTENT_DIR, getIntentFilename(lang));

    try {
      if (!fs.existsSync(filePath)) {
        return {
          ok: false,
          reason: 'not_found',
          nextAction: `${getIntentFilename(lang)} does not exist. Create it first using POST /api/v1/intent/init.`,
        };
      }

      const stat = fs.statSync(filePath);
      if (stat.size > INTENT_MAX_BYTES) {
        return {
          ok: false,
          reason: 'oversized',
          nextAction: `${getIntentFilename(lang)} exceeds ${INTENT_MAX_BYTES} bytes (${stat.size} bytes). Reduce content before opening the editor.`,
        };
      }

      const content = fs.readFileSync(filePath, 'utf8');
      return { ok: true, content, path: filePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[IntentPageModel] failed to read raw ${getIntentFilename(lang)}:`, err);
      return {
        ok: false,
        reason: 'read_error',
        nextAction: `Could not read ${getIntentFilename(lang)}: ${message}. Check filesystem permissions.`,
      };
    }
  }

  async createTemplate(flagEnabled: boolean, force: boolean, lang: IntentLang): Promise<IntentInitResult> {
    if (!flagEnabled) {
      return {
        ok: false,
        created: false,
        reason: 'flag_disabled',
        nextAction: 'Enable the intent_engineering feature flag first.',
      };
    }

    const dirPath = path.join(this.workspaceDir, INTENT_DIR);
    const filePath = path.join(dirPath, getIntentFilename(lang));

    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      if (fs.existsSync(filePath) && !force) {
        return {
          ok: true,
          created: false,
          path: filePath,
          reason: 'already_exists',
          nextAction: 'Use force=true to overwrite, or edit the existing file instead.',
        };
      }

      const templateContent = createIntentTemplate(lang);
      fs.writeFileSync(filePath, templateContent, 'utf8');
      recordVersion({ workspaceDir: this.workspaceDir, lang, content: templateContent, reason: 'init' });
      return {
        ok: true,
        created: true,
        path: filePath,
      };
    } catch (err) {
      console.error(`[IntentPageModel] failed to create ${getIntentFilename(lang)}:`, err);
      return {
        ok: false,
        created: false,
        reason: 'write_error',
        nextAction: 'Check filesystem permissions for .principles/ directory.',
      };
    }
  }

  async saveContent(flagEnabled: boolean, content: unknown, lang: IntentLang): Promise<IntentSaveResult> {
    if (!flagEnabled) {
      return {
        ok: false,
        saved: false,
        reason: 'flag_disabled',
        nextAction: 'Enable the intent_engineering feature flag first.',
      };
    }

    if (typeof content !== 'string') {
      return {
        ok: false,
        saved: false,
        reason: 'invalid_content',
        nextAction: 'Content must be a string.',
      };
    }

    if (content.length === 0) {
      return {
        ok: false,
        saved: false,
        reason: 'empty_content',
        nextAction: 'Content cannot be empty.',
      };
    }

    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > INTENT_MAX_BYTES) {
      return {
        ok: false,
        saved: false,
        reason: 'oversized',
        nextAction: `Content exceeds ${INTENT_MAX_BYTES} bytes (${byteLength} bytes). Reduce content.`,
      };
    }

    const dirPath = path.join(this.workspaceDir, INTENT_DIR);
    const filePath = path.join(dirPath, getIntentFilename(lang));

    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      fs.writeFileSync(filePath, content, 'utf8');

      const sections = parseIntentDocSections(content);
      const warnings = validateIntentDocSections(sections);
      const contentHash = computeIntentContentHash(content);
      const stat = fs.statSync(filePath);

      recordVersion({ workspaceDir: this.workspaceDir, lang, content, reason: 'save' });

      return {
        ok: true,
        saved: true,
        path: filePath,
        contentHash,
        lastEditedAt: stat.mtime.toISOString(),
        warnings,
      };
    } catch (err) {
      console.error(`[IntentPageModel] failed to save ${getIntentFilename(lang)}:`, err);
      return {
        ok: false,
        saved: false,
        reason: 'write_error',
        nextAction: `Check filesystem permissions for .principles/${getIntentFilename(lang)}.`,
      };
    }
  }

  async getVersions(lang: IntentLang): Promise<IntentVersionResult> {
    if (!stateDbExists(this.workspaceDir)) {
      return {
        ok: false,
        reason: 'state_db_not_found',
        nextAction: 'Run a PD command that creates state.db first (e.g. pd pain list).',
      };
    }

    try {
      const connection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
      try {
        const store = new SqliteIntentDocVersionStore(connection);
        const versions = await store.listVersions(lang);
        return { ok: true, versions };
      } finally {
        try { connection.close(); } catch { /* best-effort */ }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[IntentPageModel] failed to list versions:`, err);
      return {
        ok: false,
        reason: 'read_error',
        nextAction: `Could not read version history: ${message}`,
      };
    }
  }
}
