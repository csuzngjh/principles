export type SurfaceKind = 'hook' | 'service' | 'startup';
export type MvpCategory = 'core' | 'quiet' | 'gone' | 'legacy_retire';

export const VALID_SURFACE_KINDS: readonly SurfaceKind[] = ['hook', 'service', 'startup'];
export const VALID_MVP_CATEGORIES: readonly MvpCategory[] = ['core', 'quiet', 'gone', 'legacy_retire'];

export interface PluginSurfaceEntry {
  id: string;
  kind: SurfaceKind;
  category: MvpCategory;
  enabledByDefault: boolean;
  since: string;
  description: string;
  disabledReason?: string;
}

export interface SurfaceRegistryValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export const PLUGIN_SURFACE_REGISTRY: readonly PluginSurfaceEntry[] = [
  {
    id: 'hook:before_prompt_build',
    kind: 'hook',
    category: 'core',
    enabledByDefault: true,
    since: '2026-05-24',
    description: 'Principle injection + workspace init on prompt build',
  },
  {
    id: 'hook:before_tool_call',
    kind: 'hook',
    category: 'core',
    enabledByDefault: true,
    since: '2026-05-24',
    description: 'Security gate for tool calls (risk assessment, plan approval)',
  },
  {
    id: 'hook:after_tool_call',
    kind: 'hook',
    category: 'core',
    enabledByDefault: true,
    since: '2026-05-24',
    description: 'Pain detection + empathy observer on tool call result',
  },
  {
    id: 'hook:llm_output',
    kind: 'hook',
    category: 'core',
    enabledByDefault: true,
    since: '2026-05-24',
    description: 'LLM output analysis for pain signal extraction',
  },
  {
    id: 'hook:subagent_spawning',
    kind: 'hook',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Shadow routing observation on subagent spawn',
    disabledReason: 'Disabled by default: shadow observation is opt-in; default off per ADR-0014 §2.5 (preserved in plugin code, not active in production).',
  },
  {
    id: 'hook:subagent_ended',
    kind: 'hook',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Shadow observation completion on subagent end',
    disabledReason: 'Disabled by default: shadow observation is opt-in; default off per ADR-0014 §2.5 (preserved in plugin code, not active in production).',
  },
  {
    id: 'hook:before_reset',
    kind: 'hook',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Lifecycle hook for context reset',
    disabledReason: 'Disabled by default: lifecycle hooks are opt-in; default off per ADR-0014 §2.5 (preserved in plugin code, not active in production).',
  },
  {
    id: 'hook:before_compaction',
    kind: 'hook',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Lifecycle hook for before compaction',
    disabledReason: 'Disabled by default: lifecycle hooks are opt-in; default off per ADR-0014 §2.5 (preserved in plugin code, not active in production).',
  },
  {
    id: 'hook:after_compaction',
    kind: 'hook',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Lifecycle hook for after compaction',
    disabledReason: 'Disabled by default: lifecycle hooks are opt-in; default off per ADR-0014 §2.5 (preserved in plugin code, not active in production).',
  },
  {
    id: 'hook:before_message_write',
    kind: 'hook',
    category: 'core',
    enabledByDefault: true,
    since: '2026-06-09',
    description: 'Fallback trajectory collection (SQLite) when llm_output is blocked by missing allowConversationAccess (PRI-346)',
  },
  {
    id: 'service:evolution-worker',
    kind: 'service',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-06-01',
    description: 'Background evolution worker for pain processing (MVP-Quiet per PRI-288/ADR-0014)',
    disabledReason: 'MVP-Quiet: evolution worker gated behind evolution_worker feature flag (PRI-288); default off per ADR-0014 §2.5',
  },
  {
    id: 'service:correction-observer',
    kind: 'service',
    category: 'core',
    enabledByDefault: true,
    since: '2026-06-02',
    description: 'Independent correction observer service for keyword self-correction (MVP-Core per ADR-0014 amendment, PRI-293)',
  },
  {
    id: 'service:trajectory',
    kind: 'service',
    category: 'core',
    enabledByDefault: true,
    since: '2026-05-24',
    description: 'Trajectory collection service — pre-initializes TrajectoryDB registry; hooks (llm_output, before_message_write) are the primary writers (PRI-346/353)',
  },
  {
    id: 'service:pd-task',
    kind: 'service',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'PD task management service',
    disabledReason: 'Disabled by default: pd-task service is opt-in; default off per ADR-0014 §2.5 (preserved in plugin code, not active in production).',
  },
  {
    id: 'service:central-sync',
    kind: 'service',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Cross-workspace central sync service',
    disabledReason: 'Disabled by default: cross-workspace central sync is opt-in for multi-workspace deployments; default off per ADR-0014 §2.4 (preserved in plugin code, not active in production).',
  },
  {
    id: 'service:internalization-auto-consumer',
    kind: 'service',
    category: 'core',
    enabledByDefault: true,
    since: '2026-06-13',
    description: 'Bounded auto-consumer for dreamer internalization tasks — prevents ready tasks from pending forever (PRI-381)',
  },
  {
    id: 'startup:workspace-init',
    kind: 'startup',
    category: 'core',
    enabledByDefault: true,
    since: '2026-05-24',
    description: 'Workspace migration + template setup on first prompt',
  },
  {
    id: 'startup:evolution-worker',
    kind: 'startup',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-06-01',
    description: 'Evolution worker start on first prompt per workspace (MVP-Quiet per PRI-288/ADR-0014)',
    disabledReason: 'MVP-Quiet: evolution worker startup gated behind evolution_worker feature flag (PRI-288); default off per ADR-0014 §2.5',
  },
  {
    id: 'startup:correction-observer',
    kind: 'startup',
    category: 'core',
    enabledByDefault: true,
    since: '2026-06-02',
    description: 'Correction observer start on first prompt per workspace (MVP-Core per ADR-0014 amendment, PRI-293)',
  },
  {
    id: 'startup:internalization-auto-consumer',
    kind: 'startup',
    category: 'core',
    enabledByDefault: true,
    since: '2026-06-13',
    description: 'Internalization auto-consumer start on first prompt per workspace (MVP-Core, PRI-381)',
  },
];

