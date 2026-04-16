/**
 * Thinking OS XML Parser
 *
 * Parses THINKING_OS.md to extract directive definitions.
 * THINKING_OS.md is the single source of truth for thinking models.
 *
 * XML structure:
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
 * Returns empty array if no directives found.
 */
export function parseThinkingOsMd(content: string): ThinkingOsDirective[] {
  const directives: ThinkingOsDirective[] = [];

  // Match all <directive ...> ... </directive> blocks
  const directiveRegex = /<directive\s+([^>]*)>([\s\S]*?)<\/directive>/gi;
   
   
  let _match: RegExpExecArray | null = null;

  while ((_match = directiveRegex.exec(content)) !== null) {
    const [, attrs, body] = _match;

    const idMatch = /id="([^"]+)"/i.exec(attrs);
    const nameMatch = /name="([^"]+)"/i.exec(attrs);

    if (!idMatch) continue;

    const directive: ThinkingOsDirective = {
      id: idMatch[1],
      name: nameMatch ? nameMatch[1] : '',
      trigger: extractTag(body, 'trigger'),
      must: extractTag(body, 'must'),
      forbidden: extractTag(body, 'forbidden'),
    };

    directives.push(directive);
  }

  return directives;
}

/**
 * Load THINKING_OS.md from the plugin templates for a given language.
 * Falls back to the workspace THINKING_OS.md if it exists.
 */
export function loadThinkingOsFromWorkspace(
  workspaceDir: string,
  language = 'zh',
): ThinkingOsDirective[] {
  // Priority 1: workspace's own THINKING_OS.md
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

  // ES Module compatible __dirname (must be inside function for bundler)
  const currentDir = path.dirname(fileURLToPath(import.meta.url));

  // Priority 2: plugin template for the given language
  const templatePath = path.join(
    path.dirname(path.dirname(path.dirname(currentDir))),
    'templates',
    'langs',
    language,
    'principles',
    'THINKING_OS.md',
  );

  if (fs.existsSync(templatePath)) {
    try {
      const content = fs.readFileSync(templatePath, 'utf-8');
      return parseThinkingOsMd(content);
    } catch {
      // Fall through to zh template
    }
  }

  // Priority 3: zh template as ultimate fallback
  const zhPath = path.join(
    path.dirname(path.dirname(path.dirname(currentDir))),
    'templates',
    'langs',
    'zh',
    'principles',
    'THINKING_OS.md',
  );

  if (fs.existsSync(zhPath)) {
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
 * Extract meaningful detection keywords from a trigger string.
 * Returns an array of regex patterns.
 */
export function generateDetectionPatterns(trigger: string): RegExp[] {
  if (!trigger) return [];

  const patterns: string[] = [];

  // Extract Chinese phrases: 3-8 character sequences that are meaningful
  const chinesePattern = /[\u4e00-\u9fff]{3,8}/g;
  const chineseMatches = trigger.match(chinesePattern) ?? [];
  for (const phrase of chineseMatches) {
    patterns.push(phrase);
  }

  // Extract English words/phrases: sequences of letters
  const englishPattern = /[a-zA-Z]{3,20}(?:\s+[a-zA-Z]{3,20}){0,3}/g;
  const englishMatches = trigger.match(englishPattern) ?? [];
  for (const phrase of englishMatches) {
    const cleaned = phrase.trim();
    if (cleaned.length >= 3) {
      patterns.push(cleaned);
    }
  }

  // Convert to case-insensitive regexes
  return patterns.map(p => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}
