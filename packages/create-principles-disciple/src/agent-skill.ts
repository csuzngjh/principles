/**
 * pd-setup bootstrap agent skill — the pre-install knowledge channel.
 *
 * PD's plugin-delivered skills (pd-cli-operator / pd-control, …) only exist
 * AFTER an install; before that, a host agent asked to "install PD" has no
 * PD knowledge at all. This module ships ONE host-neutral bootstrap skill
 * (agent-skill/pd-setup/SKILL.md, part of the create-principles-disciple
 * tarball) and copies it into each host's USER-LEVEL skills directory:
 *
 *   OpenClaw  → ~/.openclaw/skills/pd-setup/SKILL.md
 *   Codex     → ~/.agents/skills/pd-setup/SKILL.md   (agent-ecosystem convention)
 *   WorkBuddy → ~/.workbuddy/skills/pd-setup/SKILL.md
 *
 * Boundaries:
 *  - NOT part of the plugin-delivered skill set: deliberately outside
 *    skill-catalog.json and the 4 delivery directories (bootstrap channel is
 *    owned by the installer, not the plugin payload parity system).
 *  - Never touches a target that is not provably ours (ownership marker);
 *    a foreign file at the target is a REFUSAL, never an overwrite (cli-5).
 *  - Idempotent: identical content → 'unchanged'; ours-but-stale → replaced.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const AGENT_SKILL_NAME = 'pd-setup' as const;
/** Single authority for "this file is ours" — present in the shipped source. */
export const AGENT_SKILL_MARKER = 'pd-agent-skill: pd-setup' as const;

export type AgentSkillHost = 'openclaw' | 'codex' | 'workbuddy';
export const AGENT_SKILL_HOSTS: readonly AgentSkillHost[] = ['openclaw', 'codex', 'workbuddy'];

/** User-level skills root per host (verified conventions, 2026-11-15). */
export function agentSkillRoot(host: AgentSkillHost, homeDir: string = os.homedir()): string {
  switch (host) {
    case 'openclaw': return path.join(homeDir, '.openclaw', 'skills');
    case 'codex': return path.join(homeDir, '.agents', 'skills');
    case 'workbuddy': return path.join(homeDir, '.workbuddy', 'skills');
  }
}

/** Source dir of the shipped skill inside the installer package. */
export function agentSkillSourceDir(pluginDir: string): string {
  return path.join(pluginDir, 'agent-skill', AGENT_SKILL_NAME);
}

export type AgentSkillState =
  | { host: AgentSkillHost; state: 'installed'; path: string; sameContent: boolean }
  | { host: AgentSkillHost; state: 'not_installed'; path: string }
  | { host: AgentSkillHost; state: 'foreign'; path: string; reason: string };

export interface AgentSkillResult {
  success: boolean;
  hosts: readonly {
    host: AgentSkillHost;
    action: 'installed' | 'replaced' | 'unchanged' | 'removed' | 'skipped_not_present' | 'refused';
    path: string;
    reason?: string;
  }[];
  skillSource: string;
  reason?: string;
  nextAction?: string;
}

function readTarget(target: string): string | null {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

function isOurs(content: string | null): boolean {
  return content !== null && content.includes(AGENT_SKILL_MARKER);
}

/** Read-only per-host state. Foreign = someone else's file occupies the slot. */
export function agentSkillStatus(
  hosts: readonly AgentSkillHost[],
  homeDir: string = os.homedir(),
): AgentSkillState[] {
  return hosts.map((host) => {
    const target = path.join(agentSkillRoot(host, homeDir), AGENT_SKILL_NAME, 'SKILL.md');
    const content = readTarget(target);
    if (content === null) return { host, state: 'not_installed' as const, path: target };
    if (!isOurs(content)) {
      return {
        host,
        state: 'foreign' as const,
        path: target,
        reason: 'target exists and is not marked as PD-owned — refusing to touch it',
      };
    }
    return { host, state: 'installed' as const, path: target, sameContent: true };
  });
}

/**
 * Copy the shipped skill into each host's user-level skills dir.
 * Pure filesystem operation outside the install transaction (bootstrap
 * channel): failures are per-host and never roll back sibling hosts.
 */
export function installAgentSkill(input: {
  hosts: readonly AgentSkillHost[];
  pluginDir: string;
  homeDir?: string;
}): AgentSkillResult {
  const homeDir = input.homeDir ?? os.homedir();
  const sourceDir = agentSkillSourceDir(input.pluginDir);
  const sourceFile = path.join(sourceDir, 'SKILL.md');
  const sourceContent = fs.readFileSync(sourceFile, 'utf8');
  if (!isOurs(sourceContent)) {
    return {
      success: false,
      hosts: [],
      skillSource: sourceFile,
      reason: 'shipped agent skill is missing its ownership marker',
      nextAction: 'Reinstall the create-principles-disciple package (npx create-principles-disciple@latest agent-skill install).',
    };
  }

  const hostResults: AgentSkillResult['hosts'][number][] = [];
  let anySuccess = false;
  for (const host of input.hosts) {
    const target = path.join(agentSkillRoot(host, homeDir), AGENT_SKILL_NAME, 'SKILL.md');
    const existing = readTarget(target);
    if (existing !== null && !isOurs(existing)) {
      hostResults.push({
        host,
        action: 'refused',
        path: target,
        reason: 'target exists and is not marked as PD-owned — inspect it, then remove/rename it and re-run',
      });
      continue;
    }
    if (existing === sourceContent) {
      hostResults.push({ host, action: 'unchanged', path: target });
      anySuccess = true;
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, sourceContent, 'utf8');
      hostResults.push({ host, action: existing === null ? 'installed' : 'replaced', path: target });
      anySuccess = true;
    } catch (err) {
      hostResults.push({
        host,
        action: 'refused',
        path: target,
        reason: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    success: anySuccess,
    hosts: hostResults,
    skillSource: sourceFile,
    ...(anySuccess ? {} : {
      reason: 'no host could be provisioned',
      nextAction: 'Check the per-host reasons; fix the skills directory permissions/ownership and re-run.',
    }),
  };
}

/** Remove the skill from each host — only when the target is provably ours. */
export function uninstallAgentSkill(input: {
  hosts: readonly AgentSkillHost[];
  homeDir?: string;
}): AgentSkillResult {
  const homeDir = input.homeDir ?? os.homedir();
  const hostResults: AgentSkillResult['hosts'][number][] = [];
  let anyAction = false;
  for (const host of input.hosts) {
    const target = path.join(agentSkillRoot(host, homeDir), AGENT_SKILL_NAME, 'SKILL.md');
    const existing = readTarget(target);
    if (existing === null) {
      hostResults.push({ host, action: 'skipped_not_present', path: target });
      continue;
    }
    if (!isOurs(existing)) {
      hostResults.push({
        host,
        action: 'refused',
        path: target,
        reason: 'target exists and is not marked as PD-owned — not removed',
      });
      continue;
    }
    try {
      fs.rmSync(path.dirname(target), { recursive: true, force: true });
      hostResults.push({ host, action: 'removed', path: target });
      anyAction = true;
    } catch (err) {
      hostResults.push({
        host,
        action: 'refused',
        path: target,
        reason: `remove failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return {
    success: true,
    hosts: hostResults,
    skillSource: path.join(agentSkillSourceDir('.'), 'SKILL.md'),
    ...(anyAction ? {} : { reason: 'nothing installed anywhere' }),
  };
}
