/**
 * Anonymous Product Telemetry v1 — OpenClaw plugin trigger (PRI-599).
 *
 * Fire-and-forget scheduling from the per-workspace one-time init inside
 * before_prompt_build. The gateway process is long-lived, so the unref'd
 * timer plus the service's contained failure paths guarantee telemetry can
 * never block or crash a hook. All gating (feature flag + consent +
 * environment eligibility) happens inside the service.
 */

import {
  createProductTelemetryService,
  scheduleProductTelemetryExport,
} from '@principles/host-runtime';

export interface TelemetryTriggerLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export function scheduleTelemetryExportForWorkspace(workspaceDir: string, logger?: TelemetryTriggerLogger): void {
  const service = createProductTelemetryService({ ...(logger !== undefined ? { logger } : {}) });
  scheduleProductTelemetryExport(service, workspaceDir, logger);
}
