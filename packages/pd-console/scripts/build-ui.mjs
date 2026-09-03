import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import autoprefixer from "autoprefixer";

const isProduction = process.argv.includes("--production");
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "dist", "web");
const assetsDir = path.join(outDir, "assets");

mkdirSync(assetsDir, { recursive: true });

const cssInput = path.join(rootDir, "src", "ui", "styles", "globals.css");
const cssOutput = path.join(assetsDir, "app.css");

// Step 1: esbuild bundles JS (may also emit a minimal CSS from @fontsource imports)
await build({
  entryPoints: [path.join(rootDir, "src", "ui", "main.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile: path.join(assetsDir, "app.js"),
  sourcemap: isProduction ? false : "inline",
  minify: isProduction,
  jsx: "automatic",
  external: [],
  loader: {
    ".woff": "file",
    ".woff2": "file",
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(isProduction ? "production" : "development"),
    "import.meta.env.DEV": JSON.stringify(!isProduction),
    "import.meta.env.PROD": JSON.stringify(isProduction),
  },
});

// Step 2: PostCSS/Tailwind overwrites the CSS (must run AFTER esbuild, which
// may emit a minimal app.css from @fontsource imports that would otherwise clobber Tailwind output)
const cssContent = readFileSync(cssInput, "utf8");
const result = await postcss([tailwindcss(), autoprefixer()]).process(cssContent, {
  from: cssInput,
  to: cssOutput,
});
writeFileSync(cssOutput, result.css, "utf8");
console.log("Processed Tailwind CSS (" + result.css.length + " bytes)");

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PD Console</title>
    <!-- Same PD mark the runtime favicon badge draws on canvas (favicon-badge.ts);
         without a static link the browser requests /favicon.ico and logs a 404
         before the app JS mounts. -->
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%231a1a1a'/%3E%3Ctext x='16' y='17' font-family='sans-serif' font-size='14' font-weight='bold' fill='%23d4a853' text-anchor='middle' dominant-baseline='central'%3EPD%3C/text%3E%3C/svg%3E" />
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>
`;

writeFileSync(path.join(outDir, "index.html"), html, "utf8");
console.log("Built UI to dist/web/");
