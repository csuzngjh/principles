import * as path from 'path';
import * as fs from 'fs';
import { resolvePdPath } from '../core/paths.js';

export function normalizePath(filePath: string, projectDir: string): string {
  if (!filePath) return '';

  const projectIsWin = projectDir.includes('\\') || (projectDir.length >= 2 && projectDir[1] === ':');
  const fileIsWin = filePath.includes('\\') || (filePath.length >= 2 && filePath[1] === ':');

  let normalizedFilePath = filePath;
  if (projectIsWin !== fileIsWin) {
    if (fileIsWin) {
      // Basic WSL conversion D:\path -> /mnt/d/path
      normalizedFilePath = `/mnt/${filePath.charAt(0).toLowerCase()}${filePath.slice(2).replace(/\\/g, '/')}`;
    }
  }

  // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in both if/else branches
  let rel: string;
  if (projectIsWin) {
    const projectAbs = path.resolve(projectDir);
    const fileAbs = path.isAbsolute(normalizedFilePath) ? normalizedFilePath : path.join(projectAbs, normalizedFilePath);
    rel = path.relative(projectAbs, fileAbs);
  } else {
    const projectPosix = projectDir.replace(/\\/g, '/');
    const filePosix = path.isAbsolute(normalizedFilePath) ? normalizedFilePath : path.posix.join(projectPosix, normalizedFilePath.replace(/\\/g, '/'));
    rel = path.posix.relative(projectPosix, filePosix);
  }

  rel = rel.replace(/\\/g, '/');
  if (rel.startsWith('../')) {
    return normalizedFilePath;
  }
  return rel;
}

export function normalizeRiskPath(p: string): string {
  let normalized = p.replace(/\\/g, '/');
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function isRisky(relPath: string, riskPaths: string[]): boolean {
  if (!relPath || !riskPaths || riskPaths.length === 0) return false;

  const normalizedRel = normalizeRiskPath(relPath);
  for (const pattern of riskPaths) {
    const normalizedPattern = normalizeRiskPath(pattern);
    if (normalizedRel.startsWith(normalizedPattern)) {
      // If it starts with the pattern, and either they are exactly equal OR the next char is a slash
      // (prevents "src/db_backup" matching "src/db")
      if (normalizedRel === normalizedPattern || normalizedRel.charAt(normalizedPattern.length) === '/') {
          return true;
      }
    }
  }
  return false;
}

export function parseKvLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split('\n');
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx !== -1) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Reason: serializeKvLines handles arbitrary object shapes for kv line serialization
export function serializeKvLines(data: Record<string, any>): string {
  const lines: string[] = [];
  const keys = Object.keys(data).sort();
  for (const k of keys) {
    const v = data[k];
    if (Array.isArray(v)) {
      lines.push(`${k}: ${v.join(',')}`);
    } else if (typeof v === 'object' && v !== null) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return lines.join('\n');
}

export function planStatus(projectDir: string): string {
  const planPath = resolvePdPath(projectDir, 'PLAN');
  try {
    if (!fs.existsSync(planPath)) return '';
    const content = fs.readFileSync(planPath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.startsWith('STATUS:')) {
        const parts = line.split(':');
        if (parts.length > 1) {
           return parts[1].trim().split(/\s+/)[0] || '';
        }
      }
    }
  /* eslint-disable @typescript-eslint/no-unused-vars, no-unused-vars -- Reason: Error is intentionally ignored for graceful degradation */
  } catch (_e) {
    // Ignore read errors
  }
  return '';
}
