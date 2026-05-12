import * as fs from 'fs';
import * as path from 'path';

export interface ThinkingOsDirective {
  id: string;
  name: string;
  trigger: string;
  must: string;
  forbidden: string;
}

export interface ThinkingModelOverview {
  totalModels: number;
  models: ThinkingOsDirective[];
  source: 'workspace' | 'none';
}

function extractTag(content: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = content.match(regex);
  if (!match) return '';
  return match[1].trim().replace(/\s+/g, ' ');
}

function parseThinkingOsMd(content: string): ThinkingOsDirective[] {
  const directives: ThinkingOsDirective[] = [];
  const directiveRegex = /<directive\s+([^>]*)>([\s\S]*?)<\/directive>/gi;
  let match: RegExpExecArray | null = null;

  while ((match = directiveRegex.exec(content)) !== null) {
    const [, attrs, body] = match;
    const idMatch = /id="([^"]+)"/i.exec(attrs);
    const nameMatch = /name="([^"]+)"/i.exec(attrs);
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

export class ThinkingModelsConsoleModel {
  private readonly workspaceDir: string;
  private cachedOverview: ThinkingModelOverview | null = null;
  private cacheTimestamp = 0;
  private static readonly CACHE_TTL_MS = 5000;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  getOverview(): ThinkingModelOverview {
    const now = Date.now();
    if (this.cachedOverview && (now - this.cacheTimestamp) < ThinkingModelsConsoleModel.CACHE_TTL_MS) {
      return this.cachedOverview;
    }

    const candidates = [
      path.join(this.workspaceDir, 'THINKING_OS.md'),
      path.join(this.workspaceDir, '.state', 'THINKING_OS.md'),
      path.join(this.workspaceDir, '.pd', 'THINKING_OS.md'),
    ];

    for (const filePath of candidates) {
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const models = parseThinkingOsMd(content);
          if (models.length > 0) {
            this.cachedOverview = { totalModels: models.length, models, source: 'workspace' };
            this.cacheTimestamp = now;
            return this.cachedOverview;
          }
        } catch {
          // try next candidate
        }
      }
    }

    this.cachedOverview = { totalModels: 0, models: [], source: 'none' };
    this.cacheTimestamp = now;
    return this.cachedOverview;
  }

  getModelDetail(modelId: string): ThinkingOsDirective | null {
    const overview = this.getOverview();
    return overview.models.find(m => m.id === modelId) ?? null;
  }

  dispose(): void {
    this.cachedOverview = null;
  }
}
