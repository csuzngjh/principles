/**
 * Edit Verification Module
 *
 * Enforces P-03 (precise verification principle) for edit tool operations.
 *
 * **Responsibilities:**
 * - Verify oldText matches current file content before edit
 * - Fuzzy matching for whitespace-agnostic comparison
 * - File size limits and binary file detection
 * - Automatic correction of whitespace mismatches
 * - Detailed error messages with guidance for fix
 *
 * **Configuration:**
 * - Edit verification settings from profile.edit_verification
 * - Max file size threshold (default 10MB)
 * - Fuzzy match threshold (default 0.8)
 * - Skip action for large files (warn/block)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import type { WorkspaceContext } from '../core/workspace-context.js';

export interface EditVerificationConfig {
  enabled?: boolean;
  max_file_size_bytes?: number;
  fuzzy_match_enabled?: boolean;
  fuzzy_match_threshold?: number;
  skip_large_file_action?: 'warn' | 'block';
}

/**
 * Normalize a line for fuzzy matching by collapsing whitespace
 */
export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/**
 * Find fuzzy match between oldText and current file content
 * @param lines - File content split into lines
 * @param oldLines - oldText split into lines
 * @param threshold - Match threshold (0-1)
 * @returns Match index or -1 if not found
 */
export function findFuzzyMatch(lines: string[], oldLines: string[], threshold = 0.8): number {
  if (oldLines.length === 0) return -1;  // P2 fix: empty array boundary check

  const normalizedLines = lines.map(normalizeLine);
  const normalizedOldLines = oldLines.map(normalizeLine);

  // Try to find matching sequence
  for (let i = 0; i <= lines.length - oldLines.length; i++) {
    let matchCount = 0;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalizedLines[i + j] === normalizedOldLines[j]) {
        matchCount++;
      }
    }

    // Use threshold from config
    if (matchCount >= oldLines.length * threshold) {
      return i;
    }
  }

  return -1;
}

/**
 * Try to find a fuzzy match for oldText in current content
 * @param currentContent - Current file content
 * @param oldText - Text to match
 * @param threshold - Match threshold (0-1)
 * @returns Object with found status and corrected text if found
 */
export function tryFuzzyMatch(currentContent: string, oldText: string, threshold = 0.8): { found: boolean; correctedText?: string } {
  const lines = currentContent.split('\n');
  const oldLines = oldText.split('\n');

  const matchIndex = findFuzzyMatch(lines, oldLines, threshold);

  if (matchIndex !== -1) {
    // Found fuzzy match, extract actual text from file
    const correctedText = lines.slice(matchIndex, matchIndex + oldLines.length).join('\n');
    return { found: true, correctedText };
  }

  return { found: false };
}

/**
 * Generate a helpful error message for edit verification failure
 */
export function generateEditError(filePath: string, oldText: string, currentContent: string): string {
  const expectedSnippet = oldText.split('\n').slice(0, 3).join('\n').substring(0, 200);
  const actualSnippet = currentContent.substring(0, 200);

  return `[P-03 Violation] Edit verification failed

File: ${filePath}

The text you're trying to replace does not match the current file content.

Expected to find:
${expectedSnippet}${oldText.length > 200 ? '...' : ''}

Actual file contains:
${actualSnippet}${currentContent.length > 200 ? '...' : ''}

Possible reasons:
  - File has been modified by another process
  - Whitespace characters do not match (spaces, tabs, newlines)
  - Context compression caused outdated information

Solution:
  1. Use 'read' tool to get current file content
  2. Update your edit command with exact text from file
  3. Retry edit operation

This is enforced by P-03 (精确匹配前验证原则).`;
}

/**
 * Handle edit tool verification before allowing operation
 * This enforces P-03 at the tool layer
 */
 
 
