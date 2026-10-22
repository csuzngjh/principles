# SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001

Status: Draft → Implemented (PRI-1020, 2026-10-22)
Amends: SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §4.3 (priority chain) — policy version stays `model_aware_v1`

## 1. Problem

After #2093 the runtime resolves the injection budget from confirmed model
capacity only, via two paths:

1. `host_effective_window` — the host hook reports a window with a trusted
   source (`model` | `modelsConfig` | `agentContextTokens`);
2. `pi_catalog_exact` — the declared provider+modelId pair exists in the
   installed pi-ai catalog.

Real-machine evidence (2026-10-21, installed 2.3.9): Codex and WorkBuddy
adapters forward model identity ONLY — neither carries a window fact, and
custom model ids (proxies, local deployments) never match the catalog. Their
budget is therefore locked to the `legacy_fallback` 2000 chars forever, even
when the running model has a 256K+ window. The Owner has no remedy. #2097
(PRI-1017) made the Console honest about this, but honesty does not raise the
budget.

## 2. Capability

A dedicated `promptBudget` section in `.pd/config.yaml` — the Owner's
explicit capacity declaration, the workspace's final authority:

```yaml
promptBudget:
  declaredContextWindowTokens: 262144   # global fallback declaration
  hosts:                                # optional per-host overrides
    codex: 400000
    workbuddy: 262144
```

Semantics:

- **Tier 0 of the budget chain**: `operator_declared` >
  `host_effective_window` > `pi_catalog_exact` > `legacy_fallback`
  (Owner decision 2026-10-22: the declaration is the workspace's final
  authority and must be able to override a mis-reporting host).
- The declared window feeds the SAME formula:
  `budget = clamp(floor(2000 × window / 128000), 1250, 16000)`.
- Resolution is per host: `hosts[hostKind] ?? declaredContextWindowTokens`.
- `capacityStatus: 'confirmed'` — an authored explicit cap is the same trust
  class as upstream `agentContextTokens`.
- The whole section is optional; absent ⇒ the chain behaves exactly as
  before (zero migration). Delete the section to roll back to the fallback.

## 3. Trust and honesty rules

- Values are validated at CONFIG LOAD (rc-3, fail loud): integer within the
  policy's plausibility bounds (`MIN/MAX_PLAUSIBLE_CONTEXT_WINDOW_TOKENS`,
  imported from the policy — one authority), host keys restricted to
  `openclaw | codex | workbuddy`, unknown keys rejected (no ghost config).
  A malformed section is a hard config error, never a silent drop.
- The policy layer defends in depth: an invalid declaration arriving through
  the direct API is ignored and the chain falls through (config validation
  already made this unreachable via files).
- Events carry `budgetCapacitySource: 'operator_declared'` +
  `budgetContextWindowTokens` like every confirmed source. The observation
  reader accepts `operator_declared` as a confirmed source with the same
  coherence rules (window present, exact formula budget, no fallback
  reason); incoherent values are dropped, never guessed.
- `budgetPolicyVersion` stays `model_aware_v1`: existing fields keep their
  semantics, so pre-existing observations remain valid and no observation
  cache is invalidated.
- Console surfaces (grouped badge, activations status, post-approval
  warning) fall back to the DECLARED basis when no fresh runtime observation
  exists. A fresh observation still outranks the declaration in the forecast
  — it is what the runtime actually did last. A stale-observation marker is
  never shown alongside a declared basis that was actually used (the two
  would contradict each other).

## 4. Touch points (all closed sets extended in one PR)

core policy enum + `ResolvePromptBudgetInput.operatorDeclared`; core config
section (types/validate/defaults-unchanged/effective/redaction/barrel);
event schema (static union + TypeBox union); host-runtime injection wiring +
observation reader + `operatorDeclaredBudgetResolution` helper;
openclaw-plugin local route; pd-console contract/validators/UI/i18n;
pd-cli `config doctor` read-only display.

## 5. Acceptance evidence

- Policy chain unit tests (declaration outranks trusted host facts; formula
  clamps; invalid declaration ignored defensively).
- Config section tests (survival, zero migration, fail-loud boundaries).
- Wiring tests: production dispatch records `operator_declared` provenance
  on the shared path AND the plugin-local route.
- Observation reader tests: declared observation round-trips; incoherent
  variants dropped.
- Console model tests: declared basis drives grouped/activations forecasts
  with no observation; fresh observation still wins; wire contract accepts
  the payload.
- Real machine (post-install): declare 262144 → Console badge /4096 without
  waiting for observations → injection event `budget=4096
  budgetCapacitySource=operator_declared` → delete declaration → 2000.
