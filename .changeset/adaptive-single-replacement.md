---
"@principles/core": minor
"@principles/host-runtime": major
"principles-disciple": major
"create-principles-disciple": patch
---

Allow one budget-safe Adaptive Activation replacement when the workspace explicitly lists the outgoing Owner-approved activation in `adaptiveActivation.replaceableActivationIds`. The selector compares the incoming and outgoing directives for the current task; missing permission, protected directives, or stale authorization preserve the Native prompt.

**BREAKING — `@principles/host-runtime` (major).** The exported `AdaptivePriorityProvider` keeps its arity but not its third parameter type: `excludedByBudget: boolean` became `AdaptiveGapOptions` (`excludedByBudget` plus `replacementByActivationId`). The `selectNativeGap` callback of `buildActivePrinciplePromptContext` changed the same way, and `AdaptiveGapOptions` is a new barrel export. A boolean-typed implementation now receives an object at runtime — it type-checks as broken, and a silently accepted boolean would disable the replacement plan. Every in-repo host adapter (Codex, WorkBuddy, OpenClaw) moves in this PR; any external host integration that implements or calls the provider must adopt the object form. Semver: breaking public signature change → major (`docs/architecture/VERSIONING_AND_COMPATIBILITY.md` §2.2).

**BREAKING — `principles-disciple` (major).** The exported `resolveOpenClawNativeGap(...)` helper forwards `AdaptiveGapOptions` as its third host-runtime argument instead of the former boolean. Plugin hooks (`before_prompt_build`) and every frozen wire literal are unchanged.

Level rationale for the remaining packages: `@principles/core` is minor because it only adds the backward-compatible optional config field `adaptiveActivation.replaceableActivationIds` (an additive config schema extension); `create-principles-disciple` is patch because it only bundles the plugin payload and follows the same version pass (C4 assembly edge).