export function validateSurfaceRegistry(registry: readonly PluginSurfaceEntry[]): SurfaceRegistryValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();

  for (const entry of registry) {
    if (seenIds.has(entry.id)) {
      errors.push(`duplicate surface id: '${entry.id}'`);
    }
    seenIds.add(entry.id);

    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      errors.push(`surface entry has invalid id: '${String(entry.id)}'`);
    }

    if (!VALID_SURFACE_KINDS.includes(entry.kind)) {
      errors.push(`surface '${entry.id}': invalid kind '${entry.kind}'`);
    }

    if (!VALID_MVP_CATEGORIES.includes(entry.category)) {
      errors.push(`surface '${entry.id}': invalid category '${entry.category}'`);
    }

    if (typeof entry.enabledByDefault !== 'boolean') {
      errors.push(`surface '${entry.id}': enabledByDefault must be boolean`);
    }

    if (typeof entry.since !== 'string' || entry.since.length === 0) {
      errors.push(`surface '${entry.id}': since must be a non-empty string`);
    }

    if (typeof entry.description !== 'string' || entry.description.length === 0) {
      errors.push(`surface '${entry.id}': description must be a non-empty string`);
    }

    if (entry.category === 'core' && !entry.enabledByDefault) {
      errors.push(`surface '${entry.id}': core surface must be enabledByDefault=true`);
    }

    if (entry.category !== 'core' && entry.enabledByDefault) {
      errors.push(`surface '${entry.id}': non-core surface (${entry.category}) must not be enabledByDefault=true`);
    }

    if ((entry.category === 'quiet' || entry.category === 'gone' || entry.category === 'legacy_retire') && !entry.disabledReason) {
      warnings.push(`surface '${entry.id}': ${entry.category} surface has no disabledReason — observability gap (ERR-002)`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function getEnabledSurfaces(
  registry: readonly PluginSurfaceEntry[],
  overrides: Record<string, boolean> = {},
): PluginSurfaceEntry[] {
  return registry.filter(entry => {
    if (Object.hasOwn(overrides, entry.id)) {
      const override = overrides[entry.id];
      if (typeof override !== 'boolean') return entry.enabledByDefault;
      if (entry.category === 'gone') return false;
      if (entry.category === 'core' && !override) return true;
      return override;
    }
    return entry.enabledByDefault;
  });
}

export function getSurfacesByCategory(
  registry: readonly PluginSurfaceEntry[],
  category: MvpCategory,
): PluginSurfaceEntry[] {
  return registry.filter(entry => entry.category === category);
}

export function getSurfacesByKind(
  registry: readonly PluginSurfaceEntry[],
  kind: SurfaceKind,
): PluginSurfaceEntry[] {
  return registry.filter(entry => entry.kind === kind);
}

export function findUnclassifiedSurfaces(
  registryIds: readonly string[],
  actualSurfaceIds: readonly string[],
): string[] {
  const registered = new Set<string>(registryIds);
  return actualSurfaceIds.filter(id => !registered.has(id));
}
