import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const isProduction = process.argv.includes("--production");
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "dist", "web");
const assetsDir = path.join(outDir, "assets");

mkdirSync(assetsDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "ui", "src", "main.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile: path.join(assetsDir, "app.js"),
  sourcemap: isProduction ? false : "inline",
  minify: isProduction,
  jsx: "automatic",
  loader: {
    ".css": "css",
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(isProduction ? "production" : "development"),
  },
});

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Principles Console</title>
    <link rel="stylesheet" href="/plugins/principles/assets/app.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/plugins/principles/assets/app.js"></script>
  </body>
</html>
`;

writeFileSync(path.join(outDir, "index.html"), html, "utf8");
