// FeedbackReportConsoleModel.ts
// Stores MVP seed feedback report drafts locally on disk at:
//   <workspaceDir>/.pd/feedback/drafts/<id>.json
//
// This is a writeable but non-publishing channel. Drafts are produced by
// `createFeedbackReport` (in @principles/core) and then surfaced back to the
// user so they can copy/paste them into GitHub, email, or the maintainer.
// This model never reaches the network — it only reads/writes local files.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { FeedbackReport } from '@principles/core/runtime-v2/feedback';

/**
 * Best-effort error message extraction from an `unknown` caught value.
 * Returns `String(err)` if no `.message` is present.
 */
function errMsg(e: { code?: string } | undefined, err: unknown): string {
  // Check the unknown caught value (err) for a string message first.
  if (err !== null && err !== undefined && typeof err === 'object' && Object.hasOwn(err, 'message')) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  if (typeof err === 'string') return err;
  return String(err);
}

export type FeedbackReportDraftSummary = {
  id: string;
  createdAt: string;
  type: string;
  title: string;
};

export type FeedbackReportListResult = {
  ok: boolean;
  drafts: FeedbackReportDraftSummary[];
  error?: string;
  nextAction?: string;
};

export type FeedbackReportGetResult = {
  ok: boolean;
  report?: FeedbackReport;
  error?: string;
  errorCode?: 'NOT_FOUND' | 'INVALID_ID' | 'READ_ERROR';
  nextAction?: string;
};

export type FeedbackReportDeleteResult = {
  ok: boolean;
  error?: string;
  nextAction?: string;
};

const FEEDBACK_DIR = '.pd/feedback';
const DRAFTS_DIR = 'drafts';

function ensureDir(dir: string): { ok: true } | { ok: false; error: string; nextAction: string } {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to create directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      nextAction: 'verify the workspace directory is writable and that the parent exists',
    };
  }
}

function reportIdValidator(id: string): boolean {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 256) return false;
  // Only allow safe filename characters; reject path traversal attempts.
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

function validateReportShape(value: unknown): value is FeedbackReport {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.type === 'string' &&
    typeof v.title === 'string' &&
    typeof v.userText === 'object' &&
    v.userText !== null &&
    typeof v.diagnosticSummary === 'object' &&
    v.diagnosticSummary !== null
  );
}