export function handleEditVerification(
  event: PluginHookBeforeToolCallEvent,
  wctx: WorkspaceContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Reason: logger is typed as any by plugin framework - type not available
  ctx: { logger?: any; sessionId?: string },
  config: EditVerificationConfig = {}
): PluginHookBeforeToolCallResult | void {
  // Skip verification if disabled - return early without any processing or logging
  if (config.enabled === false) {
    return;
  }

  const logger = ctx.logger || console;
  const maxSizeBytes = config.max_file_size_bytes ?? 10 * 1024 * 1024; // Default 10MB
  const fuzzyMatchEnabled = config.fuzzy_match_enabled !== false;
  const fuzzyMatchThreshold = config.fuzzy_match_threshold ?? 0.8;
  const skipAction: 'warn' | 'block' = config.skip_large_file_action ?? 'warn';

  // 1. Extract parameters (handle both parameter naming conventions)
  const filePath = event.params.file_path || event.params.path || event.params.file;
  const oldText = event.params.oldText || event.params.old_string;

  if (!filePath || !oldText) {
    // Missing required parameters, let it fail naturally
    return;
  }

  // 2. Resolve and read file
   
   
  let absolutePath: string;
  try {
    absolutePath = wctx.resolve(filePath);
  } catch (_error) { // eslint-disable-line @typescript-eslint/no-unused-vars -- Reason: intentionally unused - let it fail naturally on path resolution error
    // Path resolution error, let it fail naturally
    return;
  }

  // 2.5. Skip verification for binary files
  const BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
                           '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
                           '.exe', '.dll', '.so', '.dylib', '.bin',
                           '.mp3', '.mp4', '.avi', '.mov', '.wav',
                           '.ttf', '.otf', '.woff', '.woff2',
                           '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];
  const ext = path.extname(absolutePath).toLowerCase();
  if (BINARY_EXTENSIONS.includes(ext)) {
    logger?.info?.(`[PD_GATE:EDIT_VERIFY] Skipping verification for binary file: ${path.basename(filePath)}`);
    return;
  }

  try {
    // 2.6. Check file size before reading (P-03 improvement)
    try {
      const stats = fs.statSync(absolutePath);
      const fileSizeBytes = stats.size;
      const fileSizeMB = fileSizeBytes / (1024 * 1024);

      if (fileSizeBytes > maxSizeBytes) {
        const message = `[PD_GATE:EDIT_VERIFY] File size check: ${path.basename(filePath)} is ${fileSizeMB.toFixed(2)}MB (threshold: ${(maxSizeBytes / (1024 * 1024)).toFixed(2)}MB)`;

        if (skipAction === 'block') {
          logger?.warn?.(message + ' - BLOCKED');
          return {
            block: true,
            blockReason: `${message}\n\nFile is too large for edit verification. Increase max_file_size_bytes in PROFILE.json or reduce file size.`
          };
        } else {
          logger?.warn?.(message + ' - SKIPPING verification');
          return; // Skip verification but allow operation
        }
      }

      logger?.info?.(`[PD_GATE:EDIT_VERIFY] File size check passed: ${path.basename(filePath)} (${fileSizeMB.toFixed(2)}MB)`);
    } catch (statError) {
      // File stat error (e.g., permission denied)
      const errStr = statError instanceof Error ? statError.message : String(statError);
      const errCode = (statError as { code?: string }).code;

      if (errCode === 'EACCES' || errCode === 'EPERM') {
        logger?.error?.(`[PD_GATE:EDIT_VERIFY] Permission denied accessing file: ${path.basename(filePath)} (${errStr})`);
        return {
          block: true,
          blockReason: `[P-03 Error] Permission denied: Cannot access file ${absolutePath}\n\nError: ${errStr}\n\nSolution: Check file permissions or run with appropriate access rights.`
        };
      } else if (errCode === 'ENOENT') {
        logger?.warn?.(`[PD_GATE:EDIT_VERIFY] File not found: ${path.basename(filePath)} (${errStr})`);
        // File doesn't exist - let edit operation proceed (it will create file)
        return;
      } else {
        logger?.warn?.(`[PD_GATE:EDIT_VERIFY] Stat error: ${errStr}`);
        // Let it fail naturally on read attempt
      }
    }

    // 3. Read current file content with improved error handling
     
     
    let currentContent: string;
    try {
      currentContent = fs.readFileSync(absolutePath, 'utf-8');
    } catch (readError) {
      const errStr = readError instanceof Error ? readError.message : String(readError);
      const errCode = (readError as { code?: string }).code;

      if (errCode === 'EACCES' || errCode === 'EPERM') {
        logger?.error?.(`[PD_GATE:EDIT_VERIFY] Permission denied reading file: ${path.basename(filePath)} (${errStr})`);
        return {
          block: true,
          blockReason: `[P-03 Error] Permission denied: Cannot read file ${absolutePath}\n\nError: ${errStr}\n\nSolution: Check file permissions or run with appropriate access rights.`
        };
      } else if (errCode === 'ENOENT') {
        logger?.warn?.(`[PD_GATE:EDIT_VERIFY] File not found: ${path.basename(filePath)} (${errStr})`);
        // File doesn't exist - let edit operation proceed
        return;
      } else if (errStr.includes('UTF-8') || errStr.includes('encoding')) {
        logger?.error?.(`[PD_GATE:EDIT_VERIFY] Encoding error reading file: ${path.basename(filePath)} (${errStr})`);
        return {
          block: true,
          blockReason: `[P-03 Error] Encoding error: Cannot read file ${absolutePath}\n\nError: ${errStr}\n\nThe file appears to use an encoding other than UTF-8. Edit verification requires UTF-8 readable text files.\n\nSolution: Ensure file is UTF-8 encoded text, or mark binary extensions to skip verification.`
        };
      } else {
        logger?.warn?.(`[PD_GATE:EDIT_VERIFY] Read error: ${errStr}`);
        // Let it fail naturally
        return;
      }
    }

    // 4. Verify oldText exists in current content
    if (!currentContent.includes(oldText)) {
      logger?.info?.(`[PD_GATE:EDIT_VERIFY] Exact match failed for ${path.basename(filePath)}, trying fuzzy match`);

      // 5. Try fuzzy matching (if enabled)
      if (fuzzyMatchEnabled) {
        const fuzzyResult = tryFuzzyMatch(currentContent, oldText, fuzzyMatchThreshold);

        if (fuzzyResult.found && fuzzyResult.correctedText) {
          logger?.info?.(`[PD_GATE:EDIT_VERIFY] Fuzzy match found for ${path.basename(filePath)}, auto-correcting oldText`);

          // Return corrected parameters
          return {
            params: {
              ...event.params,
              oldText: fuzzyResult.correctedText,
              old_string: fuzzyResult.correctedText
            }
          };
        }
      }

      // 6. No match found, block operation with helpful error
      const errorMsg = generateEditError(absolutePath, oldText, currentContent);

      logger?.error?.(`[PD_GATE:EDIT_VERIFY] Block edit on ${path.basename(filePath)}: oldText not found`);

      return {
        block: true,
        blockReason: errorMsg
      };
    }

    // 7. Verification passed, allow edit to proceed
    logger?.info?.(`[PD_GATE:EDIT_VERIFY] Verified edit on ${path.basename(filePath)}`);
    return;

  } catch (error) {
    // Unexpected error - let it fail naturally
    const errorStr = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`[PD_GATE:EDIT_VERIFY] Unexpected error: ${errorStr}`);
    return;
  }
}
