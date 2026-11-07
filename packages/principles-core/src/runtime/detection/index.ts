/**
 * Detection — PRI-446
 *
 * Pure three-layer pain detection funnel logic. No I/O, no crypto, no plugin
 * imports. Matcher/hasher/gate are injected so core owns the funnel logic while
 * the plugin owns the concrete crypto + dictionary.
 */

export type {
  DetectionResult,
  PainMatchResult,
  PainMatcher,
  TextHasher,
  ProtocolTokenGate,
  DetectionFunnelConfig,
} from './detection-funnel-policy.js';

export { SimpleLRU, DetectionFunnelCore } from './detection-funnel-policy.js';
