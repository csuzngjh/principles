import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  INTENT_MAX_BYTES,
  INTENT_DOC_TEMPLATE,
  parseIntentDocSections,
  computeIntentContentHash,
  validateIntentDocSections,
  type IntentDocSections,
  type IntentDocWarning,
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

const INTENT_FILENAME = 'INTENT.md';
const INTENT_DIR = '.principles';

export class IntentPageModel {
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getSummary(flagEnabled: boolean): Promise<IntentPageResult> {
    if (!flagEnabled) {
      return {
        ok: false,
        found: false,
        flagEnabled: false,
        warnings: [],
        reason: 'flag_disabled',
        nextAction: 'Enable the intent_engineering feature flag in .pd/config.yaml to read INTENT.md.',
      };
    }

    const filePath = path.join(this.workspaceDir, INTENT_DIR, INTENT_FILENAME);

    try {
      if (!fs.existsSync(filePath)) {
        return {
          ok: false,
          found: false,
          flagEnabled: true,
          warnings: [],
          reason: 'not_found',
          nextAction: 'Create .principles/INTENT.md using "pd intent init".',
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
          nextAction: `INTENT.md exceeds ${INTENT_MAX_BYTES} bytes (${stat.size} bytes). Reduce content.`,
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
      // Runtime Contract Rule #9: log underlying error for observability
      // while preserving the never-throws contract.
      console.error('[IntentPageModel] failed to read INTENT.md:', err);
      return {
        ok: false,
        found: false,
        flagEnabled: true,
        warnings: [],
        reason: 'read_error',
        nextAction: 'Check filesystem permissions for .principles/INTENT.md.',
      };
    }
  }

  /**
   * Read the raw content of INTENT.md for editing.
   * Returns null if the file doesn't exist or can't be read.
   */
  async getRawContent(flagEnabled: boolean): Promise<{ content: string; path: string } | null> {
    if (!flagEnabled) return null;

    const filePath = path.join(this.workspaceDir, INTENT_DIR, INTENT_FILENAME);

    try {
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, 'utf8');
      return { content, path: filePath };
    } catch (err) {
      console.error('[IntentPageModel] failed to read raw INTENT.md:', err);
      return null;
    }
  }

  /**
   * Create INTENT.md from the SPEC §7 template.
   * - Does NOT overwrite an existing file unless force=true (EP-03 idempotent).
   * - Creates .principles/ directory if it doesn't exist.
   * - Owner-owned: this is triggered by Owner clicking "Create template" in UI,
   *   NOT by Agent auto-modification (SPEC §3.9 boundary preserved).
   */
  async createTemplate(flagEnabled: boolean, force: boolean): Promise<IntentInitResult> {
    if (!flagEnabled) {
      return {
        ok: false,
        created: false,
        reason: 'flag_disabled',
        nextAction: 'Enable the intent_engineering feature flag first.',
      };
    }

    const dirPath = path.join(this.workspaceDir, INTENT_DIR);
    const filePath = path.join(dirPath, INTENT_FILENAME);

    try {
      // Create .principles/ directory if it doesn't exist
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // Don't overwrite existing file unless force=true
      if (fs.existsSync(filePath) && !force) {
        return {
          ok: true,
          created: false,
          path: filePath,
          reason: 'already_exists',
          nextAction: 'Use force=true to overwrite, or edit the existing file instead.',
        };
      }

      fs.writeFileSync(filePath, INTENT_DOC_TEMPLATE, 'utf8');
      return {
        ok: true,
        created: true,
        path: filePath,
      };
    } catch (err) {
      console.error('[IntentPageModel] failed to create INTENT.md:', err);
      return {
        ok: false,
        created: false,
        reason: 'write_error',
        nextAction: 'Check filesystem permissions for .principles/ directory.',
      };
    }
  }

  /**
   * Save user-edited INTENT.md content.
   * - Validates content size (INTENT_MAX_BYTES) and type.
   * - Overwrites the existing file (Owner explicitly clicked "Save").
   * - Returns updated summary (hash, warnings) for UI refresh.
   */
  async saveContent(flagEnabled: boolean, content: unknown): Promise<IntentSaveResult> {
    if (!flagEnabled) {
      return {
        ok: false,
        saved: false,
        reason: 'flag_disabled',
        nextAction: 'Enable the intent_engineering feature flag first.',
      };
    }

    // Runtime Contract Rule #1 + #2: treat input as unknown, validate with typeof
    if (typeof content !== 'string') {
      return {
        ok: false,
        saved: false,
        reason: 'invalid_content',
        nextAction: 'Content must be a string.',
      };
    }

    // Rule #3: fail loud on empty content
    if (content.length === 0) {
      return {
        ok: false,
        saved: false,
        reason: 'empty_content',
        nextAction: 'Content cannot be empty.',
      };
    }

    // Validate size limit
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
    const filePath = path.join(dirPath, INTENT_FILENAME);

    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      fs.writeFileSync(filePath, content, 'utf8');

      // Return updated summary for UI refresh
      const sections = parseIntentDocSections(content);
      const warnings = validateIntentDocSections(sections);
      const contentHash = computeIntentContentHash(content);
      const stat = fs.statSync(filePath);

      return {
        ok: true,
        saved: true,
        path: filePath,
        contentHash,
        lastEditedAt: stat.mtime.toISOString(),
        warnings,
      };
    } catch (err) {
      console.error('[IntentPageModel] failed to save INTENT.md:', err);
      return {
        ok: false,
        saved: false,
        reason: 'write_error',
        nextAction: 'Check filesystem permissions for .principles/INTENT.md.',
      };
    }
  }
}