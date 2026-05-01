/**
 * Re-exports the canonical PrincipleTreeLedgerAdapter from @principles/core/runtime-v2.
 *
 * This adapter uses @principles/core's addPrincipleToLedger/loadLedger, which write to
 * <stateDir>/principle_training_state.json (HybridLedgerStore format), matching the ledger
 * format used by the OpenClaw plugin's pain-signal-bridge.
 *
 * audit/repair commands use this adapter — it ensures consistency between
 * what intake writes and what audit/repair read back.
 */
export {
  PrincipleTreeLedgerAdapter,
} from '@principles/core/runtime-v2';