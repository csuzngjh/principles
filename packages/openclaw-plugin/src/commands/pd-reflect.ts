/**
 * PD Reflect Command (/pd-reflect)
 *
 * RETIRED per ADR-0012 — Nocturnal execution has been cut over to Runtime V2.
 * This command no longer enqueues sleep_reflection tasks.
 * Physical module deletion is tracked in PRI-230.
 */

import type { PluginCommandDefinition, PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';

interface PdReflectContext extends PluginCommandContext {}

export const handlePdReflect: PluginCommandDefinition = {
  name: 'pd-reflect',
  description: '[RETIRED] Nocturnal reflection retired per ADR-0012',
  acceptsArgs: false,
  requireAuth: false,
  handler: async (_ctx: PdReflectContext): Promise<PluginCommandResult> => {
    return {
      text: 'This command has been retired. Nocturnal sleep_reflection execution has been cut over to Runtime V2 (ADR-0012). ' +
        'Next action: Use `pd runtime internalization` CLI commands for internalization workflows, or wait for PRI-230 to complete physical deletion of legacy modules.',
    };
  },
};
