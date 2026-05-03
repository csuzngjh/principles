/**
 * Internalization module barrel — RuleHost contracts and helpers
 *
 * PRI-42: Pure domain contracts extracted from the plugin layer.
 * These types have zero infrastructure dependency and are reusable
 * by pd-cli and future non-OpenClaw hosts.
 */

// Contracts
export type {
  RuleHostInput,
  RuleHostDecision,
  RuleHostMeta,
  RuleHostResult,
  LoadedImplementation,
} from './rule-host-contracts.js';

// Helpers
export type { RuleHostHelpers } from './rule-host-helpers.js';
export { createRuleHostHelpers } from './rule-host-helpers.js';
