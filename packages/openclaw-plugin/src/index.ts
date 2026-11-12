import type {
  OpenClawPluginApi,
  PluginHookBeforePromptBuildEvent,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildResult,
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
  PluginHookBeforeToolCallResult,
  PluginHookAfterToolCallEvent,
  PluginHookBeforeResetEvent,
  PluginHookBeforeCompactionEvent,
  PluginHookAfterCompactionEvent,
  PluginHookLlmOutputEvent,
  PluginHookLlmInputEvent,
  PluginHookBeforeMessageWriteEvent,
} from './openclaw-sdk.js';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import * as os from 'os';
import { loadFeatureFlagFromConfig } from './core/pd-config-loader.js';
import { ensureMcpBinding, invalidateMcpBinding } from './core/mcp-binding.js';
import { scheduleTelemetryExportForWorkspace } from './core/product-telemetry-trigger.js';
import { scheduleTrajectoryRetentionForWorkspace } from './core/trajectory-retention-trigger.js';
import { checkConversationAccessConfig, getPluginEntry, ensureConversationAccessInConfig, isExplicitConversationAccessOptOut } from './core/config-health.js';
export { checkConversationAccessConfig, getPluginEntry, ensureConversationAccessInConfig, isExplicitConversationAccessOptOut } from './core/config-health.js';
export type { ConversationAccessCheckResult } from './core/config-health.js';
import { getCommandDescription } from './i18n/commands.js';
import { WorkspaceContext } from './core/workspace-context.js';
import { handleBeforePromptBuild, beginAdaptivePromptInvocation, prepareOpenClawPromptRound } from './hooks/prompt.js';
import { createAdaptivePriorityProviderForConfig, loadPdConfigForPlugin, resolveCurrentAuthorizedActivationByPrincipleId } from '@principles/host-runtime';
import { createAdaptiveHookRegistrationRecorder, setAdaptiveHookSet } from './core/adaptive-config-identity.js';
import { buildOpenClawRuleInputEnrichment, buildRuleContextIfEnabled, handleSharedRuleHostResult } from './hooks/gate.js';
import { handleAfterToolCall, prepareOrdinaryAfterToolCallForSharedRuntime } from './hooks/pain.js';
import { handleBeforeReset, handleBeforeCompaction, handleAfterCompaction } from './hooks/lifecycle.js';
import { handleLlmOutput } from './hooks/llm.js';
import { makeLlmInputPresenceRegistration } from './hooks/llm-input-presence.js';
import * as TrajectoryCollector from './hooks/trajectory-collector.js';
import { handleInitStrategy } from './commands/strategy.js';
import { handleBootstrapTools, handleResearchTools } from './commands/capabilities.js';
import { handlePainCommand, handlePainReportCommand } from './commands/pain.js';
import { handleContextCommand } from './commands/context.js';
import { handleFocusCommand } from './commands/focus.js';
import { handleRollbackCommand } from './commands/rollback.js';
import { handlePromoteImplCommand } from './commands/promote-impl.js';
import { handleDisableImplCommand } from './commands/disable-impl.js';
import { handleArchiveImplCommand } from './commands/archive-impl.js';
import { handleRollbackImplCommand } from './commands/rollback-impl.js';
import { handlePrincipleRollbackCommand } from './commands/principle-rollback.js';
import { handleExportCommand } from './commands/export.js';
import { handleSamplesCommand } from './commands/samples.js';
import { CorrectionObserverService } from './service/correction-observer-service.js';
import { InternalizationAutoConsumerService, persistOpenClawToolDeclaration } from './service/internalization-auto-consumer-service.js';
import { TrajectoryService } from './service/trajectory-service.js';
import { PDTaskService } from './core/pd-task-service.js';
import { ensureWorkspaceTemplates } from './core/init.js';
import { migrateDirectoryStructure } from './core/migration.js';
import { SystemLogger } from './core/system-logger.js';
import { PathResolver } from './core/path-resolver.js';
import { resolveCommandWorkspaceDir, resolveExplicitPdWorkspaceDir, resolveHookWorkspaceDir } from './utils/workspace-resolver.js';
import { validateWorkspaceDir } from './core/workspace-dir-validation.js';
import { checkSurfaceGuard, guardHook, guardService, safeStringifyPreview } from '@principles/core/runtime';
import { createOpenClawHostRuntime } from './host-runtime/openclaw-host-runtime.js';
import { readAdaptiveActivationConfig, isPrincipleIdentityMapping } from './hooks/adaptive-activation-config.js';
import { rememberAdaptivePrincipleResolution } from './hooks/adaptive-principle-resolution.js';
import { claimControlledAdmission, isControlledAdmissionConfigured } from './hooks/controlled-admission.js';
import { resolveCurrentUserMessage } from './hooks/prompt-helpers.js';
import { isUserInteractionTrigger } from './core/signal-collector-host.js';
import { isMinimalTrigger } from '@principles/core/prompt-builder';

// Track started workspaces — one-time init per workspace
const startedWorkspaces = new Set<string>();

// PRI-343: Module-level auto-fix for allowConversationAccess.
// Runs IMMEDIATELY when this bundle is imported (before register() is called).
// Uses file locking to prevent race conditions with concurrent writers.
try {
  ensureConversationAccessInConfig();
} catch {
  // Best-effort — register() will retry with logging.
}

// ── Conversation Access Health Check (PRI-343) ────────────────────────────
// Re-exported from core/config-health.ts for backward compatibility.
// Implementation moved to avoid circular imports with trajectory-collector.ts.

// ── Feature Flag Loader (plugin I/O boundary) ─────────────────────────────
// Reads workspace .pd/config.yaml and checks a specific flag.
// (ADR-0016: the legacy .pd/feature-flags.yaml is no longer read by production runtime.)
// Returns the flag definition with effective enabled state.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * PRI-305/PRI-307: Load feature flag from .pd/config.yaml instead of .pd/feature-flags.yaml.
 * Delegates to the shared plugin config loader for consistency.
 */
function loadFeatureFlagFromWorkspace(
  workspaceDir: string,
  flagId: string,
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void },
): { enabled: boolean; source: string } {
  return loadFeatureFlagFromConfig(workspaceDir, flagId, logger);
}

export interface CorrectionObserverGateResult {
  shouldStart: boolean;
  flagSource: string;
  disabledInfo: string | null;
}

export function shouldStartCorrectionObserver(
  workspaceDir: string,
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
): CorrectionObserverGateResult {
  const flag = loadFeatureFlagFromWorkspace(workspaceDir, 'correction_observer', logger);
  if (flag.enabled) {
    return { shouldStart: true, flagSource: flag.source, disabledInfo: null };
  }
  const disabledInfo = JSON.stringify({
    reason: 'correction_observer_disabled',
    nextAction: 'set features.correction_observer.enabled=true in .pd/config.yaml to enable',
    featureFlag: 'correction_observer',
    boundedContext: 'correction_observer_service',
    flagSource: flag.source,
  });
  return { shouldStart: false, flagSource: flag.source, disabledInfo };
}

export interface InternalizationAutoConsumerGateResult {
  shouldStart: boolean;
  flagSource: string;
  disabledInfo: string | null;
}

