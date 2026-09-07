/**
 * Host abstraction barrel (ADR-0020 §2.2, §2.3)
 *
 * Pure types and type guards only. No I/O.
 *
 * Two abstractions:
 * - HostAdapter: runtime hook event decode/encode (in-process vs subprocess).
 * - HostInstaller: install/uninstall/detect lifecycle for host-side wiring.
 */
// HostAdapter — runtime hook contract
export type {
  HostEventKind,
  HostEventContext,
  HostEvent,
  HostDecision,
  HostEventResult,
  HostAdapter,
} from './host-adapter.js';

export {
  HOST_EVENT_KINDS,
  isHostEventKind,
  isHostDecision,
  isHostEventContext,
  isHostEvent,
  isHostEventResult,
} from './host-adapter.js';

// HostInstaller — install/uninstall lifecycle
export type {
  HostInstallContext,
  HostRuntimeProfileInput,
  HostUninstallContext,
  HostConfigAction,
  HostInstallResult,
  HostUninstallResult,
  HostDetectResult,
  HostDetectPath,
  HostInstaller,
} from './host-installer.js';

export {
  isHostConfigAction,
  isHostInstallResult,
  isHostUninstallResult,
} from './host-installer.js';

// PRI-625 Slice D: ONE legacy-registration predicate (§17 retirement). Pure
// parse — consumers do their own hooks.json I/O at the edge.
export {
  parseLegacyCodexHooksRegistration,
  PD_HOOKS_MARKER,
  CODEX_HOOK_EVENT_NAMES,
} from './legacy-registration.js';
export type { LegacyCodexRegistration } from './legacy-registration.js';
