/**
 * Legacy WorkBuddy user-level skill retirement
 * (SPEC-PD-AGENT-PAIN-INGRESS-001 §5.5 / TECHNICAL-DESIGN §7.4).
 *
 * PD no longer ships ANY user-level skill: the four active capabilities live
 * inside the plugin payload, and pain raised by an agent is ingested through
 * the governed host path. Older installs, however, left several retired
 * skills behind in `~/.workbuddy/skills/`:
 *
 *  - `pd-record-pain` — wrote pain through a retired, ungoverned channel;
 *  - `pd-status` / `pd-setup` / `pd-disable` — Codex-era skills that point
 *    at `~/.codex/plugins/cache/`, `host.codex` and Codex `/hooks`;
 *  - `pd-review` (pre-unification payload) — competes by directory name with
 *    the plugin's CURRENT `pd-review`, so the host may load the stale one.
 *
 * The last four were deleted/rewritten by 5c383e572 ("refactor(skills):
 * unify PD host skill capabilities", 2026-10-22) but were never added to the
 * retirement registry, so every later install/upgrade left them in place.
 * This module now retires all of them under the same preservation-first rules.
 *
 * Rules this module implements — and the reasons each one exists:
 *
 * 1. Detection is path + frontmatter `name`. A directory that happens to be
 *    called like a retired skill but declares a different name is the
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

export const LEGACY_WORKBUDDY_SKILL_FILE = 'SKILL.md';

export interface PublishedLegacyWorkbuddySkill {
  /** Value used in the `SKILL.md.deprecated-<label>` suffix. */
  readonly label: string;
  /** SHA-256 of the exact bytes PD shipped. */
  readonly sha256: string;
  /** Where the bytes come from, so the hash can be re-verified. */
  readonly provenance: string;
}

export interface LegacyWorkbuddySkillEntry {
  /** Directory under `<configDir>/skills/`; also the frontmatter `name`. */
  readonly dir: string;
  /** Every retired `SKILL.md` payload PD published for this skill. */
  readonly published: readonly PublishedLegacyWorkbuddySkill[];
}

/**
 * Every user-level PD skill payload this repository has ever shipped and
 * later retired, recovered from git history (`git cat-file blob <blob>`).
 *
 * Only blobs published BEFORE 5c383e572 are listed for `pd-review`: the
 * post-unification payloads are still shipped inside the plugin and must
 * never be retired, even if an Owner copied one into the user-level dir.
 */
export const LEGACY_WORKBUDDY_SKILL_ENTRIES: readonly LegacyWorkbuddySkillEntry[] = [
  {
    dir: 'pd-record-pain',
    published: [
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
    ],
  },
  {
    dir: 'pd-status',
    published: [
      {
        label: 'codex-2026-09-23',
        sha256: '853d5f8de9996239dbfc4d1fca27f5e96cd852cf1b8deea0c1cb8d1655800126',
        provenance: 'plugins/principles-disciple/skills/pd-status/SKILL.md @ 42f0f4a7',
      },
      {
        label: 'workbuddy-2026-10-17',
        sha256: '0b9b3bc6e730b4d9244522f9b9bc5a7ce27f29a82ec9ff432105ab21ae3573e0',
        provenance: 'packages/workbuddy-adapter/plugin/skills/pd-status/SKILL.md @ b02ebb53',
      },
    ],
  },
  {
    dir: 'pd-setup',
    published: [
      {
        label: 'codex-2026-08-14',
        sha256: 'bf4ad63c94a692c0264b357659a0b8db3acddcc26ac190f2a5dd81e04501b9ab',
        provenance: 'plugins/principles-disciple/skills/pd-setup/SKILL.md @ 03747736',
      },
      {
        label: 'codex-2026-09-23',
        sha256: 'fd1dbd26d0dc87e201a89bf2790cbe136a93921a62e45bca428037ef1ecf1bfa',
        provenance: 'plugins/principles-disciple/skills/pd-setup/SKILL.md @ 42f0f4a7',
      },
      {
        label: 'codex-2026-10-05',
        sha256: '8d6eae4df8b311c37e86788bc5487a5b692970573334f5b890ee6fd452f20502',
        provenance: 'plugins/principles-disciple/skills/pd-setup/SKILL.md @ cee2304f',
      },
    ],
  },
  {
    dir: 'pd-disable',
    published: [
      {
        label: 'codex-2026-09-23',
        sha256: '590769fcf93d60389346e001ce8a76c2157976f5d38035523f3807ffc2477f8e',
        provenance: 'plugins/principles-disciple/skills/pd-disable/SKILL.md @ 42f0f4a7',
      },
      {
        label: 'workbuddy-2026-10-17',
        sha256: '25172b5f67503c07cf31e06dc6092796fc277faad6f8746ce9595bf951294f86',
        provenance: 'packages/workbuddy-adapter/plugin/skills/pd-disable/SKILL.md @ b02ebb53',
      },
    ],
  },
  {
    dir: 'pd-review',
    published: [
      {
        label: 'codex-2026-09-23',
        sha256: '18665f1a8e0d5a34ab245859cc34f08c56c8946648274e870e95d1642e331b74',
        provenance: 'plugins/principles-disciple/skills/pd-review/SKILL.md @ 42f0f4a7 (pre-unification)',
      },
      {
        label: 'workbuddy-2026-10-17',
        sha256: '635fa9c7aa232cacd356bb25dc7e1c1c00305786fdcc930d03257edbeea0216e',
        provenance: 'packages/workbuddy-adapter/plugin/skills/pd-review/SKILL.md @ b02ebb53 (pre-unification)',
      },
    ],
  },
];

