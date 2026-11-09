---
'principles-disciple': patch
---

Adaptive Activation config compat: declare the `principleId` mapping identity in the plugin manifest `configSchema` (`adaptiveActivation.properties`, `additionalProperties: false` retained). The #2436 runtime reader already accepted this key, but the undeclared key made any principleId config fail the host's load-time plugin-config validation and take down the entire plugin (PRI-1119 PR #2448 blocker 2). Legacy pinned `(artifactId, activationId)` configs are unaffected: identical keywords, identity arbitration stays at the runtime reader (mixed/partial/blank-identity configs keep failing closed to Native at runtime, not at load).
