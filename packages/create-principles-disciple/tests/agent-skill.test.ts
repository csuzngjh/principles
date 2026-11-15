/**
 * pd-setup bootstrap agent skill — unit contract + CLI wiring.
 *
 * Unit: install/idempotence/ownership-refusal/uninstall against a temp HOME
 * (the exported functions take homeDir — same seam as the host installers).
 * CLI: exec the BUILT entry (cli-7 real registration) with a redirected
 * USERPROFILE/HOME so nothing touches the real user dirs.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  AGENT_SKILL_HOSTS,
  agentSkillStatus,
  installAgentSkill,
  uninstallAgentSkill,
  agentSkillRoot,
} from '../src/agent-skill.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const CLI_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'index.js');

function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-agent-skill-'));
  return (async () => {
    try {
      return await fn(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })();
}

describe('agent-skill unit contract', () => {
  it('installs the shipped skill into all three hosts and reports installed', async () => {
    await withHome(async (home) => {
      const result = installAgentSkill({ hosts: [...AGENT_SKILL_HOSTS], pluginDir: PACKAGE_ROOT, homeDir: home });
      expect(result.success).toBe(true);
      expect(result.hosts).toHaveLength(3);
      for (const host of AGENT_SKILL_HOSTS) {
        const entry = result.hosts.find((r) => r.host === host);
        expect(entry?.action).toBe('installed');
        const target = path.join(agentSkillRoot(host, home), 'pd-setup', 'SKILL.md');
        const content = fs.readFileSync(target, 'utf8');
        expect(content).toContain('pd-agent-skill: pd-setup');
        expect(content).toContain('npx create-principles-disciple');
        expect(content).toContain('pd mcp probe');
      }
      const status = agentSkillStatus([...AGENT_SKILL_HOSTS], home);
      expect(status.every((s) => s.state === 'installed')).toBe(true);
    });
  });

  it('is idempotent: a second install reports unchanged and rewrites nothing', async () => {
    await withHome(async (home) => {
      installAgentSkill({ hosts: ['codex'], pluginDir: PACKAGE_ROOT, homeDir: home });
      const target = path.join(agentSkillRoot('codex', home), 'pd-setup', 'SKILL.md');
      const first = fs.readFileSync(target, 'utf8');
      const before = fs.statSync(target).mtimeMs;
      const result = installAgentSkill({ hosts: ['codex'], pluginDir: PACKAGE_ROOT, homeDir: home });
      expect(result.hosts[0]?.action).toBe('unchanged');
      expect(fs.readFileSync(target, 'utf8')).toBe(first);
      expect(fs.statSync(target).mtimeMs).toBe(before);
    });
  });

  it('REFUSES a foreign file at the target and never overwrites it (cli-5)', async () => {
    await withHome(async (home) => {
      const target = path.join(agentSkillRoot('openclaw', home), 'pd-setup', 'SKILL.md');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'someone else\'s skill — no PD marker\n');
      const result = installAgentSkill({ hosts: ['openclaw'], pluginDir: PACKAGE_ROOT, homeDir: home });
      expect(result.hosts[0]?.action).toBe('refused');
      expect(result.hosts[0]?.reason).toContain('not marked as PD-owned');
      // The foreign file is intact.
      expect(fs.readFileSync(target, 'utf8')).toContain('someone else\'s skill');
      const status = agentSkillStatus(['openclaw'], home);
      expect(status[0]?.state).toBe('foreign');
    });
  });

  it('replaces a stale copy that IS ours (marker-gated upgrade)', async () => {
    await withHome(async (home) => {
      const target = path.join(agentSkillRoot('workbuddy', home), 'pd-setup', 'SKILL.md');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '<!-- pd-agent-skill: pd-setup -->\nold version\n');
      const result = installAgentSkill({ hosts: ['workbuddy'], pluginDir: PACKAGE_ROOT, homeDir: home });
      expect(result.hosts[0]?.action).toBe('replaced');
      expect(fs.readFileSync(target, 'utf8')).toContain('npx create-principles-disciple');
    });
  });

  it('uninstall removes only our skill and reports skips/refusals honestly', async () => {
    await withHome(async (home) => {
      installAgentSkill({ hosts: ['codex', 'openclaw'], pluginDir: PACKAGE_ROOT, homeDir: home });
      const foreignTarget = path.join(agentSkillRoot('openclaw', home), 'pd-setup', 'SKILL.md');
      fs.writeFileSync(foreignTarget, 'foreign now\n');
      const result = uninstallAgentSkill({ hosts: ['codex', 'openclaw', 'workbuddy'], homeDir: home });
      const codex = result.hosts.find((r) => r.host === 'codex');
      const openclaw = result.hosts.find((r) => r.host === 'openclaw');
      const workbuddy = result.hosts.find((r) => r.host === 'workbuddy');
      expect(codex?.action).toBe('removed');
      expect(fs.existsSync(path.join(agentSkillRoot('codex', home), 'pd-setup'))).toBe(false);
      expect(openclaw?.action).toBe('refused');
      expect(fs.readFileSync(foreignTarget, 'utf8')).toBe('foreign now\n');
      expect(workbuddy?.action).toBe('skipped_not_present');
    });
  });

  it('fails loud when the shipped source is missing its ownership marker', async () => {
    await withHome(async (home) => {
      const badPluginDir = fs.mkdtempSync(path.join(home, 'bad-pkg-'));
      fs.mkdirSync(path.join(badPluginDir, 'agent-skill', 'pd-setup'), { recursive: true });
      fs.writeFileSync(path.join(badPluginDir, 'agent-skill', 'pd-setup', 'SKILL.md'), 'no marker here\n');
      const result = installAgentSkill({ hosts: ['codex'], pluginDir: badPluginDir, homeDir: home });
      expect(result.success).toBe(false);
      expect(result.reason).toContain('ownership marker');
      expect(result.nextAction).toBeTruthy();
    });
  });
});

describe('agent-skill CLI wiring (cli-7, real built entry)', () => {
  function runCli(args: string[], home: string): { stdout: string; exitStatus: number } {
    try {
      const stdout = execFileSync(process.execPath, [CLI_ENTRY, ...args], {
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: home, HOME: home },
      });
      return { stdout, exitStatus: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      return { stdout: e.stdout ?? '', exitStatus: e.status ?? 1 };
    }
  }

  it('status --json reports per-host state against the redirected home', async () => {
    await withHome(async (home) => {
      const { stdout, exitStatus } = runCli(['agent-skill', 'status', '--json'], home);
      expect(exitStatus).toBe(0);
      const payload = JSON.parse(stdout) as { hosts: Array<{ host: string; state: string; path: string }> };
      expect(payload.hosts.map((h) => h.host).sort()).toEqual(['codex', 'openclaw', 'workbuddy']);
      expect(payload.hosts.every((h) => h.state === 'not_installed')).toBe(true);
      expect(payload.hosts[0]?.path).toContain(home);
    });
  });

  it('install --host codex --json installs exactly one host, then uninstall removes it', async () => {
    await withHome(async (home) => {
      const install = runCli(['agent-skill', 'install', '--host', 'codex', '--json'], home);
      expect(install.exitStatus).toBe(0);
      const installed = JSON.parse(install.stdout) as { success: boolean; hosts: Array<{ host: string; action: string }> };
      expect(installed.success).toBe(true);
      expect(installed.hosts).toHaveLength(1);
      expect(installed.hosts[0]?.action).toBe('installed');
      expect(fs.existsSync(path.join(home, '.agents', 'skills', 'pd-setup', 'SKILL.md'))).toBe(true);

      const uninstall = runCli(['agent-skill', 'uninstall', '--host', 'codex', '--json'], home);
      expect(uninstall.exitStatus).toBe(0);
      expect(fs.existsSync(path.join(home, '.agents', 'skills', 'pd-setup'))).toBe(false);
    });
  });

  it('rejects an unknown --host with one JSON doc and a non-zero exit (cli-1/cli-2)', async () => {
    await withHome(async (home) => {
      const { stdout, exitStatus } = runCli(['agent-skill', 'install', '--host', 'bogus', '--json'], home);
      expect(exitStatus).toBe(1);
      const payload = JSON.parse(stdout) as { success: boolean; reason: string; nextAction: string };
      expect(payload.success).toBe(false);
      expect(payload.reason).toContain('invalid_host');
      expect(payload.nextAction).toBeTruthy();
    });
  });
});
