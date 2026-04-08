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

    console.log('Bundle created: dist/bundle.js');

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

    console.log('\nPlugin bundle ready for distribution.');
  } catch (error) {
    console.error('Bundle failed:', error);
    process.exit(1);
  }
}

bundlePlugin();
