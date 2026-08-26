import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const isProduction = process.argv.includes('--production');

// Clean dist/ before build to prevent tsc artifacts from coexisting with bundle
if (existsSync('dist')) {
  console.log('🧹 Cleaning dist/...');
  rmSync('dist', { recursive: true, force: true });
}

function copyRecursive(src, dest) {
  const stats = statSync(src);
  if (stats.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyRecursive(join(src, entry), join(dest, entry));
    }
    return;
  }

  copyFileSync(src, dest);
}

async function bundlePlugin() {
  try {
    // 1. Build the main bundle for OpenClaw
    // Banner injects `require` via createRequire so that bundled CJS deps
    // (e.g. yaml, which calls require('process')) work under ESM import.
    // Without this, pd-cli's `import { ... } from 'principles-disciple'`
    // throws "Dynamic require of 'process' is not supported".
    // OpenClaw loads via setupEntry (dynamic import), so the banner is safe.
    await build({
      entryPoints: {
        bundle: 'src/index.ts',
        'governance-audit': 'src/governance-audit.ts',
        // package.json exports ./rulehost-evidence -> dist/rulehost-evidence.js;
        // a clean production-only build must emit it (ERR-090: export targets
        // have to exist in ALL build paths, not just tsc's).
        'rulehost-evidence': 'src/rulehost-evidence.ts',
      },
      outdir: 'dist',
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      banner: {
        js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      external: [
        'openclaw',
        '@openclaw/sdk',
        '@openclaw/plugin-kit',
        'better-sqlite3',
      ],
      sourcemap: isProduction ? false : 'inline',
      minify: isProduction ? true : false,
      treeShaking: true,
      metafile: true,
    });

    console.log('Main bundle created: dist/bundle.js');

    // Generate dist/index.js as a re-export of bundle.js so that package.json
    // main/exports (./dist/index.js) resolves correctly after esbuild clean.
    // tsc build also generates dist/index.js (from src/index.ts) for dev/test.
    writeFileSync('dist/index.js', "export * from './bundle.js';\n");
    console.log('Re-export shim created: dist/index.js -> dist/bundle.js');

    // 2. Build core tools for CLI usage (bootstrap-rules, etc)
    // Skipped in production: these are maintainer-only CLI tools, not needed at
    // runtime (the esbuild bundle above already inlines all core logic).
    // Dev builds still produce them for `npm run bootstrap-rules`.
    if (!isProduction) {
      await build({
        entryPoints: {
          'core/bootstrap-rules': 'src/core/bootstrap-rules.ts',
          'core/principle-tree-ledger': 'src/core/principle-tree-ledger.ts',
          'core/principle-training-state': 'src/core/principle-training-state.ts',
          'core/principle-compiler/index': 'src/core/principle-compiler/index.ts',
          'core/trajectory/index': 'src/core/trajectory.ts',
        },
        outdir: 'dist',
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'esm',
        outbase: 'src',
        external: [
          'openclaw',
          '@openclaw/sdk',
          '@openclaw/plugin-kit',
          'better-sqlite3',
        ],
        sourcemap: false,
        minify: false,
      });
      console.log('Core CLI tools built in dist/core/');
    } else {
      console.log('Production build: skipping core CLI tools (not needed at runtime)');
    }

    const staticFiles = ['templates', 'openclaw.plugin.json', 'assets'];
    const distDir = 'dist';

    for (const file of staticFiles) {
      const src = file;
      const dest = join(distDir, file);
      if (!existsSync(src)) {
        continue;
      }

      if (statSync(src).isDirectory()) {
        copyRecursive(src, dest);
      } else {
        copyFileSync(src, dest);
      }

      console.log(`Copied: ${file} -> dist/${file}`);
    }

    console.log('\nPlugin build ready for distribution.');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

bundlePlugin();
