import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const myagentsRoot = path.join(repoRoot, "myagents");
const governanceRoot = path.join(myagentsRoot, "shared", "governance");
const targets = ["main", "pm", "resource-scout", "repair", "verification"];

async function removeIfExists(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function writeReadme(agentDir) {
  const readmePath = path.join(agentDir, ".team", "README.md");
  const content = [
    "# .team",
    "",
    "This directory is a materialized local copy of shared governance files.",
    "Do not edit here first. Edit `myagents/shared/governance/` and re-run the materialize script.",
    "",
    "Source root:",
    "- `myagents/shared/governance/`",
    "",
    "Shared skills should be installed into the OpenClaw managed skills directory",
    "(normally `~/.openclaw/skills/`) instead of being copied into `.team`.",
    "",
  ].join("\n");
  await fs.writeFile(readmePath, content, "utf8");
}

async function main() {
  for (const target of targets) {
    const agentDir = path.join(myagentsRoot, target);
    const teamDir = path.join(agentDir, ".team");
    await removeIfExists(teamDir);
    await copyDir(governanceRoot, path.join(teamDir, "governance"));
    await writeReadme(agentDir);
    console.log(`materialized .team for ${target}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
