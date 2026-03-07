import * as fs from 'fs';
import * as path from 'path';
import { serializeKvLines, parseKvLines } from '../utils/io.js';

export function computePainScore(rc: number, isSpiral: boolean, missingTestCommand: boolean, softScore: number): number {
  let score = Math.max(0, softScore || 0);

  if (rc !== 0) {
    score += 70;
  }

  if (isSpiral) {
    score += 40;
  }

  if (missingTestCommand) {
    score += 30;
  }

  return Math.min(100, score);
}

export function painSeverityLabel(painScore: number, isSpiral: boolean = false): string {
  if (isSpiral) {
    return "critical";
  } else if (painScore >= 70) {
    return "high";
  } else if (painScore >= 40) {
    return "medium";
  } else if (painScore >= 20) {
    return "low";
  } else {
    return "info";
  }
}

export function writePainFlag(projectDir: string, painData: Record<string, string>): void {
  const painFlagPath = path.join(projectDir, "docs", ".pain_flag");
  const dir = path.dirname(painFlagPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(painFlagPath, serializeKvLines(painData), "utf-8");
}

export function readPainFlagData(projectDir: string): Record<string, string> {
  const painFlagPath = path.join(projectDir, "docs", ".pain_flag");
  try {
    if (!fs.existsSync(painFlagPath)) {
      return {};
    }
    const content = fs.readFileSync(painFlagPath, "utf-8");
    return parseKvLines(content);
  } catch (e) {
    return {};
  }
}
