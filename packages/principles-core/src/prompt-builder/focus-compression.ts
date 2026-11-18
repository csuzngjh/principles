/**
 * Principle Context (SPEC v1.1 §8.3): the legacy working-memory compression
 * surface was retired with its only production consumers (auto-compress,
 * manual compress, working-memory extraction/injection, template recovery).
 * What remains are the two pure display helpers the surviving
 * status/history/rollback commands still need. `CURRENT_FOCUS.md` is now the
 * Owner-maintained Principle Context source file (read-only for PD).
 */

function groupRegexMatch(match: RegExpExecArray | null, index: number): string {
  if (!match) return '';
  return match[index] ?? '';
}

export function extractVersion(content: string): string {
  const match = /\*\*版本\*\*:\s*v([\d.]+)/i.exec(content);
  return match ? groupRegexMatch(match, 1) || '1' : '1';
}

export function extractDate(content: string): string {
  const match = /\*\*更新\*\*:\s*(\d{4}-\d{2}-\d{2})/.exec(content);
  return match ? groupRegexMatch(match, 1) : new Date().toISOString().split('T')[0] ?? '';
}