export class FeedbackReportConsoleModel {
  private readonly workspaceDir: string;
  private readonly draftsDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.draftsDir = path.join(workspaceDir, FEEDBACK_DIR, DRAFTS_DIR);
  }

  private ensureDraftsDir(): { ok: true } | { ok: false; error: string; nextAction: string } {
    return ensureDir(this.draftsDir);
  }

  /**
   * Persist a generated feedback report draft to disk.
   * Returns the resulting summary plus a structured error if writing failed.
   */
  async create(report: FeedbackReport): Promise<FeedbackReportGetResult> {
    if (!validateReportShape(report)) {
      return {
        ok: false,
        error: 'FeedbackReport is missing required fields (id, createdAt, type, title, userText, diagnosticSummary)',
        nextAction: 'call createFeedbackReport() to generate a validated report, then submit it',
      };
    }
    const dir = this.ensureDraftsDir();
    if (!dir.ok) return dir;
    const filePath = path.join(this.draftsDir, `${report.id}.json`);
    try {
      // Atomic write: serialize to a tmp file, then rename.
      const tmpPath = `${filePath}.${randomUUID()}.tmp`;
      const body = JSON.stringify(report, null, 2);
      await fs.promises.writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmpPath, filePath);
      return { ok: true, report };
    } catch (err) {
      return {
        ok: false,
        error: `Failed to write feedback report draft at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        nextAction: 'verify the workspace directory is writable and that disk space is available',
      };
    }
  }

  /**
   * List all draft summaries (id, createdAt, type, title), newest-first.
   */
  async list(): Promise<FeedbackReportListResult> {
    const dir = this.ensureDraftsDir();
    if (!dir.ok) {
      return {
        ok: false,
        drafts: [],
        error: dir.error,
        nextAction: dir.nextAction,
      };
    }
    try {
      const entries = await fs.promises.readdir(this.draftsDir, { withFileTypes: true });
      const files = entries.filter((e) => e.isFile() && e.name.endsWith('.json'));
      const drafts: FeedbackReportDraftSummary[] = [];
      for (const f of files) {
        const filePath = path.join(this.draftsDir, f.name);
        try {
          const raw = await fs.promises.readFile(filePath, 'utf8');
          const parsed: unknown = JSON.parse(raw);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            typeof (parsed as Record<string, unknown>).id === 'string' &&
            typeof (parsed as Record<string, unknown>).createdAt === 'string' &&
            typeof (parsed as Record<string, unknown>).type === 'string' &&
            typeof (parsed as Record<string, unknown>).title === 'string'
          ) {
            const obj = parsed as Record<string, unknown>;
            drafts.push({
              id: obj.id as string,
              createdAt: obj.createdAt as string,
              type: obj.type as string,
              title: obj.title as string,
            });
          }
        } catch (readErr) {
          // Skip unreadable/malformed draft — but record diagnostics for observability.
          const skipReason = readErr instanceof Error ? readErr.message : String(readErr);
          console.warn(`[FeedbackReportConsoleModel] skipping unreadable draft "${f.name}": ${skipReason}`);
        }
      }
      drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { ok: true, drafts };
    } catch (err) {
      return {
        ok: false,
        drafts: [],
        error: `Failed to read feedback drafts directory ${this.draftsDir}: ${err instanceof Error ? err.message : String(err)}`,
        nextAction: 'verify the workspace directory exists and is readable',
      };
    }
  }

  /**
   * Load a draft by id. Returns ok:false + nextAction when missing or invalid.
   */
  async get(id: string): Promise<FeedbackReportGetResult> {
    if (!reportIdValidator(id)) {
      return {
        ok: false,
        error: `Invalid feedback report id: ${JSON.stringify(id)}`,
        errorCode: 'INVALID_ID',
        nextAction: 'pass a safe id matching /^[A-Za-z0-9._-]+$/ with length 1-256',
      };
    }
    const dir = this.ensureDraftsDir();
    if (!dir.ok) return dir;
    const filePath = path.join(this.draftsDir, `${id}.json`);
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!validateReportShape(parsed)) {
        return {
          ok: false,
          error: `Feedback report at ${filePath} is malformed`,
          nextAction: 'delete the corrupted draft and create a new one',
        };
      }
      return { ok: true, report: parsed };
    } catch (err) {
      const e = err as { code?: string };
      if (e?.code === 'ENOENT') {
        return {
          ok: false,
          error: `Feedback report not found: ${id}`,
          errorCode: 'NOT_FOUND',
          nextAction: 'verify the report id is correct (use list() to enumerate drafts)',
        };
      }
      return {
        ok: false,
        error: `Failed to read feedback report at ${filePath}: ${errMsg(e, err)}`,
        errorCode: 'READ_ERROR',
        nextAction: 'verify the file is readable and the workspace directory is intact',
      };
    }
  }

  /**
   * Delete a draft by id. No-op (still ok:true) if the file does not exist.
   */
  async delete(id: string): Promise<FeedbackReportDeleteResult> {
    if (!reportIdValidator(id)) {
      return {
        ok: false,
        error: `Invalid feedback report id: ${JSON.stringify(id)}`,
        nextAction: 'pass a safe id matching /^[A-Za-z0-9._-]+$/ with length 1-256',
      };
    }
    const filePath = path.join(this.draftsDir, `${id}.json`);
    try {
      await fs.promises.unlink(filePath);
      return { ok: true };
    } catch (err) {
      const e = err as { code?: string };
      if (e?.code === 'ENOENT') {
        return { ok: true };
      }
      return {
        ok: false,
        error: `Failed to delete feedback report at ${filePath}: ${errMsg(e, err)}`,
        nextAction: 'verify the file is deletable and the workspace directory is writable',
      };
    }
  }

  dispose(): void {
    // Nothing to dispose; this model holds no connections.
    // (This override satisfies the class-methods-use-this ESLint rule for
    // symmetry with other model classes in this package.)
    void this;
  }
}
