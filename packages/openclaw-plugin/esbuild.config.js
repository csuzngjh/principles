import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync } from 'fs';
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
    await build({
      entryPoints: ['src/index.ts'],
      outfile: 'dist/bundle.js',
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
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

    // 2. Build core tools for CLI usage (bootstrap-rules, etc)
    // We keep these separate and un-minified for easier debugging and CLI importing
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
      target: 'node20',
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

    const staticFiles = ['templates', 'openclaw.plugin.json'];
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
