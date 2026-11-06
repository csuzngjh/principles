---
"@principles/core": minor
"@principles/host-runtime": minor
"@principles/pd-cli": patch
"principles-disciple": minor
"create-principles-disciple": patch
---

core: `abstraction_layer_v1` is retired to a `gone` tombstone (PRI-1137). The flag ID stays in the contract, but a stale `enabled: true` in user config can no longer re-enable the legacy prompt route — it yields the existing "cannot be re-enabled" warning instead. No config migration is shipped and user `.pd/config.yaml` is never rewritten.

host-runtime: OpenClaw gains a single shared prompt route with an optional `roundKeyProvider` (PRI-1137). `createOpenClawHostRuntime` / `createProductionHostRuntime` accept it; only OpenClaw injects a real session-turn ordinal (`nextSessionTurnOrdinal`) and Codex/WorkBuddy remain without round authority. When the ordinal cannot be read the selector falls back to `legacy_fifo_prefix_v1` with an observable warning — it never fabricates a round. Prompt projection/status/deliverability now share the `full_directive_context` budget basis; an unbound target host is reported as `confirmed` with per-host attribution instead of `unconfirmed`, and `productionRotates` is the single rotation signal.

pd-cli: `prompt-capacity-measurement.mjs` measures the same single production route.

principles-disciple: the three prompt hooks no longer branch between plugin-local and shared rendering; every standard host goes through the shared runtime. Signal collection, adaptive activation, controlled admission, manual owner pain, prompt enrichment, receipts and delivery evidence are retained. `shouldUseSharedHostRuntime`, `runtimeGateCache` and `runtimeGateFor` are deleted. Frozen wire literals (`legacy_fifo_prefix_v1`, `fair_rotation_v1`, `runtime_v2_prompt_activations_injected`, …) are unchanged.

create-principles-disciple: bundles the plugin, so it follows the same version pass.