export function shouldStartInternalizationAutoConsumer(
  workspaceDir: string,
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
): InternalizationAutoConsumerGateResult {
  const flag = loadFeatureFlagFromWorkspace(workspaceDir, 'internalization_auto_consumer', logger);
  if (flag.enabled) {
    return { shouldStart: true, flagSource: flag.source, disabledInfo: null };
  }
  const disabledInfo = JSON.stringify({
    reason: 'internalization_auto_consumer_disabled',
    nextAction: `pd runtime internalization run-once --workspace "${workspaceDir}" --runner dreamer --runtime config --json`,
    featureFlag: 'internalization_auto_consumer',
    boundedContext: 'internalization_auto_consumer',
    flagSource: flag.source,
  });
  return { shouldStart: false, flagSource: flag.source, disabledInfo };
}

/**
 * Gate 4 (PRI-1071): keep the host-wide launcher binding in lockstep with an
 * EXPLICITLY DECLARED PD workspace only.
 *
 * The MCP server is one process per host and reads ONE `mcp-binding.json` beside
 * the plugin payload, while OpenClaw may run several agents with different
 * `ctx.workspaceDir`s. Binding whichever agent resolved first (or `main`) would
 * serve that workspace's Pain evidence to every other agent — cross-workspace
 * recall leakage. So:
 *   - explicit PD workspace (PD_WORKSPACE_DIR / OPENCLAW_WORKSPACE /
 *     principles-disciple.json `workspace`) → bind it (idempotent);
 *   - no explicit declaration → REMOVE the binding and let the launcher
 *     fail closed (`binding_missing`). Never infer from `main`, `cwd`, `HOME`
 *     or the host default (SPEC §3.5).
 *
 * Hooks are unaffected: per-event hook resolution keeps its existing chain.
 * Never throws (G4-07: MCP unavailability must not break PD's other functions).
 */
export interface McpBindingSyncResult {
  status: 'written' | 'unchanged' | 'invalidated' | 'unavailable';
  reason: string;
  nextAction: string;
  workspaceDir?: string;
  source?: string;
}

export function syncMcpBindingFromExplicitWorkspace(options: {
  extensionRoot: string;
  homeDir: string;
  resolver?: () => { workspaceDir: string; source: string } | null;
}): McpBindingSyncResult {
  const explicit = options.resolver ? options.resolver() : resolveExplicitPdWorkspaceDir();
  const declaredIsUsable = explicit !== null && validateWorkspaceDir(explicit.workspaceDir) === null;
  if (explicit !== null && declaredIsUsable) {
    const outcome = ensureMcpBinding(explicit.workspaceDir, options.extensionRoot, options.homeDir);
    if (outcome.ok) {
      return {
        status: outcome.written ? 'written' : 'unchanged',
        reason: `pd_workspace_explicit:${explicit.source}`,
        nextAction: outcome.written
          ? 'Restart the OpenClaw gateway so the pd-recall MCP server reads the new binding.'
          : 'No change: the binding already matches the declared PD workspace.',
        workspaceDir: explicit.workspaceDir,
        source: explicit.source,
      };
    }
    // rc-9: never report a safety property this failure did not achieve. Only
    // a genuinely absent MCP component has the "re-install" remedy; any other
    // failure leaves the PREVIOUS binding on disk, so say that.
    const componentMissing = outcome.reason === 'mcp_server_component_missing';
    return {
      status: 'unavailable',
      reason: outcome.reason ?? 'mcp_binding_write_failed',
      nextAction: componentMissing
        ? 'Re-run the PD host setup so ~/.pd/runtime/pd-mcp-server is installed, then restart OpenClaw. pd-recall stays fail-closed until the binding exists.'
        : 'PD FAILED to write the binding for the declared workspace, so the previous mcp-binding.json (a DIFFERENT workspace) may still be on disk. ' +
          'The launcher refuses to start unless the binding matches the explicit declaration, so no other workspace is served — but fix the failure ' +
          `(check write access to ${options.extensionRoot}) and restart the OpenClaw gateway.`,
      workspaceDir: explicit.workspaceDir,
      source: explicit.source,
    };
  }
  const invalidated = invalidateMcpBinding(options.extensionRoot);
  const declaredReason = explicit === null
    ? 'pd_workspace_not_explicit'
    : 'pd_workspace_declaration_invalid';
  return {
    status: invalidated.ok ? 'invalidated' : 'unavailable',
    reason: invalidated.ok ? declaredReason : (invalidated.reason ?? 'mcp_binding_remove_failed'),
    // rc-9: a failed removal is NOT fail-closed. Say so plainly instead of
    // reporting a safety property the filesystem refused to grant.
    nextAction: invalidated.ok
      ? 'pd-recall MCP is fail-closed because the PD governance workspace is not explicitly configured; hooks keep their per-agent workspaces. ' +
        'Declare ONE PD workspace (set PD_WORKSPACE_DIR, or add {"workspace":"<absolute dir>"} to ~/.openclaw/principles-disciple.json), then restart the OpenClaw gateway.'
      : 'PD FAILED to remove the stale mcp-binding.json, so the old binding file is still on disk (the launcher separately refuses to start unless the binding matches the explicitly declared workspace). ' +
        `Delete ${path.join(options.extensionRoot, 'mcp-binding.json')} manually, then declare ONE PD workspace and restart the OpenClaw gateway.`,
  };
}

/** Native-gap scoring only on host-admitted user messages. */
export async function resolveOpenClawNativeGap(
  event: PluginHookBeforePromptBuildEvent,
  context: PluginHookAgentContext,
  ...[hostEvent, candidates, gapOptions, api]: [
    ...Parameters<import('@principles/host-runtime').AdaptivePriorityProvider>,
    Parameters<typeof handleBeforePromptBuild>[1]['api'],
  ]
) {
  if (!api) return undefined;
  const sessionId = context.sessionId;
  if (!sessionId?.trim() || !context.workspaceDir || !isUserInteractionTrigger(context.trigger)
    || isMinimalTrigger(context.trigger, sessionId)
    || readAdaptiveActivationConfig(api.pluginConfig, context.workspaceDir, Date.now())) return undefined;
  const text = Object.getOwnPropertyDescriptor(event, 'currentUserMessage')?.value;
  const id = Object.getOwnPropertyDescriptor(event, 'currentUserMessageId')?.value;
  if (typeof text !== 'string' || !text.trim() || typeof id !== 'string' || !id.trim()
    || resolveCurrentUserMessage(event, sessionId).isAgentToAgent) return undefined;
  const config = loadPdConfigForPlugin(context.workspaceDir);
  if (!config.ok) return undefined;
  const adaptive = createAdaptivePriorityProviderForConfig(config.effective.config, context.workspaceDir, {
    flag: 'host.openclaw.adaptive_activation',
    outerDeadlineAt: Date.now() + 2500,
    onDiagnostic: (line) => api.logger.info(`[PD:AA] Native gap ${line.status}:${line.reason} sends=${line.sends}`),
  });
  if (!adaptive.ok) {
    if (adaptive.readiness !== 'disabled') api.logger.warn(`[PD:AA] ${adaptive.reason}`);
    return undefined;
  }
  return adaptive.provider({
    ...hostEvent,
    context: { ...hostEvent.context, sessionId, turnId: id, promptContent: text },
  }, candidates, gapOptions);
}

