---
'@principles/core': patch
'create-principles-disciple': patch
---

Upgrade the Pi runtime dependency from @earendil-works/pi-ai / pi-agent-core 0.85.1 to 1.2.0 (SPEC-PD-PI12-COMPAT-001). Migrates the three runtime adapters to the Pi 1.2 agent-loop contract: the system prompt now rides the transcript as a leading system message (also fixing the duplicated user message in every L2 request under 0.85.x), shouldStopAfterTurn is replaced by finishTurn with the upstream canonical error/aborted guard, convertToLlm passes the system role through, and the ToolCall extraction predicate adopts the SDK type (arguments narrowed to JsonObject). Regenerates all installer release locks on the Node 22 / npm 10 toolchain; pi-agent-core's runtime dependency tree shrinks to pi-ai + typebox. No governance, activation, or approval behavior changes; Artificer keeps fail-closed semantics (no L1 fallback) and the Owner-Evidence gate is untouched.
