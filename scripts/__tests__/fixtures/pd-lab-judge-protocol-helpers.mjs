/**
 * PRI-1258 / PD-Lab v0.3 T7a-judge — subprocess + bundle fixtures.
 *
 * Subprocess driver for the REAL judge-protocol-validate CLI (the `npm run
 * lab:judge-validate` script). Command position is the literal interpreter;
 * all inputs go as argv (argv-array command form, same discipline as the
 * admission-probe helpers).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
export const SCRIPT = path.join(
  REPO_ROOT,
  "scripts",
  "dev",
  "pd-lab",
  "judge-protocol-validate.mjs",
);

export function runValidateCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    cwd: REPO_ROOT,
  });
}
