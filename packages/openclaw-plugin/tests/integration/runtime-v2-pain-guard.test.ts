import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Find repo root by walking up from cwd until we find .git
function findRepoRoot(cwd: string): string {
  let dir = cwd;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return cwd;
}

const repoRoot = findRepoRoot(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function listSourceFiles(dir: string): string[] {
  const absDir = path.join(repoRoot, dir);
  const result: string[] = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const absPath = path.join(absDir, entry.name);
    const relPath = path.relative(repoRoot, absPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      result.push(...listSourceFiles(relPath));
    } else if (entry.isFile() && relPath.endsWith('.ts')) {
      result.push(relPath);
    }
  }
  return result;
}

describe('Runtime V2 pain entrypoint guard', () => {
  it('does not keep active pain flag writer APIs in openclaw-plugin/src', () => {
    const offenders = listSourceFiles('packages/openclaw-plugin/src')
      .filter((file) => read(file).match(/\b(writePainFlag|recordAndWritePainFlag)\b/));

    expect(offenders).toEqual([]);
  });

  it('does not actively write .pain_flag from openclaw-plugin/src', () => {
    const writePatterns = [
      /writeFileSync\s*\([^)]*painFlagPath/s,
      /appendFileSync\s*\([^)]*painFlagPath/s,
      /atomicWriteFileSync\s*\([^)]*painFlagPath/s,
      /createWriteStream\s*\([^)]*painFlagPath/s,
    ];
    const offenders = listSourceFiles('packages/openclaw-plugin/src')
      .filter((file) => writePatterns.some((pattern) => pattern.test(read(file))));

    expect(offenders).toEqual([]);
  });

  it('pd pain record enters PainToPrincipleService directly', () => {
    const source = read('packages/pd-cli/src/commands/pain-record.ts');

    expect(source).toMatch(/PainToPrincipleService/);
    expect(source).toMatch(/service\.recordPain/);
    expect(source).not.toMatch(/createPainSignalBridge/);
    expect(source).not.toMatch(/\.pain_flag|PAIN_FLAG|writePainFlag/);
  });

  it('after_tool_call failure emits Runtime V2 pain event instead of writing .pain_flag', () => {
    const source = read('packages/openclaw-plugin/src/hooks/pain.ts');

    expect(source).toMatch(/emitPainDetectedEvent\(wctx,\s*\{/);
    expect(source).toMatch(/type:\s*'pain_detected'/);
    expect(source).toMatch(/PainToPrincipleService/);
    expect(source).not.toMatch(/createPainSignalBridge/);
    expect(source).not.toMatch(/writePainFlag|recordAndWritePainFlag/);
    expect(source).not.toMatch(/writeFileSync\s*\([^)]*painFlagPath/s);
    expect(source).not.toMatch(/atomicWriteFileSync\s*\([^)]*painFlagPath/s);
  });
});
