---
"@principles/core": minor
---

Config validation: a declared runtime-profile field can no longer disappear silently.

- **Fixed:** `runtimeProfiles.*` pi-ai profiles now keep `systemPrompt`. It was declared on `PdLocalRuntimeProfile` and forwarded to the adapter by `createAdapterConfigFromProfile`, but `validatePdLocalProfile` never copied it — a configured system prompt was accepted with `ok: true`, then dropped with no warning. The same class of defect is now structurally blocked: `PROFILE_FIELDS` is a compile-time exhaustive table over `keyof PdLocalRuntimeProfile`, and the validator self-checks that every supplied field reached the validated result.
- **Behaviour change (fail loud):** an unknown key in a pi-ai profile, or in an `internalAgents.agents.<name>` binding, is now a validation error instead of being silently ignored. Previously a misspelled key (e.g. `systemPromt`) looked configured while nothing read it; it now reports `unknown field '<key>'`.
- **Removed:** `InternalAgentBinding.splitPipelineTimeoutMs`. This field has never been read by any code since it was introduced — keeping it in the type advertised configuration that did nothing. A config that still sets it now fails with the unknown-field error above.
