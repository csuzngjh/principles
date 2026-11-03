#!/usr/bin/env node
/**
 * Gate 4 (PRI-1071) — the single build entry for the installer's
 * `@principles/pd-mcp-server` payload input.
 *
 * Every packaging surface (npm pack/prepack, `npm run bundle`, the
 * self-contained release asset) copies `packages/pd-mcp-server/dist` into the
 * installer payload. Building it HERE — through the package's own workspace
 * build script, after the core declarations it compiles against — keeps a
 * clean checkout, a pack lifecycle and a direct bundle invocation on the same
 * order: core → MCP server → installer payload.
 * Deriving it from local residue (`dist` left over on a developer machine) is
 * exactly the failure this module prevents.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const MCP_SERVER_MANIFEST = join(repoRoot, 'packages', 'pd-mcp-server', 'package.json');
const CORE_MANIFEST = join(repoRoot, 'packages', 'principles-core', 'package.json');

const npmCliJs = (() => {
  const nodeDir = dirname(process.execPath);
  const prefixDir = dirname(nodeDir);
  return [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(prefixDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(prefixDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((candidate) => existsSync(candidate));
})();

/**
 * Build the workspace MCP server package. Returns false (with a loud stderr
 * notice) when the package is absent — pre-integration baselines bundle
 * without the component, which bundle-plugin.mjs reports the same way.
 */
export function buildMcpServer() {
  if (!existsSync(MCP_SERVER_MANIFEST)) {
    console.error('[mcp-server-build] packages/pd-mcp-server absent — skipping its build (pre-Gate-4 baseline).');
    return false;
  }
  if (!npmCliJs) {
    throw new Error(`npm-cli.js not found near ${process.execPath} — run this script with a complete Node.js installation`);
  }
  // The capability subpath (`@principles/core/runtime-v2/pain-recall-capability`)
  // is resolved from core's emitted declarations, which a clean checkout does
  // not have. Build the dependency first so prepack/bundle never depend on a
  // pre-existing core dist either.
  if (existsSync(CORE_MANIFEST)) {
    execFileSync(process.execPath, [npmCliJs, 'run', 'build', '--workspace=@principles/core'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }
  execFileSync(process.execPath, [npmCliJs, 'run', 'build', '--workspace=@principles/pd-mcp-server'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  const entry = join(repoRoot, 'packages', 'pd-mcp-server', 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(`@principles/pd-mcp-server build finished without ${entry}; refusing to bundle an incomplete payload.`);
  }
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildMcpServer();
}
