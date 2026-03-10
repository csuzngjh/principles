import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const isProduction = process.argv.includes('--production');

async function bundlePlugin() {
  try {
    // Build the plugin bundle
    await build({
      entryPoints: ['dist/index.js'],
      outfile: 'dist/bundle.js',
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      external: [
        // Only externalize OpenClaw SDK
        'openclaw',
        '@openclaw/sdk',
        '@openclaw/plugin-kit',
      ],
      sourcemap: isProduction ? false : 'inline',
      minify: isProduction ? true : false,
      treeShaking: true,
      metafile: true,
    });

    console.log('✅ Bundle created: dist/bundle.js');

    // Update openclaw.plugin.json to use bundle
    const pluginJsonPath = 'openclaw.plugin.json';
    if (existsSync(pluginJsonPath)) {
      const pluginJson = JSON.parse(
        require('fs').readFileSync(pluginJsonPath, 'utf8')
      );
      pluginJson.extensions = ['./dist/bundle.js'];
      require('fs').writeFileSync(
        pluginJsonPath,
        JSON.stringify(pluginJson, null, 2)
      );
      console.log('✅ Updated openclaw.plugin.json to use bundle');
    }

    // Copy static assets
    const staticFiles = ['templates', 'openclaw.plugin.json'];
    const distDir = 'dist';

    staticFiles.forEach(file => {
      const src = file;
      const dest = join(distDir, file);
      if (existsSync(src) && !existsSync(dest)) {
        if (require('fs').statSync(src).isDirectory()) {
          mkdirSync(dest, { recursive: true });
          require('fs').readdirSync(src).forEach(f => {
            require('fs').copyFileSync(
              join(src, f),
              join(dest, f)
            );
          });
        } else {
          require('fs').copyFileSync(src, dest);
        }
        console.log(`✅ Copied: ${file} -> dist/${file}`);
      }
    });

    console.log('\n🎉 Plugin bundle ready for distribution!');

  } catch (error) {
    console.error('❌ Bundle failed:', error);
    process.exit(1);
  }
}

bundlePlugin();
