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
