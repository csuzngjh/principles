export type SurfaceKind = 'hook' | 'service' | 'startup' | 'prompt_section';
export type MvpCategory = 'core' | 'quiet' | 'gone' | 'legacy_retire';

export const VALID_SURFACE_KINDS: readonly SurfaceKind[] = ['hook', 'service', 'startup', 'prompt_section'];
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
    id: 'hook:after_tool_call.trajectory',
    kind: 'hook',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Trajectory collector for after_tool_call events',
    disabledReason: 'MVP-Quiet: trajectory collection not required for Story A\'',
  },
  {
    id: 'hook:llm_output.trajectory',
    kind: 'hook',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Trajectory collector for llm_output events',
    disabledReason: 'MVP-Quiet: trajectory collection not required for Story A\'',
  },
  {
    id: 'hook:subagent_spawning',
    kind: 'hook',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Shadow routing observation on subagent spawn',
    disabledReason: 'MVP-Quiet: shadow observation not required for Story A\'',
  },
  {
    id: 'hook:subagent_ended',
    kind: 'hook',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Shadow observation completion on subagent end',
    disabledReason: 'MVP-Quiet: shadow observation not required for Story A\'',
  },
  {
    id: 'hook:before_reset',
    kind: 'hook',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Lifecycle hook for context reset',
    disabledReason: 'MVP-Quiet: lifecycle hooks not required for Story A\'',
  },
  {
    id: 'hook:before_compaction',
    kind: 'hook',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Lifecycle hook for before compaction',
    disabledReason: 'MVP-Quiet: lifecycle hooks not required for Story A\'',
  },
  {
    id: 'hook:after_compaction',
    kind: 'hook',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Lifecycle hook for after compaction',
    disabledReason: 'MVP-Quiet: lifecycle hooks not required for Story A\'',
  },
  {
    id: 'service:evolution-worker',
    kind: 'service',
    category: 'core',
    enabledByDefault: true,
    since: '2026-05-24',
    description: 'Background evolution worker for pain processing',
  },
  {
    id: 'service:trajectory',
    kind: 'service',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Trajectory collection service',
    disabledReason: 'MVP-Quiet: trajectory not required for Story A\'',
  },
  {
    id: 'service:pd-task',
    kind: 'service',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'PD task management service',
    disabledReason: 'MVP-Quiet: task service not required for Story A\'',
  },
  {
    id: 'service:central-sync',
    kind: 'service',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Cross-workspace central sync service',
    disabledReason: 'MVP-Quiet: central sync not required for single-workspace MVP',
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
    category: 'core',
    enabledByDefault: true,
    since: '2026-05-24',
    description: 'Evolution worker start on first prompt per workspace',
  },
  {
    id: 'prompt_section:principles',
    kind: 'prompt_section',
    category: 'core',
    enabledByDefault: true,
    since: '2026-05-24',
    description: 'Active principles injection into agent prompt',
  },
  {
    id: 'prompt_section:empathy_observer',
    kind: 'prompt_section',
    category: 'core',
    enabledByDefault: true,
    since: '2026-05-30',
    description: 'Empathy observer for frustration/friction detection (ADR-0014 amendment)',
  },
  {
    id: 'prompt_section:thinking_os',
    kind: 'prompt_section',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Thinking OS mental model injection',
    disabledReason: 'MVP-Quiet: makes prompt less interpretable; ADR-0014 §2.5',
  },
  {
    id: 'prompt_section:gfi',
    kind: 'prompt_section',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Global Friction Index session scoring injection',
    disabledReason: 'MVP-Quiet: internal metric, not user-visible; ADR-0014 §2.5',
  },
  {
    id: 'prompt_section:focus_history',
    kind: 'prompt_section',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Focus history detailed injection',
    disabledReason: 'MVP-Quiet: less interpretable; ADR-0014 §2.5',
  },
  {
    id: 'prompt_section:routing_guidance',
    kind: 'prompt_section',
    category: 'quiet',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Routing guidance for local worker dispatch',
    disabledReason: 'MVP-Quiet: shadow/local-worker routing not in Story A\'',
  },
  {
    id: 'prompt_section:message_sanitize',
    kind: 'prompt_section',
    category: 'gone',
    enabledByDefault: false,
    since: '2026-05-24',
    description: 'Message sanitization hook (retired)',
    disabledReason: 'MVP-Gone: COMPONENTS.md self-tagged for deletion',
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
