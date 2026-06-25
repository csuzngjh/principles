import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  INTENT_MAX_BYTES,
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
}