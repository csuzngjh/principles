/**
 * Test helper: seed a minimal but VALID isolated PD home for worker-command
 * tests (PRI-1278 Phase 5). Since the consumer-safety substrate, every
 * consuming worker cycle evaluates the §8.4 ownership projection from the
 * install manifest — a missing/corrupt manifest fails closed. Production
 * always has `~/.pd/install.json`, so tests that exercise consuming paths
 * must seed one too; a workspace with no ownership record projects
 * `legacy_owned` (the pre-service-host default) and consumes exactly as
 * before.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function seedIsolatedPdHome(pdHome: string, workspaces: string[] = []): void {
  fs.mkdirSync(pdHome, { recursive: true });
  const payload = {
    layoutVersion: 1,
    mode: 'canonical',
    hosts: ['codex', 'workbuddy', 'openclaw'],
    workspaces,
  };
  fs.writeFileSync(path.join(pdHome, 'install.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

/** Create a fresh temp PD home with a valid manifest; caller owns cleanup (or pairs with fs.rmSync). */
export function makeIsolatedPdHome(prefix: string, workspaces: string[] = []): string {
  const pdHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  seedIsolatedPdHome(pdHome, workspaces);
  return pdHome;
}