/**
 * PRI-1137: the OpenClaw-specific adaptive-priority decision, extracted from
 * the inline provider so the SAME decision runs on the shared-runtime path.
 * The pre-selection half claims the operator admission (or begins a native
 * delivery invocation) BEFORE the shared selector builds the prompt; the
 * resulting priority is handed to `buildActivePrinciplePromptContext`.
 *
 * PRI-1140: a `{principleId}` mapping resolves to the AT MOST ONE currently
 * authorized prompt activation of that principle at provider time (fresh per
 * request — a revision that lands before the next prompt build is picked up
 * without any config edit). The resolution is remembered for the SAME
 * invocation's post-selection half and the priority is marked `additiveOnly`:
 * the shared assembly may place the target first but must never squeeze out
 * content the native baseline already assembled. Resolution failures fall
 * closed to Native with a structured reason. The controlled-admission branch
 * keeps requiring the pinned mapping (its manifest binds exact artifact
 * identity) and the pinned mapping itself behaves byte-identically to before.
 */
export async function resolveAdaptivePriorityForHook(
  event: PluginHookBeforePromptBuildEvent,
  context: PluginHookAgentContext,
  api: Parameters<typeof handleBeforePromptBuild>[1]['api'],
): Promise<{ artifactId: string; activationId: string; additiveOnly?: boolean; hookInvocationId?: string; signal?: AbortSignal; deadlineAt?: number } | undefined> {
  const startedAt = Date.now();
  if (!api) return undefined;
  const workspaceDir = context.workspaceDir;
  const sessionId = context.sessionId;
  const ownValue = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== 'object') return undefined;
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  };
  const currentMessage = ownValue(event, 'currentUserMessage');
  const currentMessageId = ownValue(event, 'currentUserMessageId');
  const requestId = ownValue(event, 'requestId');
  if (!workspaceDir || !sessionId?.trim() || !isUserInteractionTrigger(context.trigger) || isMinimalTrigger(context.trigger, sessionId)) return undefined;
  const mapping = readAdaptiveActivationConfig(ownValue(api, 'pluginConfig'), workspaceDir, startedAt);
  if (!mapping) return undefined;

  const hasNativeIdentity = (typeof currentMessageId === 'string' && currentMessageId.trim().length > 0)
    || (typeof requestId === 'string' && requestId.trim().length > 0);
  if (!hasNativeIdentity) {
    // Embedded OpenClaw supplies no native message identity. The operator
    // admission covers exactly one frozen input; consumption happens here
    // (the earliest selection point) and is handed to the same-round
    // beforePromptBuild callback through the claim cache.
    // PRI-1140: the admission manifest binds an exact artifact/activation
    // identity, so a principle mapping has no admission semantics — fail
    // closed instead of claiming against an unresolved target.
    if (isPrincipleIdentityMapping(mapping)) {
      api.logger.warn('[PD:AA] controlled admission refused: {"reason":"principle_mapping_has_no_admission_identity"}');
      return undefined;
    }
    if (!isControlledAdmissionConfigured()) return undefined;
    const deadlineAt = Math.min(startedAt + mapping.softTimeoutMs, mapping.expiresAtMs);
    if (deadlineAt - Date.now() <= 0) return undefined;
    const hookInvocationId = randomUUID();
    const admission = claimControlledAdmission({
      event, workspaceDir, sessionId, runId: context.runId ?? null, mapping, hookInvocationId, now: startedAt,
    });
    if (admission.status !== 'claimed') {
      api.logger.warn(`[PD:AA] controlled admission refused: ${JSON.stringify({
        status: admission.status,
        ...(admission.status === 'rejected' ? { reason: admission.reason, detail: admission.detail } : {}),
      })}`);
      return undefined;
    }
    beginAdaptivePromptInvocation({ ...context, api: api as Parameters<typeof handleBeforePromptBuild>[1]['api'] }, mapping, 'shared', hookInvocationId);
    return {
      artifactId: mapping.artifactId,
      activationId: mapping.activationId,
      hookInvocationId,
      signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
      deadlineAt,
    };
  }

  if (typeof currentMessage !== 'string') return undefined;
  const resolved = resolveCurrentUserMessage(event, sessionId);
  if (resolved.isAgentToAgent || currentMessage.split(/\r?\n/, 1)[0] !== '[PD-AA:delivery-review:v1]') return undefined;
  const deadlineAt = Math.min(startedAt + mapping.softTimeoutMs, mapping.expiresAtMs);
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return undefined;
  // PRI-1140: principle-identity resolution runs ONLY on confirmed
  // delivery-signal rounds, so ordinary rounds keep today's cost (zero reads
  // here). A failed resolution is a structured fallback to Native, never a
  // guessed target.
  if (isPrincipleIdentityMapping(mapping)) {
    const resolution = await resolveCurrentAuthorizedActivationByPrincipleId({
      workspaceDir,
      principleId: mapping.principleId,
    });
    if (!resolution.ok) {
      api.logger.warn(`[PD:AA] principle resolution refused: ${JSON.stringify({
        reason: resolution.reason,
        principleId: mapping.principleId,
        warnings: resolution.warnings.length,
        nextAction: 'the mapping target is not uniquely currently authorized; ordinary Native assembly continues',
      })}`);
      return undefined;
    }
    // rc-7: the read above consumed part of the soft deadline — recompute the
    // remaining window from the clock instead of reusing the pre-read value.
    const remainingAfterResolution = deadlineAt - Date.now();
    if (remainingAfterResolution <= 0) {
      api.logger.warn(`[PD:AA] principle resolution refused: ${JSON.stringify({
        reason: 'deadline',
        principleId: mapping.principleId,
        nextAction: 'the soft deadline expired during resolution; ordinary Native assembly continues',
      })}`);
      return undefined;
    }
    const hookInvocationId = beginAdaptivePromptInvocation(
      { ...context, api: api as Parameters<typeof handleBeforePromptBuild>[1]['api'] },
      { artifactId: resolution.artifactId, activationId: resolution.activationId },
      'shared',
    );
    rememberAdaptivePrincipleResolution(hookInvocationId, resolution);
    return {
      artifactId: resolution.artifactId,
      activationId: resolution.activationId,
      additiveOnly: true,
      hookInvocationId,
      signal: AbortSignal.timeout(remainingAfterResolution),
      deadlineAt,
    };
  }
  return {
    artifactId: mapping.artifactId,
    activationId: mapping.activationId,
    hookInvocationId: beginAdaptivePromptInvocation({ ...context, api: api as Parameters<typeof handleBeforePromptBuild>[1]['api'] }, mapping, 'shared'),
    signal: AbortSignal.timeout(remainingMs),
    deadlineAt,
  };
}

