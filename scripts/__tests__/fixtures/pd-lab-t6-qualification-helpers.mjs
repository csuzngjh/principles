/**
 * PRI-1258 / PD-Lab v0.3 T7a — subprocess driver for the REAL t6-qualify
 * CLI (the `npm run lab:qualify` script). Command position is the literal
 * interpreter; all inputs go as argv (argv-array command form, same
 * discipline as the admission-probe helpers).
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
export const SCRIPT = path.join(
  REPO_ROOT,
  "scripts",
  "dev",
  "pd-lab",
  "t6-qualify.mjs",
);

export function runQualifyCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    cwd: REPO_ROOT,
  });
}
