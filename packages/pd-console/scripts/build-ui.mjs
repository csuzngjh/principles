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
  entryPoints: [path.join(rootDir, "src", "ui", "main.tsx")],
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
    <title>PD Console</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>
`;

writeFileSync(path.join(outDir, "index.html"), html, "utf8");
console.log("Built UI to dist/web/");
