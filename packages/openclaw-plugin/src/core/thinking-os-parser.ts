/**
 * Thinking OS XML Parser
 *
 * Parses THINKING_OS.md to extract directive definitions.
 * THINKING_OS.md is the single source of truth for thinking models.
 *
 * Required XML structure:
 *   <directive id="T-01" name="MAP_BEFORE_TERRITORY">
 *     <trigger>...</trigger>
 *     <must>...</must>
 *     <forbidden>...</forbidden>
 *   </directive>
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { resolvePdPath } from './paths.js';

export interface ThinkingOsDirective {
  id: string;         // "T-01"
  name: string;       // "MAP_BEFORE_TERRITORY"
  trigger: string;    // <trigger> content — used for detection patterns
  must: string;       // <must> content — used as description
  forbidden: string;  // <forbidden> content — used as anti-pattern
}

/**
 * Extract a single XML tag's text content from a string.
 */
function extractTag(content: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = content.match(regex);
  if (!match) return '';
  return match[1].trim().replace(/\s+/g, ' ');
}

/**
 * Parse THINKING_OS.md content and extract all <directive> blocks.
 * Returns empty array if no XML directives found.
 */
export function parseThinkingOsMd(content: string): ThinkingOsDirective[] {
  const directives: ThinkingOsDirective[] = [];
  const directiveRegex = /<directive\s+([^>]*)>([\s\S]*?)<\/directive>/gi;
  /* eslint-disable @typescript-eslint/init-declarations, @typescript-eslint/no-use-before-define, @typescript-eslint/prefer-destructuring, no-useless-assignment, @typescript-eslint/no-unused-vars */
  let match: RegExpExecArray | null = null;

  while ((match = directiveRegex.exec(content)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const idMatch = attrs.match(/id="([^"]+)"/i);
    const nameMatch = attrs.match(/name="([^"]+)"/i);
    if (!idMatch) continue;

    directives.push({
      id: idMatch[1],
      name: nameMatch ? nameMatch[1] : '',
      trigger: extractTag(body, 'trigger'),
      must: extractTag(body, 'must'),
      forbidden: extractTag(body, 'forbidden'),
    });
  }

  return directives;
}

/**
 * Load THINKING_OS.md from the workspace.
 * Falls back to plugin templates if workspace file doesn't exist or has no XML directives.
 */
export function loadThinkingOsFromWorkspace(
  workspaceDir: string,
  language = 'zh',
): ThinkingOsDirective[] {
  // Priority 1: workspace THINKING_OS.md
  const workspacePath = resolvePdPath(workspaceDir, 'THINKING_OS');
  if (fs.existsSync(workspacePath)) {
    try {
      const content = fs.readFileSync(workspacePath, 'utf-8');
      const directives = parseThinkingOsMd(content);
      if (directives.length > 0) return directives;
    } catch {
      // Fall through to template
    }
  }

  // Priority 2: plugin template for the given language
  const templatePath = resolveTemplatePath(language);
  if (templatePath) {
    try {
      const content = fs.readFileSync(templatePath, 'utf-8');
      const directives = parseThinkingOsMd(content);
      if (directives.length > 0) return directives;
    } catch {
      // Fall through to zh template
    }
  }

  // Priority 3: zh template as ultimate fallback
  const zhPath = resolveTemplatePath('zh');
  if (zhPath) {
    try {
      const content = fs.readFileSync(zhPath, 'utf-8');
      return parseThinkingOsMd(content);
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Resolve the THINKING_OS.md template path for a given language.
 */
function resolveTemplatePath(language: string): string | null {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const templatePath = path.join(
    path.dirname(path.dirname(path.dirname(currentDir))),
    'templates',
    'langs',
    language,
    'principles',
    'THINKING_OS.md',
  );
  return fs.existsSync(templatePath) ? templatePath : null;
}

/**
 * Extract meaningful detection keywords from a trigger string.
 * Returns an array of regex patterns.
 */
export function generateDetectionPatterns(trigger: string): RegExp[] {
  if (!trigger) return [];

  const patterns: string[] = [];

  // Extract Chinese phrases: 3-8 character sequences
  const chinesePattern = /[\u4e00-\u9fff]{3,8}/g;
  const chineseMatches = trigger.match(chinesePattern) ?? [];
  for (const phrase of chineseMatches) {
    patterns.push(phrase);
  }

  // Extract English words/phrases
  const englishPattern = /[a-zA-Z]{3,20}(?:\s+[a-zA-Z]{3,20}){0,3}/g;
  const englishMatches = trigger.match(englishPattern) ?? [];
  for (const phrase of englishMatches) {
    const cleaned = phrase.trim();
    if (cleaned.length >= 3) {
      patterns.push(cleaned);
    }
  }

  return patterns.map(p => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}
