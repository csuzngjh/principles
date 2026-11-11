/**
 * Legacy WorkBuddy user-level skill retirement
 * (SPEC-PD-AGENT-PAIN-INGRESS-001 §5.5 / TECHNICAL-DESIGN §7.4).
 *
 * PD stopped shipping a user-level `pd-record-pain` skill; pain raised by an
 * agent is now ingested through the governed host path. Old machines still
 * carry `~/.workbuddy/skills/pd-record-pain/SKILL.md`, which keeps telling
 * agents to write pain through the retired channel.
 *
 * Rules this module implements — and the reasons each one exists:
 *
 * 1. Detection is path + frontmatter `name`. A directory that happens to be
 *    called `pd-record-pain` but declares a different skill name is the
 *    Owner's own skill; it is never touched and never reported.
 * 2. Only a copy whose bytes match a PUBLISHED skill payload may be renamed.
 *    The published payload hashes below are derived from this repository's
 *    git history (the exact blobs PD used to ship), so "unmodified" is proven
 *    rather than assumed.
 * 3. A copy that does not match any published payload is left in place with a
 *    structured `deprecated_skill_modified` warning. Silent overwrite or
 *    deletion of Owner-modified files is forbidden (SPEC §5.5, AGENTS §18).
 * 4. Renaming is idempotent: once `SKILL.md.deprecated-<label>` exists the
 *    skill directory is reported as already retired and is not touched again.
 * 5. Nothing is deleted. The renamed file stays next to the original with a
 *    suffix that keeps it out of skill discovery.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import * as path from 'node:path';

export const LEGACY_WORKBUDDY_SKILL_DIR = 'pd-record-pain';
export const LEGACY_WORKBUDDY_SKILL_FILE = 'SKILL.md';

export interface PublishedLegacyWorkbuddySkill {
  /** Value used in the `SKILL.md.deprecated-<label>` suffix. */
  readonly label: string;
  /** SHA-256 of the exact bytes PD shipped. */
  readonly sha256: string;
  /** Where the bytes come from, so the hash can be re-verified. */
  readonly provenance: string;
}

/**
 * Every `pd-record-pain/SKILL.md` payload this repository has ever shipped,
 * recovered from git history (`git cat-file blob <blob>`). Both entries were
 * deleted in 5c383e572 ("refactor(skills): unify PD host skill capabilities").
 */
export const PUBLISHED_LEGACY_WORKBUDDY_SKILLS: readonly PublishedLegacyWorkbuddySkill[] = [
  {
    label: '0.1.1-openclaw',
    sha256: 'beb758bd66c6e330ff18bb751136a276d98486d85876b4488d09551b672d8186',
    provenance: 'plugins/principles-disciple/skills/pd-record-pain/SKILL.md @ plugin 0.1.1 (blob 7df4717)',
  },
  {
    label: '0.1.0-workbuddy',
    sha256: 'f2eee21234250bf530a81579f033cda4fa41c0728bc81536320774127bd2d6e6',
    provenance: 'packages/workbuddy-adapter/plugin/skills/pd-record-pain/SKILL.md @ plugin 0.1.0 (blob 7338fe8)',
  },
];

export type LegacyWorkbuddySkillState =
  | { readonly status: 'absent'; readonly path: string }
  | { readonly status: 'already_deprecated'; readonly path: string; readonly deprecatedPath: string }
  | {
      readonly status: 'deprecated';
      readonly path: string;
      readonly deprecatedPath: string;
      readonly label: string;
    }
  | {
      readonly status: 'modified';
      readonly path: string;
      readonly sha256: string;
      readonly nextAction: string;
    };

export interface LegacyWorkbuddySkillOutcome {
  readonly state: LegacyWorkbuddySkillState;
  /** Operator-facing lines for the install summary. Empty when nothing to say. */
  readonly warnings: readonly string[];
}

