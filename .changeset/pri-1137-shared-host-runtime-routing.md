---
"@principles/core": minor
"@principles/host-runtime": major
"@principles/pd-cli": patch
"principles-disciple": major
"create-principles-disciple": patch
---

core: `abstraction_layer_v1` is retired to a `gone` tombstone (PRI-1137). The flag ID stays in the contract, but a stale `enabled: true` in user config can no longer re-enable the legacy prompt route — it yields the existing "cannot be re-enabled" warning instead. No config migration is shipped and user `.pd/config.yaml` is never rewritten.

host-runtime: **major** — the published barrel (`export *`) removes public API: `shouldUseSharedHostRuntime`-era helpers are gone from the plugin surface and the rotation signal changed shape (`productionRotates: boolean` → `productionRotation: 'rotates' | 'does_not_rotate' | 'unknown'`, `productionRouteRotates()` → `productionRouteRotationState()` / `hostRotationCapability()`), because a boolean could not express "no single host is bound" without lying that every host is FIFO. OpenClaw gains a single shared prompt route with an optional `roundKeyProvider` (PRI-1137); only OpenClaw injects a real session-turn ordinal and Codex/WorkBuddy remain FIFO without round authority. A round key is issued ONLY for a persisted user turn of this invocation (heartbeat/empty-message/resolution-failure/write-failure all degrade to `legacy_fifo_prefix_v1` observably); run retries replay their own persisted ordinal. The shared packer decides by exact additive arithmetic over per-block measurements (one render per pack instead of O(N²)) — output byte-identical. `checkPromptArtifactDeliverability` accepts an `authority` override (approve-time prechecks bill the `owner` annotation they stamp) and refuses `unconfirmed` when the authority join read breaks.

pd-cli: `prompt-capacity-measurement.mjs` measures the same single production route; the per-budget oversized statistic now covers the whole corpus (FIFO's early stop hid later oversized candidates).

principles-disciple: **major** — the plugin's public module surface removes the deleted route-gate exports (`shouldUseSharedHostRuntime`, `runtimeGateCache`, `runtimeGateFor`). The three prompt hooks no longer branch between plugin-local and shared rendering; every standard host goes through the shared runtime. Signal collection, adaptive activation, controlled admission, manual owner pain, prompt enrichment, receipts and delivery evidence are retained. Frozen wire literals (`legacy_fifo_prefix_v1`, `fair_rotation_v1`, `runtime_v2_prompt_activations_injected`, …) are unchanged. The after_tool_call adapter now forwards `toolArgs` (the SDK's after-event field) to the shared evidence kernel and surfaces its degradation (`trajectory_db_not_found` etc.) in logs and hook-execution records instead of recording a blind success.

create-principles-disciple: bundles the plugin, so it follows the same version pass.