const plugin = {
  name: "Principles Disciple",
  description: "Evolutionary programming agent framework with strategic guardrails and reflection loops.",

  register(api: OpenClawPluginApi) {
    api.logger.info(`Principles Disciple Plugin registered. (Path: ${api.rootDir ?? '(unknown)'})`);
    PathResolver.setExtensionRoot(api.rootDir ?? '.');

    // ── Startup Health Check: MCP binding requires an EXPLICIT PD workspace ──
    // Gate 4 (PRI-1071): this host-wide binding may only record an owner-declared
    // workspace. Resolving `{ agentId: 'main' }` (or any ctx/cwd/HOME fallback)
    // and writing it as THE binding leaks one agent's Pain evidence to every
    // other agent. Without an explicit declaration the previous binding is
    // removed so the launcher fails closed (SPEC §3.5).
    const healthCheckTimer = setTimeout(() => {
      try {
        const extensionRoot = PathResolver.getExtensionRoot() ?? process.cwd();
        const decision = syncMcpBindingFromExplicitWorkspace({
          extensionRoot,
          homeDir: os.homedir(),
        });
        if (decision.status === 'written') {
          api.logger.info(`[PD:health] mcp-binding.json updated for the pd-recall MCP server (${decision.reason}; restart the gateway to apply)`);
        } else if (decision.status === 'invalidated') {
          api.logger.warn(
            `[PD:health] mcp-binding.json removed: pd-recall MCP stays fail-closed (${decision.reason}). ` +
            `nextAction: ${decision.nextAction}`,
          );
        } else if (decision.status === 'unavailable') {
          api.logger.warn(`[PD:health] mcp-binding unavailable (${decision.reason}). nextAction: ${decision.nextAction}`);
        }
      } catch (err) {
        api.logger.warn(`[PD:health] mcp-binding update failed: ${String(err instanceof Error ? err.message : err)}`);
      }

      // PRI-343: Check allowConversationAccess — auto-fix if missing/false, warn if fix fails.
      // Uses file locking to prevent race conditions with concurrent writers.
      const pluginEntry = getPluginEntry(api.config, api.id);
      const accessCheck = checkConversationAccessConfig(pluginEntry);
      if (!accessCheck.authorized && isExplicitConversationAccessOptOut(pluginEntry)) {
        // Explicit `allowConversationAccess=false` is the Owner's documented
        // turn-off — honor it with a structured rc-9 record instead of the
        // absent-flag auto-fix (which must never rewrite an explicit deny).
        api.logger.info(
          `[PD:health] conversation hooks (llm_output / trajectory) disabled by explicit configuration — ` +
          `honoring Owner opt-out (allowConversationAccess=false). ` +
          `nextAction: set the flag to true or remove it to re-enable conversation capture.`,
        );
      } else if (!accessCheck.authorized) {
        let fixed = false;
        try {
          fixed = ensureConversationAccessInConfig();
        } catch (err) {
          api.logger.warn(
            `[PD:health] auto-fix for allowConversationAccess failed: ${String(err instanceof Error ? err.message : err)}`,
          );
        }
        if (fixed) {
          api.logger.info(
            `[PD:health] allowConversationAccess auto-configured. Restart the gateway to activate conversation hooks.`,
          );
        } else {
          api.logger.error(
            `[PD:health] conversation hooks (llm_output / trajectory) will be BLOCKED by OpenClaw.\n` +
            `  reason: ${accessCheck.reason}\n` +
            `  nextAction: ${accessCheck.nextAction}`,
          );
        }
      } else {
        api.logger.info(`[PD:health] conversation hooks (allowConversationAccess) OK`);
      }
    }, 1000);
    healthCheckTimer.unref(); // Don't keep process alive for health check

    // PRI-1137: the per-workspace shared/legacy route gate
    // (`shouldUseSharedHostRuntime` + `runtimeGateCache` + `runtimeGateFor`) is
    // retired. Every OpenClaw ordinary prompt/tool hook now enters the shared
    // runtime; `abstraction_layer_v1` is a gone tombstone and cannot resurrect
    // the legacy route.

    // ── MVP Surface Guard (PRI-289): Verify surface classification ──
    const surfaceGuard = checkSurfaceGuard();
    if (!surfaceGuard.passed) {
      for (const violation of surfaceGuard.violations) {
        api.logger.error(`[PD:surface-guard] VIOLATION: ${violation}`);
      }
    }
    api.logger.info(`[PD:surface-guard] Core surfaces: ${surfaceGuard.enabledCoreSurfaces.join(', ')}`);
    api.logger.info(`[PD:surface-guard] Disabled non-core surfaces: ${surfaceGuard.disabledNonCoreSurfaces.length}`);
    for (const warning of surfaceGuard.warnings) {
      api.logger.warn(`[PD:surface-guard] ${warning}`);
    }

    // PRI-1110: record the hook set that is actually passed to OpenClaw. The
    // AA config identity fingerprint is derived from this, never from a
    // declared/static list.
    const hookRegistrations = createAdaptiveHookRegistrationRecorder(api);

    // Language fallback must match openclaw.plugin.json configSchema default
    // ("zh") — an 'en' fallback silently served English templates/prompts to
    // every install that never set plugin config language (ERR-075 family).
    const language = (api.pluginConfig?.language as string) || 'zh';
    const sharedHostRuntime = createOpenClawHostRuntime({
      // PRI-1137: OpenClaw owns a real advancing user-turn authority
      // (`trajectory.db` user_turns). Hand it to the shared selector so the
      // round key matches the actual session-turn order; the provider's
      // pre-selection half performs the ONE signal collection write for this
      // invocation. Codex / WorkBuddy adapters supply no round key at all.
      roundKeyProvider: (event, context) => prepareOpenClawPromptRound(event, {
        ...context,
        api: api as Parameters<typeof handleBeforePromptBuild>[1]['api'],
      }),
      // PRI-1137: the adaptive priority decision is a NAMED production function
      // (not an inline callback) so the OpenClaw-specific decision can be
      // exercised on the shared-runtime path instead of the deleted local one.
      adaptivePriorityProvider: (event, context) => resolveAdaptivePriorityForHook(
        event,
        context,
        api as Parameters<typeof handleBeforePromptBuild>[1]['api'],
      ),
      adaptiveGapProvider: (event, context, hostEvent, candidates, gapOptions) =>
        resolveOpenClawNativeGap(event, context, hostEvent, candidates, gapOptions, api as Parameters<typeof handleBeforePromptBuild>[1]['api']),
      beforePromptBuild: async (event, context, activePrinciplePrompt) =>
        handleBeforePromptBuild(event, {
          ...context,
          api: api as Parameters<typeof handleBeforePromptBuild>[1]['api'],
        }, activePrinciplePrompt),
      ruleContextProvider: (_event, context, request) => buildRuleContextIfEnabled(
        WorkspaceContext.fromHookContext({ ...context, workspaceDir: context.workspaceDir }),
        request.targetPath,
        context.sessionId,
        api.logger,
      ),
      ruleInputEnrichmentProvider: (event) => buildOpenClawRuleInputEnrichment(event),
      onBeforeToolResult: (event, context, result) => {
        if (!context.workspaceDir) {
          api.logger.warn('[PD_GATE:RULE_HOST] shared result mapping skipped: workspaceDir missing; nextAction=inspect OpenClaw hook context');
          return;
        }
        // Task 1: the shared handler is the ONLY decision owner. auto_correct
        // and requireApproval are applied/recorded there from the result
        // metadata; there is no second (legacy) evaluation of the activations.
        return handleSharedRuleHostResult(event, { ...context, workspaceDir: context.workspaceDir, logger: api.logger }, result);
      },
      painEnrichmentProvider: (event, context) => prepareOrdinaryAfterToolCallForSharedRuntime(event, {
        ...context,
        workspaceDir: context.workspaceDir ?? '',
        pluginConfig: api.pluginConfig ?? {},
      }),
    });

    // ── Hook: Prompt Building ──
    hookRegistrations.register(
      'hook:before_prompt_build',
      'before_prompt_build',
      guardHook('hook:before_prompt_build', api.logger, async (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext): Promise<PluginHookBeforePromptBuildResult | void> => {
        const wsResult = resolveHookWorkspaceDir(ctx, api, 'before_prompt_build');
        if (!wsResult.ok) {
          api.logger.error(
            `[PD:before_prompt_build] workspaceDir resolution failed. ` +
            `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} sessionId=${ctx.sessionId ?? '(missing)'}. ` +
            `Hook skipped — no mutation will occur. ` +
            `NextAction: ${wsResult.nextAction}`,
          );
          return;
        }
        const workspaceDir = wsResult.workspaceDir;
        if (wsResult.consistencyWarning) {
          api.logger.warn(`[PD:before_prompt_build] ${wsResult.consistencyWarning}`);
        }
        try {
          if (!startedWorkspaces.has(workspaceDir)) {
            startedWorkspaces.add(workspaceDir);
            migrateDirectoryStructure(api, workspaceDir);
            // migrateStaleWorkspaceGuidance removed in PRI-776: the PLAN.md-era
            // guidance migration ran at every startup for months (all existing
            // workspaces already migrated) and current templates cannot produce
            // matching text. See PRI-730 audit + git history for the rules.
            ensureWorkspaceTemplates(api, workspaceDir, language);
            SystemLogger.log(workspaceDir, 'SYSTEM_BOOT', `Principles Disciple online. Language: ${language}`);

            // ── Start CorrectionObserver for THIS workspace ──
            // MVP-Core per ADR-0014 amendment, independently owned (PRI-293).
            // (Legacy EvolutionWorker startup removed in PRI-737; the flag entry
            // moved to `gone` in PRI-752.)
            const corrGate = shouldStartCorrectionObserver(workspaceDir, api.logger);
            if (corrGate.shouldStart) {
              CorrectionObserverService.start({
                config: api.config,
                workspaceDir,
                stateDir: path.join(workspaceDir, '.state'),
                logger: api.logger,
              });
              api.logger.info(`[PD] CorrectionObserver started for workspace: ${workspaceDir} (flag source: ${corrGate.flagSource})`);
            } else {
              api.logger.info(`[PD] CorrectionObserver NOT started for workspace: ${workspaceDir}. ${corrGate.disabledInfo}`);
              SystemLogger.log(workspaceDir, 'CORRECTION_OBSERVER_DISABLED', corrGate.disabledInfo ?? '');
            }

            // ── Start InternalizationAutoConsumer for THIS workspace ──
            // PRI-381: Bounded auto-consumer for dreamer ready tasks.
            // Default ON for dogfood; kill switch via features.internalization_auto_consumer.enabled=false.
            // PRI-741 (review round): the tool declaration persists UNCONDITIONALLY
            // (before the consumer gate) — it is a host fact, and a flag-off
            // workspace must not keep a stale declaration that defeats the
            // activation gate's hasHostTool check.
            persistOpenClawToolDeclaration(workspaceDir, api.logger);
            const autoConsGate = shouldStartInternalizationAutoConsumer(workspaceDir, api.logger);
            if (autoConsGate.shouldStart) {
              InternalizationAutoConsumerService.start({
                config: api.config,
                workspaceDir,
                stateDir: path.join(workspaceDir, '.state'),
                logger: api.logger,
              });
              api.logger.info(`[PD] InternalizationAutoConsumer started for workspace: ${workspaceDir} (flag source: ${autoConsGate.flagSource})`);
            } else {
              api.logger.info(`[PD] InternalizationAutoConsumer NOT started for workspace: ${workspaceDir}. ${autoConsGate.disabledInfo}`);
              SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_DISABLED', autoConsGate.disabledInfo ?? '');
            }

            // ── Schedule anonymous product telemetry export (fire-and-forget) ──
            // PRI-595~603: opt-in (default OFF), one bounded attempt per
            // normal-activity window, never blocks hooks (unref'd timer, all
            // failures contained inside the service). Gating (flag + consent +
            // environment eligibility) happens inside maybeExportDaily.
            scheduleTelemetryExportForWorkspace(workspaceDir, api.logger);

            // ── Schedule bounded trajectory retention (SPEC-PD-TR-001) ──
            // One unref'd interval per workspace; the first attempt is a
            // minute later, so `before_prompt_build` never pays for a sweep.
            scheduleTrajectoryRetentionForWorkspace(workspaceDir, api.logger);
          }

          const hookContext = { ...ctx, workspaceDir };
          // PRI-1137: single route — the shared runtime owns prompt selection.
          const result = await sharedHostRuntime.dispatchBeforePromptBuild(event, hookContext);
          
          // Record success
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'before_prompt_build',
            sessionId: ctx.sessionId
          });
          
          return result;
        } catch (err) {
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'before_prompt_build',
            sessionId: ctx.sessionId,
            error: String(err)
          });
          api.logger.error(`[PD] Error in before_prompt_build: ${String(err)}`);
        }
      })
    );

    // ── Hook: Security Gate ──
    hookRegistrations.register(
      'hook:before_tool_call',
      'before_tool_call',
      guardHook('hook:before_tool_call', api.logger, (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext): PluginHookBeforeToolCallResult | void | Promise<PluginHookBeforeToolCallResult | void> => {
        const wsResult = resolveHookWorkspaceDir(ctx, api, 'before_tool_call');
        if (!wsResult.ok) {
          api.logger.error(
            `[PD:before_tool_call] workspaceDir resolution failed. ` +
            `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} sessionId=${ctx.sessionId ?? '(missing)'}. ` +
            `Hook skipped — security gate bypassed. ` +
            `NextAction: ${wsResult.nextAction}`,
          );
          return;
        }
        const workspaceDir = wsResult.workspaceDir;
        if (wsResult.consistencyWarning) {
          api.logger.warn(`[PD:before_tool_call] ${wsResult.consistencyWarning}`);
        }
        try {
          const pluginConfig = api.pluginConfig ?? {};
          const {logger} = api;
          const hookContext = { ...ctx, workspaceDir, pluginConfig, logger };
          return sharedHostRuntime.dispatchBeforeToolCall(event, hookContext).then((result) => {
            WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
              hook: 'before_tool_call'
            }, { flushImmediately: true });
            return result;
          }).catch((err: unknown) => {
            const errorPreview = err instanceof Error
              ? err.message.slice(0, 500)
              : safeStringifyPreview(err).slice(0, 500);
            WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
              hook: 'before_tool_call', error: errorPreview
            }, { flushImmediately: true });
            api.logger.error(`[PD] Error in before_tool_call: ${errorPreview}`);
            return undefined;
          });
        } catch (err) {
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'before_tool_call',
            error: String(err)
          }, { flushImmediately: true });
          api.logger.error(`[PD] Error in before_tool_call: ${String(err)}`);
        }
      })
    );

    // ── Hook: Pain & Trust ──
    // timeoutMs=10s: OpenClaw has no default timeout for after_tool_call; without
    // this a stuck SQLite write (busy_timeout=5000ms) leaks the handler promise.
    // 10s gives 2x headroom over busy_timeout. fail-open means agent is unaffected.
    hookRegistrations.register(
      'hook:after_tool_call',
      'after_tool_call',
      guardHook('hook:after_tool_call', api.logger, (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void | Promise<void> => {
        const wsResult = resolveHookWorkspaceDir(ctx, api, 'after_tool_call');
        if (!wsResult.ok) {
          api.logger.error(
            `[PD:after_tool_call] workspaceDir resolution failed. ` +
            `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} sessionId=${ctx.sessionId ?? '(missing)'}. ` +
            `Hook skipped — pain detection bypassed. ` +
            `NextAction: ${wsResult.nextAction}`,
          );
          return;
        }
        const workspaceDir = wsResult.workspaceDir;
        if (wsResult.consistencyWarning) {
          api.logger.warn(`[PD:after_tool_call] ${wsResult.consistencyWarning}`);
        }
        try {
          const pluginConfig = api.pluginConfig ?? {};
          // Pass api separately to handleAfterToolCall to maintain type safety
          const hookContext = { ...ctx, workspaceDir, pluginConfig };
          // Manual Owner pain remains an OpenClaw-owned path; PRI-523 shares
          // only ordinary after-tool classification/admission/evidence.
          if (event.toolName === 'pain' || event.toolName === 'skill:pain') {
            handleAfterToolCall(event, hookContext, api);
            WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({ hook: 'after_tool_call' }, { flushImmediately: true });
            return;
          }
          // The shared evidence kernel deliberately opens an existing
          // trajectory store without bootstrapping it. The OpenClaw host owns
          // workspace initialization, so ensure the selected workspace's
          // canonical store exists before dispatching the first tool event.
          void WorkspaceContext.fromHookContext({ workspaceDir, logger: api.logger }).trajectory;
          return sharedHostRuntime.dispatchAfterToolCall(event, hookContext).then((dispatched) => {
            // PRI-1137 final review P1-4: the shared kernel's degradation
            // (trajectory DB missing/unreadable/schema-invalid) must be
            // OBSERVABLE — an evidence row that never persisted may not be
            // recorded as a clean hook success (rc-9).
            const warnings = dispatched?.warnings ?? [];
            if (dispatched?.outcome === 'unavailable' || warnings.length > 0) {
              const degraded = `after_tool_call evidence degraded: ${warnings.join('; ')}${dispatched?.nextAction ? ` nextAction=${dispatched.nextAction}` : ''}`;
              api.logger.warn(`[PD:after_tool_call] ${degraded}`);
              WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
                hook: 'after_tool_call', error: degraded.slice(0, 500),
              }, { flushImmediately: true });
              return;
            }
            WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
              hook: 'after_tool_call'
            }, { flushImmediately: true });
          }).catch((err: unknown) => {
            const errorPreview = err instanceof Error
              ? err.message.slice(0, 500)
              : safeStringifyPreview(err).slice(0, 500);
            WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
              hook: 'after_tool_call', error: errorPreview
            }, { flushImmediately: true });
            api.logger.error(`[PD:SignalCollector] Error in after_tool_call: ${errorPreview}`);
          });
        } catch (err) {
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'after_tool_call',
            error: String(err)
          }, { flushImmediately: true });
            api.logger.error(`[PD:SignalCollector] Error in after_tool_call: ${String(err)}`);
        }
      }),
      { timeoutMs: 10_000 },
    );

    // ── Hook: LLM Analysis ──
    // timeoutMs=10s: OpenClaw has no default timeout for llm_output; without
    // this a stuck SQLite write leaks the handler promise. See after_tool_call.
    hookRegistrations.register(
      'hook:llm_output',
      'llm_output',
      guardHook('hook:llm_output', api.logger, (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext): void => {
        const wsResult = resolveHookWorkspaceDir(ctx, api, 'llm_output');
        if (!wsResult.ok) {
          api.logger.error(
            `[PD:llm_output] workspaceDir resolution failed. ` +
            `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} ` +
            `sessionId=${ctx.sessionId ?? '(missing)'}. ` +
            `Hook skipped — LLM analysis bypassed. ` +
            `NextAction: ${wsResult.nextAction}`,
          );
          return;
        }
        const workspaceDir = wsResult.workspaceDir;
        if (wsResult.consistencyWarning) {
          api.logger.warn(`[PD:llm_output] ${wsResult.consistencyWarning}`);
        }
        try {
          // PRI-755 (review fix): api.logger must be passed explicitly — the
          // receipt-capture skips/warns inside handleLlmOutput are the rc-9
          // observability surface and ctx may not carry a host logger.
          handleLlmOutput(event, { ...ctx, workspaceDir, logger: api.logger });

          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'llm_output',
            sessionId: ctx.sessionId
          });
        } catch (err) {
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'llm_output',
            sessionId: ctx.sessionId,
            error: String(err)
          });
          api.logger.error(`[PD] Error in llm_output: ${String(err)}`);
        }
      }),
      { timeoutMs: 10_000 },
    );

    // ── Hook: llm_input presence observation (PRI-1150, PD-self Path A) ──
    // Fact-only post-assembly observation on the official llm_input hook.
    // Never blocks the caller; body text stays in memory; the emitted event
    // carries containment facts only. Binding follows the owner-amended
    // registry rules (unique + complete history, else unknown).
    const llmInputPresence = makeLlmInputPresenceRegistration({
      logger: api.logger,
      getEventLog: (workspaceDir: string) => WorkspaceContext.fromHookContext({ workspaceDir }).eventLog,
    });
    hookRegistrations.register(
      llmInputPresence.surfaceId,
      llmInputPresence.event,
      guardHook('hook:llm_input_presence', api.logger, (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext): void => {
        const wsResult = resolveHookWorkspaceDir(ctx, api, 'llm_input');
        if (!wsResult.ok) {
          api.logger.warn(
            `[PD:llm_input] workspaceDir resolution failed. ` +
            `reason=${wsResult.reason} sessionId=${ctx.sessionId ?? '(missing)'}. Presence observation skipped.`,
          );
          return;
        }
        if (wsResult.consistencyWarning) {
          api.logger.warn(`[PD:llm_input] ${wsResult.consistencyWarning}`);
        }
        llmInputPresence.onResolved(event, ctx, wsResult.workspaceDir);
      }),
      // No timeoutMs: the registration records a void handler; the official
      // dispatch is already fire-and-forget on the host side.
    );

    // ── Hook: Lifecycle ──
    hookRegistrations.register('hook:before_reset', 'before_reset', guardHook('hook:before_reset', api.logger, (event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext) => {
      const wsResult = resolveHookWorkspaceDir(ctx, api, 'before_reset');
      if (!wsResult.ok) {
        api.logger.error(
          `[PD:before_reset] workspaceDir resolution failed. ` +
          `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} sessionId=${ctx.sessionId ?? '(missing)'}. ` +
          `Hook skipped. NextAction: ${wsResult.nextAction}`,
        );
        return;
      }
      if (wsResult.consistencyWarning) {
        api.logger.warn(`[PD:before_reset] ${wsResult.consistencyWarning}`);
      }
      return handleBeforeReset(event, { ...ctx, workspaceDir: wsResult.workspaceDir });
    }));
    
    hookRegistrations.register('hook:before_compaction', 'before_compaction', guardHook('hook:before_compaction', api.logger, (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => {
      const wsResult = resolveHookWorkspaceDir(ctx, api, 'before_compaction');
      if (!wsResult.ok) {
        api.logger.error(
          `[PD:before_compaction] workspaceDir resolution failed. ` +
          `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} sessionId=${ctx.sessionId ?? '(missing)'}. ` +
          `Hook skipped. NextAction: ${wsResult.nextAction}`,
        );
        return;
      }
      if (wsResult.consistencyWarning) {
        api.logger.warn(`[PD:before_compaction] ${wsResult.consistencyWarning}`);
      }
      return handleBeforeCompaction(event, { ...ctx, workspaceDir: wsResult.workspaceDir });
    }));
    
    hookRegistrations.register('hook:after_compaction', 'after_compaction', guardHook('hook:after_compaction', api.logger, (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => {
      const wsResult = resolveHookWorkspaceDir(ctx, api, 'after_compaction');
      if (!wsResult.ok) {
        api.logger.error(
          `[PD:after_compaction] workspaceDir resolution failed. ` +
          `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} sessionId=${ctx.sessionId ?? '(missing)'}. ` +
          `Hook skipped. NextAction: ${wsResult.nextAction}`,
        );
        return;
      }
      if (wsResult.consistencyWarning) {
        api.logger.warn(`[PD:after_compaction] ${wsResult.consistencyWarning}`);
      }
      return handleAfterCompaction(event, { ...ctx, workspaceDir: wsResult.workspaceDir });
    }));

    // ── Hook: Before Message Write (PRI-346) ──
    // Fallback trajectory collection when llm_output is blocked by
    // missing allowConversationAccess. Not in CONVERSATION_HOOK_NAMES
    // so OpenClaw always delivers it.
    hookRegistrations.register(
      'hook:before_message_write',
      'before_message_write',
      guardHook('hook:before_message_write', api.logger, (event: PluginHookBeforeMessageWriteEvent, ctx: PluginHookAgentContext): void => {
        const wsResult = resolveHookWorkspaceDir(ctx, api, 'before_message_write');
        if (!wsResult.ok) {
          api.logger.warn(`[PD:before_message_write] workspaceDir resolution failed: ${wsResult.reason}`);
          return;
        }
        try {
          TrajectoryCollector.handleBeforeMessageWrite(event, {
            ...ctx,
            workspaceDir: wsResult.workspaceDir,
            pluginConfig: getPluginEntry(api.config, api.id),
          });
        } catch (err) {
          // Non-critical: don't surface to user
          api.logger.warn(`[PD:before_message_write] error: ${String(err)}`);
        }
      })
    );

    // PRI-1110: freeze the hook set that was actually registered before any
    // AA invocation can build its config identity snapshot.
    setAdaptiveHookSet(hookRegistrations.snapshot());

    // ── Service Registration (surface-guarded) ──
    // Legacy EvolutionWorker service registration removed (PRI-294 started it
    // via the before_prompt_build hook gate; the whole worker chain retired in
    // PRI-737).
    try {
      const guardedCorrectionObserver = guardService('service:correction-observer', CorrectionObserverService, api.logger);
      if (guardedCorrectionObserver) api.registerService(guardedCorrectionObserver);
      const guardedTrajectory = guardService('service:trajectory', TrajectoryService, api.logger);
      if (guardedTrajectory) api.registerService(guardedTrajectory);
      const guardedPdTask = guardService('service:pd-task', PDTaskService, api.logger);
      if (guardedPdTask) api.registerService(guardedPdTask);
      const guardedAutoConsumer = guardService('service:internalization-auto-consumer', InternalizationAutoConsumerService, api.logger);
      if (guardedAutoConsumer) api.registerService(guardedAutoConsumer);
    } catch (err) {
      api.logger.error(`[PD] Failed to register services: ${String(err)}`);
    }

    // ── Slash Commands ──
    // Register command with optional short alias
     
    const registerCommandWithAlias = (name: string, alias: string | null, desc: string, handler: any, opts?: { acceptsArgs?: boolean }) => {
      const base = {
        name,
        description: desc,
        handler,
        ...(opts?.acceptsArgs ? { acceptsArgs: true } : {}),
      };
      api.registerCommand(base);
      if (alias) {
        api.registerCommand({
          ...base,
          name: alias,
          description: `${desc} (alias of /${name})`,
        });
      }
    };

     
    registerCommandWithAlias('pd-init', 'pdi', getCommandDescription('pd-init', language), (ctx: any) => handleInitStrategy(ctx));
     
    registerCommandWithAlias('pd-bootstrap', 'pdb', getCommandDescription('pd-bootstrap', language), (ctx: any) => handleBootstrapTools(ctx));

    registerCommandWithAlias('pd-research', 'pdr', getCommandDescription('pd-research', language), (ctx: any) => handleResearchTools(ctx));

    registerCommandWithAlias('pd-help', 'pdh', getCommandDescription('pd-help', language), () => {
        if (language === 'zh') {
          return { text: `
📖 **Principles Disciple 命令大全**

## 🚀 快速开始
| 短命令 | 长命令 | 用途 |
|--------|--------|------|
| \`/pdi\` | \`/pd-init\` | 初始化工作区（生成 PRINCIPLES.md、THINKING_OS.md 等） |
| \`/pdb\` | \`/pd-bootstrap\` | 扫描环境工具并建议升级 |
| \`/pdr\` | \`/pd-research\` | 研究工具升级方案 |

## 📊 状态与监控
| 短命令 | 长命令 | 用途 |
|--------|--------|------|
|  | \`/pd-status\` | 查看系统状态（会话、规则词典） |
|  | \`/pd-pain\` | 从 OpenClaw 会话报告 pain |

## ⚙️ 配置与上下文
| 命令 | 用途 |
|------|------|
| \`/pd-context\` | 控制上下文注入 [status\\|thinking\\|reflection\\|focus\\|preset] |
| \`/pd-focus\` | 管理 CURRENT_FOCUS.md [status\\|history\\|compress\\|rollback] |

## ↩️ 回滚操作
| 命令 | 用途 |
|------|------|
| \`/pd-rollback\` | 回滚情绪事件惩罚 <event-id>\\|last |
| \`/pd-principle-rollback\` | 回滚原则并加入黑名单 <principle-id> [reason] |

## 📦 数据与导出
| 命令 | 用途 |
|------|------|
| \`/pd-export\` | 导出数据 [analytics\\|corrections --redacted] |
| \`/pd-samples\` | 查看或审核纠错样本 [review approve\\|reject <sample-id> [note]] |

## 🔧 实现生命周期（半废弃）
> ⚠️ 以下命令的 replay 生成路径已在 PRI-230 退役，仅查询/状态相关子命令可用。

| 命令 | 用途 |
|------|------|
| \`/pd-promote-impl\` | 提升候选实现到 active [list\\|show <id>\\|<id>] |
| \`/pd-disable-impl\` | 禁用 active 实现 [list\\|<id> --reason "..."] |
| \`/pd-archive-impl\` | 永久归档实现 [list\\|<id>] |
| \`/pd-rollback-impl\` | 回滚到上一个 active 实现 [list\\|<id> --reason "..."] |

## ❓ 帮助
| 命令 | 用途 |
|------|------|
| \`/pd-help\` | 显示本帮助 |

💡 完整文档请访问：https://principles-disciple.dev/docs/slash-commands
`.trim() };
        } else {
          return { text: `
📖 **Principles Disciple Command Reference**

## 🚀 Quick Start
| Short | Full | Purpose |
|-------|------|---------|
| \`/pdi\` | \`/pd-init\` | Initialize workspace (PRINCIPLES.md, THINKING_OS.md, etc.) |
| \`/pdb\` | \`/pd-bootstrap\` | Scan environment tools and suggest upgrades |
| \`/pdr\` | \`/pd-research\` | Research tool upgrade solutions |

## 📊 Status & Monitoring
| Short | Full | Purpose |
|-------|------|---------|
|  | \`/pd-status\` | View system status (session, rule dictionary) |
|  | \`/pd-pain\` | Report pain from OpenClaw session |

## ⚙️ Configuration & Context
| Command | Purpose |
|---------|---------|
| \`/pd-context\` | Control context injection [status\\|thinking\\|reflection\\|focus\\|preset] |
| \`/pd-focus\` | Manage CURRENT_FOCUS.md [status\\|history\\|compress\\|rollback] |

## ↩️ Rollback
| Command | Purpose |
|---------|---------|
| \`/pd-rollback\` | Rollback empathy event penalty <event-id>\\|last |
| \`/pd-principle-rollback\` | Rollback principle and blacklist pattern <principle-id> [reason] |

## 📦 Data & Export
| Command | Purpose |
|---------|---------|
| \`/pd-export\` | Export data [analytics\\|corrections --redacted] |
| \`/pd-samples\` | List or review correction samples [review approve\\|reject <sample-id> [note]] |

## 🔧 Implementation Lifecycle (Semi-deprecated)
> ⚠️ Replay generation path for these commands was retired in PRI-230. Only list/show/status subcommands remain useful.

| Command | Purpose |
|---------|---------|
| \`/pd-promote-impl\` | Promote candidate implementation to active [list\\|show <id>\\|<id>] |
| \`/pd-disable-impl\` | Disable active implementation [list\\|<id> --reason "..."] |
| \`/pd-archive-impl\` | Archive implementation permanently [list\\|<id>] |
| \`/pd-rollback-impl\` | Rollback to previous active implementation [list\\|<id> --reason "..."] |

## ❓ Help
| Command | Purpose |
|---------|---------|
| \`/pd-help\` | Show this help |

💡 Full documentation: https://principles-disciple.dev/docs/slash-commands
`.trim() };
        }
    });

    api.registerCommand({
      name: "pd-status",
      description: getCommandDescription('pd-status', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          // Ensure workspaceDir is in config for handlePainCommand
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handlePainCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-status failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "pd-pain",
      description: getCommandDescription('pd-pain', language),
      acceptsArgs: true,
      handler: async (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          ctx.workspaceDir = workspaceDir;
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return await handlePainReportCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-pain failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "pd-context",
      description: getCommandDescription('pd-context', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleContextCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-context failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "pd-focus",
      description: getCommandDescription('pd-focus', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleFocusCommand(ctx, api);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-focus failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });


    api.registerCommand({
      name: "pd-principle-rollback",
      description: getCommandDescription('pd-principle-rollback', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handlePrincipleRollbackCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-principle-rollback failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "pd-rollback",
      description: getCommandDescription('pd-rollback', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleRollbackCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-rollback failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });

    // ── Tools ──
    api.registerCommand({
      name: "pd-export",
      description: getCommandDescription('pd-export', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleExportCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-export failed: ${String(err)}`);
          return { text: language === 'zh' ? "导出失败，请检查日志。" : "Export failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "pd-samples",
      description: getCommandDescription('pd-samples', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleSamplesCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-samples failed: ${String(err)}`);
          return { text: language === 'zh' ? "样本命令执行失败，请检查日志。" : "Samples command failed. Check logs." };
        }
      }
    });

    // ── Implementation Lifecycle Commands (Phase 13) ──
    api.registerCommand({
      name: "pd-promote-impl",
      description: getCommandDescription('pd-promote-impl', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handlePromoteImplCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-promote-impl failed: ${String(err)}`);
          return { text: language === 'zh' ? '\u547d\u4ee4\u6267\u884c\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u65e5\u5fd7\u3002' : 'Command failed. Check logs.' };
        }
      }
    });

    api.registerCommand({
      name: "pd-disable-impl",
      description: getCommandDescription('pd-disable-impl', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleDisableImplCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-disable-impl failed: ${String(err)}`);
          return { text: language === 'zh' ? '\u547d\u4ee4\u6267\u884c\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u65e5\u5fd7\u3002' : 'Command failed. Check logs.' };
        }
      }
    });

    api.registerCommand({
      name: "pd-archive-impl",
      description: getCommandDescription('pd-archive-impl', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleArchiveImplCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-archive-impl failed: ${String(err)}`);
          return { text: language === 'zh' ? '\u547d\u4ee4\u6267\u884c\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u65e5\u5fd7\u3002' : 'Command failed. Check logs.' };
        }
      }
    });

    api.registerCommand({
      name: "pd-rollback-impl",
      description: getCommandDescription('pd-rollback-impl', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleRollbackImplCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-rollback-impl failed: ${String(err)}`);
          return { text: language === 'zh' ? '\u547d\u4ee4\u6267\u884c\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u65e5\u5fd7\u3002' : 'Command failed. Check logs.' };
        }
      }
    });

  }
};

// PrincipleTreeLedgerAdapter is exported from @principles/core/runtime (canonical,
// consolidated in PRI-459). The plugin-local duplicate was removed; re-export the core
// symbol so any external consumer importing from the plugin still resolves it.
export { PrincipleTreeLedgerAdapter } from '@principles/core/runtime';
/* istanbul ignore next — test exports */
export { loadFeatureFlagFromWorkspace, isRecord };

// Schema initialization exports for `pd runtime init` (unified DB init).
// These functions open the DB in write mode, apply the full schema, and close the DB.
// They do NOT run runtime side-effects (importLegacyArtifacts, pruneUnreferencedBlobs).
export { initTrajectorySchema } from './core/trajectory.js';

export default plugin;
