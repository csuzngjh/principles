/**
 * Thinking OS XML Parser
 *
 * Parses THINKING_OS.md to extract directive definitions.
 * The Core Principle Registry in @principles/core (core-principle-registry.ts)
 * is the single source of truth for directive ids/names; THINKING_OS.md
 * templates mirror it and the drift test enforces alignment (PRI-607).
 *
 * XML structure:
 *   <directive id="T-01" name="Survey Before Acting">
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
  name: string;       // "Survey Before Acting"
  layer: string;      // "foundational" | "operating" — registry layer (may be '' if attr absent)
  trigger: string;    // <trigger> content — used for detection patterns
  must: string;       // <must> content — used as description; first sentence anchors the registry statement
  forbidden: string;  // <forbidden> content — used as anti-pattern
}

/**
 * Extract a single XML tag's text content from a string.
 */
function extractTag(content: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = content.match(regex);
  if (!match) return '';
  const raw = match[1];
  if (!raw) return '';
  return raw.trim().replace(/\s+/g, ' ');
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
    const attrs = _match[1];
    const body = _match[2];
    if (!attrs || !body) continue;

    const idMatch = attrs.match(/id="([^"]+)"/i);
    const nameMatch = attrs.match(/name="([^"]+)"/i);
    const layerMatch = attrs.match(/layer="([^"]+)"/i);

    if (!idMatch) continue;
    const id = idMatch[1];
    if (!id) continue;

    const directive: ThinkingOsDirective = {
      id,
      name: nameMatch ? (nameMatch[1] ?? '') : '',
      layer: layerMatch ? (layerMatch[1] ?? '') : '',
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