/** Kept for backwards compatibility with the single-skill callers/tests. */
export const LEGACY_WORKBUDDY_SKILL_DIR = 'pd-record-pain';

/** Kept for backwards compatibility: the `pd-record-pain` payloads. */
export const PUBLISHED_LEGACY_WORKBUDDY_SKILLS: readonly PublishedLegacyWorkbuddySkill[] =
  LEGACY_WORKBUDDY_SKILL_ENTRIES.find((entry) => entry.dir === LEGACY_WORKBUDDY_SKILL_DIR)?.published ?? [];

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
    }
  | {
      /** Inspection itself failed (EACCES / EISDIR / EPERM). Never fatal. */
      readonly status: 'inspection_failed';
      readonly path: string;
      readonly reason: string;
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

function publishedForSkill(dirName: string): readonly PublishedLegacyWorkbuddySkill[] {
  return LEGACY_WORKBUDDY_SKILL_ENTRIES.find((entry) => entry.dir === dirName)?.published ?? [];
}

function skillDir(configDir: string, dirName: string): string {
  return path.join(configDir, 'skills', dirName);
}

export interface LegacyWorkbuddySkillOptions {
  readonly configDir: string;
  /** Defaults to `pd-record-pain` for backwards compatibility. */
  readonly skillDir?: string;
  /** Injectable so the rename branch can be exercised against a fixture. */
  readonly published?: readonly PublishedLegacyWorkbuddySkill[];
}

/**
 * Read-only inspection. Never renames, never deletes.
 *
 * Production callers always use the shipped registry for `skillDir`.
 */
export function inspectLegacyWorkbuddySkill(
  options: LegacyWorkbuddySkillOptions,
): LegacyWorkbuddySkillState {
  const dirName = options.skillDir ?? LEGACY_WORKBUDDY_SKILL_DIR;
  const publishedVersions = options.published ?? publishedForSkill(dirName);
  const dir = skillDir(options.configDir, dirName);
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
  if (frontmatterName(bytes.toString('utf8')) !== dirName) {
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
 * Retire ONE legacy user-level skill when it is provably an unmodified PD
 * payload. Safe to run on every install/upgrade: absent, already-retired and
 * Owner-modified states are all no-ops.
 */
export function deprecateLegacyWorkbuddySkill(
  options: LegacyWorkbuddySkillOptions,
): LegacyWorkbuddySkillOutcome {
  const dirName = options.skillDir ?? LEGACY_WORKBUDDY_SKILL_DIR;
  // Retirement runs AFTER the installer has already committed the plugin
  // registration and the config, so an inspection throw here would make a
  // successful install report failure. One unreadable entry (EISDIR on a
  // `SKILL.md` directory, EACCES/EISDIR on a locked file) is isolated into a
  // warning and the caller keeps going — including the aggregate loop.
  let state: LegacyWorkbuddySkillState;
  try {
    state = inspectLegacyWorkbuddySkill({ ...options, skillDir: dirName });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      state: {
        status: 'inspection_failed',
        path: path.join(skillDir(options.configDir, dirName), LEGACY_WORKBUDDY_SKILL_FILE),
        reason,
      },
      warnings: [
        `WARNING [legacy_skill_inspection_failed]: the retired skill "${dirName}" could not be inspected (${reason}).`,
        `         It was left untouched; skill discovery may still load it. Fix permissions or delete the directory yourself.`,
      ],
    };
  }

  if (state.status === 'modified') {
    return {
      state,
      warnings: [
        'WARNING [deprecated_skill_modified]: a retired user-level skill ' +
          `"${dirName}" was found but NOT modified ` +
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
          `WARNING [legacy_skill_rename_failed]: retired skill "${dirName}" could not be renamed because ${state.deprecatedPath} already exists.`,
          `         Move or delete ${state.path} yourself; skill discovery still sees it.`,
        ],
      };
    }
    renameSync(state.path, state.deprecatedPath);
  } catch (error) {
    return {
      state,
      warnings: [
        `WARNING [legacy_skill_rename_failed]: retired skill "${dirName}" could not be renamed (${error instanceof Error ? error.message : String(error)}).`,
        `         Delete ${state.path} yourself; skill discovery still sees it.`,
      ],
    };
  }

  return {
    state,
    warnings: [
      `Retired the obsolete user-level skill "${dirName}" (renamed to ${path.basename(state.deprecatedPath)}).`,
    ],
  };
}

export interface LegacyWorkbuddySkillsOutcome {
  readonly outcomes: readonly LegacyWorkbuddySkillOutcome[];
  readonly warnings: readonly string[];
}

/**
 * Retire EVERY registered legacy user-level skill. This is the production
 * entry point for install/upgrade: one retired skill must not mask the others.
 *
 * `entries` is injectable so tests can exercise the loop without touching the
 * shipped registry; production callers always use the registry.
 */
export function deprecateAllLegacyWorkbuddySkills(
  options: { configDir: string; entries?: readonly LegacyWorkbuddySkillEntry[] },
): LegacyWorkbuddySkillsOutcome {
  const entries = options.entries ?? LEGACY_WORKBUDDY_SKILL_ENTRIES;
  const outcomes = entries.map((entry) =>
    deprecateLegacyWorkbuddySkill({
      configDir: options.configDir,
      skillDir: entry.dir,
      published: entry.published,
    }),
  );
  return {
    outcomes,
    warnings: outcomes.flatMap((outcome) => outcome.warnings),
  };
}
