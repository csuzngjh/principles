import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertConsoleDistFresh } from '../scripts/console-dist-freshness.mjs';

/**
 * G3.2 Console skip flag protection: PD_BUNDLE_SKIP_CONSOLE_BUILD may only
 * reuse a console dist that is complete, production-mode, not older than its
 * sources and free of compiled test artifacts. Every other state must fail
 * loud — the flag is a skip of a VERIFIED build, never a way to avoid one.
 */
describe('console dist freshness gate (PD_BUNDLE_SKIP_CONSOLE_BUILD)', () => {
  const T_SRC = new Date('2026-01-01T00:00:00Z');
  const T_DIST = new Date('2026-01-02T00:00:00Z');

  // Fixture paths are test literals, but every one is still resolved and
  // contained inside the fixture root before any filesystem write/remove.
  function inRoot(root: string, rel: string): string {
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`fixture path escapes root: ${rel}`);
    }
    return target;
  }

  function createConsole(): string {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-g32-console-'));
    const write = (rel: string, content: string, mtime: Date) => {
      const abs = inRoot(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      fs.utimesSync(abs, mtime, mtime);
    };
    write('src/server/index.ts', 'export const s = 1;\n', T_SRC);
    write('src/ui/main.tsx', 'export const u = 1;\n', T_SRC);
    write('dist/server.js', "export { main } from './server/index.js';\n", T_DIST);
    write('dist/server/index.js', 'export function main() {}\n', T_DIST);
    write('dist/web/index.html', '<!doctype html><script src="./assets/app.js"></script>\n', T_DIST);
    write('dist/web/assets/app.js', '(()=>{console.log(1)})();\n', T_DIST);
    return root;
  }

  it('accepts a complete, production-mode, fresh, hygienic dist', () => {
    const root = createConsole();
    try {
      expect(() => assertConsoleDistFresh(root)).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when the console was never built (dist/ absent)', () => {
    const root = createConsole();
    try {
      fs.rmSync(inRoot(root, 'dist'), { recursive: true, force: true });
      expect(() => assertConsoleDistFresh(root)).toThrow(/incomplete/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['dist/server.js'],
    ['dist/server/index.js'],
    ['dist/web/index.html'],
  ])('fails when the required artifact %s is missing (incomplete dist)', (rel) => {
    const root = createConsole();
    try {
      fs.rmSync(inRoot(root, rel));
      expect(() => assertConsoleDistFresh(root)).toThrow(/incomplete/);
      expect(() => assertConsoleDistFresh(root)).toThrow(rel);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when the production browser bundle is missing', () => {
    const root = createConsole();
    try {
      fs.rmSync(inRoot(root, 'dist/web/assets/app.js'));
      expect(() => assertConsoleDistFresh(root)).toThrow(/app\.js is missing/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails on a DEV browser bundle (inline sourcemap)', () => {
    const root = createConsole();
    try {
      const appJs = inRoot(root, 'dist/web/assets/app.js');
      fs.writeFileSync(appJs, 'x();\n//# sourceMappingURL=data:application/json;base64,e30=\n');
      fs.utimesSync(appJs, T_DIST, T_DIST);
      expect(() => assertConsoleDistFresh(root)).toThrow(/DEV build/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails on a stale dist (a source file newer than every dist file — old build)', () => {
    const root = createConsole();
    try {
      const later = new Date('2026-01-03T00:00:00Z');
      fs.utimesSync(inRoot(root, 'src/ui/main.tsx'), later, later);
      expect(() => assertConsoleDistFresh(root)).toThrow(/STALE/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when the dist carries compiled test artifacts', () => {
    const root = createConsole();
    try {
      const testFile = inRoot(root, 'dist/ui/__tests__/x.test.js');
      fs.mkdirSync(path.dirname(testFile), { recursive: true });
      fs.writeFileSync(testFile, 'test();\n');
      fs.utimesSync(testFile, T_DIST, T_DIST);
      expect(() => assertConsoleDistFresh(root)).toThrow(/compiled test artifact/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('every failure message tells the operator how to recover', () => {
    const root = createConsole();
    try {
      fs.rmSync(inRoot(root, 'dist'), { recursive: true, force: true });
      expect(() => assertConsoleDistFresh(root)).toThrow(/nextAction: unset PD_BUNDLE_SKIP_CONSOLE_BUILD/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