function frontmatterName(content: string): string | undefined {
  // Minimal, format-only parse: the skill frontmatter is a leading `---` block
  // of `key: value` lines. We only need `name`, and a missing block is a
  // non-match (rc-3: never guess a skill identity from the directory name).
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') return undefined;
    const match = /^name:\s*(.*)$/.exec(line);
    if (match !== null) return match[1]?.trim().replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function skillDir(configDir: string): string {
  return path.join(configDir, 'skills', LEGACY_WORKBUDDY_SKILL_DIR);
}

/**
 * Read-only inspection. Never renames, never deletes.
 *
 * `published` is injectable so the rename branch can be exercised against a
 * fixture; production callers always use the shipped registry.
 */
export function inspectLegacyWorkbuddySkill(
  options: { configDir: string; published?: readonly PublishedLegacyWorkbuddySkill[] },
): LegacyWorkbuddySkillState {
  const publishedVersions = options.published ?? PUBLISHED_LEGACY_WORKBUDDY_SKILLS;
  const dir = skillDir(options.configDir);
  const skillPath = path.join(dir, LEGACY_WORKBUDDY_SKILL_FILE);

  if (!existsSync(skillPath)) {
    // Idempotency: a previously retired copy leaves only the suffixed file.
    let deprecatedPath: string | undefined;
    if (existsSync(dir)) {
      const suffix = `${LEGACY_WORKBUDDY_SKILL_FILE}.deprecated-`;
      const retired = readdirSync(dir).find((entry) => entry.startsWith(suffix));
      if (retired !== undefined) deprecatedPath = path.join(dir, retired);
    }
    return deprecatedPath === undefined
      ? { status: 'absent', path: skillPath }
      : { status: 'already_deprecated', path: skillPath, deprecatedPath };
  }

  const bytes = readFileSync(skillPath);
  if (frontmatterName(bytes.toString('utf8')) !== LEGACY_WORKBUDDY_SKILL_DIR) {
    // Same directory name, different declared skill: not ours to retire.
    return { status: 'absent', path: skillPath };
  }

  const digest = sha256Of(bytes);
  const published = publishedVersions.find((entry) => entry.sha256 === digest);
  if (published === undefined) {
    return {
      status: 'modified',
      path: skillPath,
      sha256: digest,
      nextAction:
        `This skill is no longer shipped by PD, but its content does not match any published version, ` +
        `so it was left untouched. Review it, then delete ${dir} yourself if you did not customise it.`,
    };
  }
  return {
    status: 'deprecated',
    path: skillPath,
    deprecatedPath: `${skillPath}.deprecated-${published.label}`,
    label: published.label,
  };
}

/**
 * Retire the legacy user-level skill when it is provably an unmodified PD
 * payload. Safe to run on every install/upgrade: absent, already-retired and
 * Owner-modified states are all no-ops.
 */
export function deprecateLegacyWorkbuddySkill(
  options: { configDir: string; published?: readonly PublishedLegacyWorkbuddySkill[] },
): LegacyWorkbuddySkillOutcome {
  const state = inspectLegacyWorkbuddySkill(options);

  if (state.status === 'modified') {
    return {
      state,
      warnings: [
        'WARNING [deprecated_skill_modified]: a retired user-level skill "pd-record-pain" was found but NOT modified ' +
          `(${state.path}, sha256 ${state.sha256.slice(0, 12)}…) — its content matches no published version.`,
        `         ${state.nextAction}`,
      ],
    };
  }

  if (state.status !== 'deprecated') {
    return { state, warnings: [] };
  }

  try {
    if (existsSync(state.deprecatedPath)) {
      // Another published label already retired this directory. Keep both; the
      // live SKILL.md is still the one the host would load, so report it.
      return {
        state,
        warnings: [
          `WARNING [legacy_skill_rename_failed]: retired skill "pd-record-pain" could not be renamed because ${state.deprecatedPath} already exists.`,
          `         Move or delete ${state.path} yourself; skill discovery still sees it.`,
        ],
      };
    }
    renameSync(state.path, state.deprecatedPath);
  } catch (error) {
    return {
      state,
      warnings: [
        `WARNING [legacy_skill_rename_failed]: retired skill "pd-record-pain" could not be renamed (${error instanceof Error ? error.message : String(error)}).`,
        `         Delete ${state.path} yourself; skill discovery still sees it.`,
      ],
    };
  }

  return {
    state,
    warnings: [
      `Retired the obsolete user-level skill "pd-record-pain" (renamed to ${path.basename(state.deprecatedPath)}).`,
    ],
  };
}
