/**
 * OpenClaw host tool declaration persistence — plugin I/O boundary.
 *
 * Extracted from the retired Gateway internalization auto-consumer service
 * in the PRI-1278 service-host-only consolidation: the consuming timer chain
 * is deleted (the PD Service Host is the only background runtime, driving
 * `pd openclaw worker --once`), but the declaration is a FACT about the host
 * adapter, not consumer behavior — the Gateway keeps refreshing it on every
 * start so host-neutral consumers (the openclaw worker, pd-cli activation /
 * run-once reliability validation) load the SAME registry instead of
 * guessing the host.
 */
import {
  saveHostToolDeclaration,
  HOST_TOOL_DECLARATION_VERSION,
} from '@principles/host-runtime';
import { OPENCLAW_TOOL_SEMANTIC_MAPPINGS } from '../constants/tool-semantics.js';

/**
 * PRI-741 (review round): persist the OpenClaw tool declaration as workspace
 * provenance — host-neutral consumers (pd-cli activation / run-once) load it
 * to run reliability validation with the SAME registry instead of guessing
 * the host. The declaration derives from this package's constants (single
 * source) and is a FACT about the host: it is refreshed on EVERY gateway
 * start, independent of any consumption flag, so a workspace never keeps a
 * stale declaration whose phantom names defeat the activation gate's
 * hasHostTool check.
 */
export function persistOpenClawToolDeclaration(
  workspaceDir: string,
  logger: { warn: (msg: string) => void },
): void {
  // Containment (PRI-595 pattern): declaration persistence is an optimization
  // on top of gateway startup — an fs-level throw here must never break
  // plugin registration itself.
  try {
    const declared = saveHostToolDeclaration(workspaceDir, {
      version: HOST_TOOL_DECLARATION_VERSION,
      hostKind: 'openclaw',
      mappings: OPENCLAW_TOOL_SEMANTIC_MAPPINGS,
      declaredAt: new Date().toISOString(),
    });
    if (!declared.ok) {
      logger.warn(`[PD:ToolDeclaration] Failed to persist OpenClaw tool declaration: ${declared.reason} — pd-cli reliability validation will not find it (rc-9)`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[PD:ToolDeclaration] Failed to persist OpenClaw tool declaration: ${message} — pd-cli reliability validation will not find it (rc-9)`);
  }
}
