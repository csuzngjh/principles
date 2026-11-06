/**
 * Rule Host Adapter — Interface for loading active implementations
 *
 * PURPOSE: Define the adapter interface that plugins/hosts implement
 * to provide loaded implementations to the core decision merge logic.
 *
 * PRI-45: Adapter interface for future non-OpenClaw hosts.
 * OpenClaw plugin does not need to import this explicitly — it uses
 * its own _loadActiveCodeImplementations() and passes results to
 * mergeDecisions() directly.
 */

import type { LoadedImplementation } from './rule-host-contracts.js';

export interface RuleHostImplementationProvider {
  loadActiveImplementations(): LoadedImplementation[];
}
