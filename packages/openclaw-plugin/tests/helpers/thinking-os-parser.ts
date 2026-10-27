/**
 * Thinking OS XML parser — test helper.
 *
 * Moved out of `src/core/` on 2026-10-27: the parser had no production
 * importers (runtime behaviour comes from the Core Principle Registry in
 * `@principles/core`), only the registry drift test and its own unit test.
 * The template-loading helper was dropped because nothing used it.
 */

export interface ThinkingOsDirective {
  id: string;
  name: string;
  layer: string;
  trigger: string;
  must: string;
  forbidden: string;
}

function extractTag(content: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = content.match(regex);
  if (!match) return '';
  const raw = match[1];
  if (!raw) return '';
  return raw.trim().replace(/\s+/g, ' ');
}

export function parseThinkingOsMd(content: string): ThinkingOsDirective[] {
  const directives: ThinkingOsDirective[] = [];

  const directiveRegex = /<directive\s+([^>]*)>([\s\S]*?)<\/directive>/gi;

  let match: RegExpExecArray | null = null;

  while ((match = directiveRegex.exec(content)) !== null) {
    const attrs = match[1];
    const body = match[2];
    if (!attrs || !body) continue;

    const idMatch = attrs.match(/id="([^"]+)"/i);
    const nameMatch = attrs.match(/name="([^"]+)"/i);
    const layerMatch = attrs.match(/layer="([^"]+)"/i);

    if (!idMatch) continue;
    const id = idMatch[1];
    if (!id) continue;

    directives.push({
      id,
      name: nameMatch ? (nameMatch[1] ?? '') : '',
      layer: layerMatch ? (layerMatch[1] ?? '') : '',
      trigger: extractTag(body, 'trigger'),
      must: extractTag(body, 'must'),
      forbidden: extractTag(body, 'forbidden'),
    });
  }

  return directives;
}
