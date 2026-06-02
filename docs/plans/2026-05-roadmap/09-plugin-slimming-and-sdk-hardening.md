# 09 - Plugin Slimming and SDK Hardening Plan

> **Status**: Active planning document
> **Date**: 2026-06-02
> **Decision source**: ADR-0014 MVP-First Strategy + post-PRI-286 cleanup discussion
> **Goal**: Make PD easier to understand, maintain, and ship by shrinking the OpenClaw plugin into a thin adapter and moving stable behavior-internalization logic into Runtime V2 / `packages/principles-core/src/runtime-v2` / Console / CLI.

## 0. One-line Summary

PD must stop behaving like a generic agent operating system. During MVP, the OpenClaw plugin should only adapt OpenClaw events into PD's owner-reviewed behavior internalization loop. Old prompt scaffolds, orchestration surfaces, and strategy tools should be deleted or archived unless they directly support the MVP loop.

## 1. Product Boundary

PD owns:

- pain / evidence capture for behavior problems
- diagnosis and candidate principle generation
- owner review
- reversible activation through `prompt`, `code_tool_hook` / RuleHost, and `defer_archive`
- observability that proves the activation is actually live

PD does not own:

- general task execution
- generic agent planning mode
- generic memory
- generic tool retry / repair
- autonomous value decisions
- a broad "agent operating system" prompt scaffold

This distinction matters because early plugin code mixed all of these concerns into one OpenClaw plugin. The cleanup goal is not aesthetic. It is required to keep the MVP path understandable and reliable enough for seed users.

## 1.1 ADR-0014 Amendment Reconciliation

ADR-0014 has a 2026-05-30 amendment that promotes two observers to MVP-Core:

- **Empathy Observer**: wired asynchronously in the prompt build hook to capture frustration / emotional friction that explicit manual pain capture misses.
- **Correction Observer**: intended as a lightweight SDK-level periodic optimizer that adjusts keyword weights and reduces false positives.

This plan must not delete or accidentally disable either observer.

Hard constraints:

- **GFI scoring engine is MVP-Core when used for empathy evidence.** It must not be deleted as part of prompt diet. It is used by `trackFriction(...)` and the empathy pain path to accumulate friction and emit pain when thresholds are crossed.
- **GFI attitude / personality prompt text is not MVP-Core.** It can be removed from user-visible agent prompt behavior because it is not owner-reviewed and creates behavior noise.
- **Correction Observer cannot remain dependent on a default-off legacy worker if it is MVP-Core.** Current code has Correction Observer integration under the EvolutionWorker heartbeat while the `evolution_worker` feature is quiet/default-off. That is a real code/docs mismatch. The cleanup must either:
  - extract Correction Observer into an independently gated MVP-Core observer with its own live trigger and tests, or
  - run a maintainer-approved product decision to downgrade Correction Observer back to MVP-Quiet.

Until that decision is made, Phase 3 must treat Correction Observer as protected. Do not delete it while deleting or quarantining EvolutionWorker-era code.

## 2. Current Prompt Principle Injection

Runtime V2 prompt activation is already connected to the live OpenClaw prompt path.

Current flow:

```text
pain / diagnosis / principle artifact
  -> evaluator validates the principle-bearing artifact
  -> owner approves activation
  -> activations table records channel=prompt + action=prompt_activate
  -> OpenClaw before_prompt_build hook fires
  -> PromptActivationReader reads Runtime V2 prompt activations
  -> only validated principle artifacts are rendered
  -> owner-approved directives are injected into prependSystemContext
  -> runtime_v2_prompt_activations_injected event is emitted
```

Important files:

- `packages/principles-core/src/runtime-v2/activation/activation-types.ts`
- `packages/principles-core/src/runtime-v2/activation/sqlite-activation-state-store.ts`
- `packages/openclaw-plugin/src/core/runtime-v2-prompt-activation-reader.ts`
- `packages/openclaw-plugin/src/hooks/prompt.ts`
- `packages/openclaw-plugin/tests/hooks/runtime-v2-prompt-activation.test.ts`

Important runtime constraints:

- Only `channel === 'prompt'` and `action === 'prompt_activate'` are injected.
- Only artifacts with validated status are injected.
- Runtime V2 directives use a bounded budget.
- Injection emits `runtime_v2_prompt_activations_injected` with `principleIds`, `activationIds`, `injectedCount`, `injectedCharCount`, `budget`, and `skippedWarnings`.
- Runtime V2 directives are injected through `prependSystemContext`, not merely appended as low-priority legacy `<evolution_principles>`.

Legacy `<evolution_principles>` can remain temporarily for compatibility, but the MVP proof path is Runtime V2 activation -> `prependSystemContext`.

## 3. Thinking OS Decision

Thinking OS is not MVP-Core.

It is useful as a historical design artifact and as a possible post-MVP optional coaching pack, but it should not remain in the default plugin prompt path.

Reasons:

- It is a generic reasoning scaffold, not an owner-reviewed principle.
- It consumes prompt budget and competes with Runtime V2 activated directives.
- It makes user-observable behavior ambiguous: the agent may be following PD-learned principles or a built-in thinking template.
- It pulls PD back toward a generic agent OS, contradicting ADR-0014.
- If a Thinking OS behavior is valuable, PD should be able to learn it through pain -> principle -> owner approval -> activation.

Decision:

- Remove Thinking OS from default prompt injection.
- Disable or remove `/pd-thinking` from the MVP user surface.
- Remove Thinking OS usage tracking from MVP live path.
- Archive templates under a historical or post-MVP area only if they are still useful as product research material.
- Do not delete Runtime V2 prompt activation or legacy principle compatibility while doing this.

Implementation note:

- Thinking OS is currently controlled by workspace context/profile configuration such as `defaultContextConfig.thinkingOs`, not by the Runtime V2 feature flag registry.
- Default-disable requires changing the context/profile default or adding a real feature flag with loader + tests. Do not merely add a registry entry that claims Thinking OS is disabled while `prompt.ts` still injects it.
- Removing `/pd-thinking` also requires updating command registration, aliases, help text, i18n command descriptions, and tests.

## 4. Cleanup Classification

| Area | Decision | Replacement / Owner | Notes |
|------|----------|---------------------|-------|
| Runtime V2 prompt activation | Keep | Runtime V2 + plugin adapter | MVP-Core |
| RuleHost before_tool_call gate | Keep | Runtime V2 RuleHost + plugin adapter | MVP-Core |
| Pain / empathy event entry | Keep | Plugin event adapter + core classifier | MVP-Core |
| Empathy Observer | Keep / harden | Prompt hook observer + GFI scoring | MVP-Core by ADR-0014 amendment |
| Correction Observer | Extract or explicitly downgrade | Runtime V2/core observer, not default-off worker | Protected until decision |
| Feedback drafts | Keep | Console/API/CLI feedback path | MVP-Core for seed feedback |
| Thinking OS prompt block | Remove from default | Post-MVP archive only | Not owner-reviewed |
| `/pd-thinking` command | Disable/remove | None in MVP | Do not expose as live product |
| Focus / current focus prompt | Disable/remove | None in MVP | Generic memory, not PD core |
| GFI scoring engine | Keep | Empathy evidence / health | Do not delete |
| GFI attitude prompt | Disable from user prompt | None in MVP prompt | Avoid behavior noise |
| Local worker routing guidance | Remove | OpenClaw owns task routing | Prompt injection still exists in `prompt.ts` |
| Subagent shadow observation | Already quiet; delete or keep-quiet decision | Post-MVP only | Not required for MVP story |
| JSONL trajectory collector | Already quiet; keep narrow if evidence needs it | Evidence ingestion only if needed | Check L3/pain evidence dependencies before deletion |
| CentralSyncService | Already quiet; delete/quarantine | None in MVP | Not seed-user critical |
| PLAN.md / confirm-first built-in gate | Removed | Can re-emerge through RuleHost activation | Already aligned by PRI-286 |
| OKR / strategy / daily / grooming skills | Delete from plugin bundle | None in MVP | Product-scope drift |
| Nocturnal / idle / sleep cycle surfaces | Delete/archive | None in MVP | MVP-Gone |
| Legacy probation prompt injection | Migrate then delete | Runtime V2 activation | Avoid two sources of truth |

## 4.1 Already-Quarantined Inventory

Before deleting code, confirm whether the surface is already quiet/default-off through `PLUGIN_SURFACE_REGISTRY`, `guardHook(...)`, `guardService(...)`, or feature flags. If it is already quiet, the issue is physical deletion or continued quarantine, not "turn it off".

Known already-quarantined or default-off surfaces include:

- trajectory hook paths such as `hook:after_tool_call.trajectory` and `hook:llm_output.trajectory`
- subagent shadow observation hooks
- reset / compaction lifecycle hooks
- services such as EvolutionWorker, trajectory service, PD task service, and CentralSyncService
- startup paths guarded by `evolution_worker`

Execution rule:

- Do not reimplement a second disable mechanism for an already-disabled surface.
- First verify the guard is effective.
- Then decide whether the code should be physically deleted or kept quiet for one release.

## 4.2 Cut-callers Before Delete

Every deletion slice must be two-step unless the code is already unreachable and covered by a guard:

1. **Cut callers / mark dead / verify live behavior**.
2. **Physically delete dead files, templates, docs, and tests**.

This avoids deleting code that still has production callers and makes regressions easier to attribute.

## 5. Implementation Sequence

### Phase 0: Finish registry truthfulness

Goal: Make the registry guard describe real hook/service surfaces without overclaiming prompt sections.

Actions:

- Keep hook/service registry focused on actual OpenClaw hook handlers and live services.
- Do not list `prompt_section:thinking_os` as guarded MVP state unless the guard can prove actual prompt injection is disabled.
- Defer prompt-section inventory to Phase 1.
- Treat already-quarantined hook/service entries as the source of truth for which surfaces are off by default.

Acceptance:

- Registry tests do not claim Thinking OS is quiet/off while `prompt.ts` still injects it.
- No stale-main rollback of PRI-286 or feedback work.

Relevant ERR:

- ERR-027: docs/spec/registry drift from executable reality.
- ERR-025: tests must prove production behavior, not just isolated declarations.

### Phase 1: Prompt diet

Goal: Remove non-MVP prompt sections from the default live OpenClaw prompt path while preserving Runtime V2 owner-approved directive injection.

Actions:

- Remove or default-disable Thinking OS injection in `packages/openclaw-plugin/src/hooks/prompt.ts`.
- Remove or default-disable focus/current-focus prompt content.
- Remove or default-disable GFI attitude prompt content from agent behavior prompt.
- Preserve the GFI scoring engine and the empathy pain path that uses `trackFriction(...)` and threshold-based `emitPainDetectedEvent(...)`.
- Remove local worker routing guidance injection from `packages/openclaw-plugin/src/hooks/prompt.ts`, including `<routing_guidance>` prompt blocks and prompt-side calls into local-worker routing helpers.
- Keep Runtime V2 directives in `prependSystemContext`.
- Keep legacy `<evolution_principles>` only if still required for compatibility.
- Because Thinking OS is currently profile/context controlled, default-disable it through the real profile/context path or introduce a tested feature flag. Do not add a registry-only declaration.
- Emit structured warnings when a disabled prompt section is skipped.

Acceptance:

- Runtime V2 prompt activation still emits `runtime_v2_prompt_activations_injected`.
- Activated principle text still appears in `prependSystemContext`.
- Thinking OS text does not appear in default prompt output.
- `<routing_guidance>` does not appear in default prompt output.
- Empathy/GFI scoring still records friction and can emit pain when thresholds are crossed.
- Prompt-size guard tests are updated to reflect the new priority order.
- Live OpenClaw smoke confirms prompt hook still fires.

Relevant ERR:

- ERR-002: disabled/skipped prompt sections need reason/observability.
- ERR-048: activation write path must stay connected to prompt read path.

### Phase 2: Delete non-MVP plugin resources

Goal: Reduce installation bundle and user-visible confusion by removing old strategy/orchestration resources.

Actions:

- Delete or archive plugin templates for OKR, strategy, daily/grooming, AI sprint, evolve, PLAN/AUDIT, Nocturnal/idle/sleep-cycle user surfaces.
- Disable or remove commands that only serve these resources.
- When removing commands, update command registration, aliases, help output, i18n descriptions, command reference docs, and tests in the same PR.
- Keep resources required for Runtime V2, pain capture, RuleHost, feedback, health, installer, and Console.
- Keep ambiguous resources until caller inventory proves they are not part of the MVP chain. In particular, do not delete diagnosis, runtime-v2, pain-signal, feedback, RuleHost, or operator resources in the same broad sweep.
- Update package/bundle tests so deleted resources are not expected in npm tarball.

Acceptance:

- `npm pack --dry-run` or equivalent packaged-install smoke confirms the plugin still contains required MVP assets.
- OpenClaw gateway loads the plugin.
- `pd runtime features --json`, Console health, feedback draft, and prompt activation smoke still pass.

Relevant ERR:

- ERR-040: published artifact must contain all required components.
- ERR-041: install success must require all required components.
- ERR-025: source-tree tests are not enough.

### Phase 3: Split and shrink EvolutionWorker-era services

Goal: Stop one legacy service from owning unrelated behavior. Keep only MVP evidence/activation needs.

Actions:

- Inventory actual callers of EvolutionWorker-era services.
- Identify whether each target is already guarded/quiet. If yes, classify as physical deletion vs keep-quiet, not a new disablement task.
- Split live MVP responsibilities into small services:
  - pain/evidence adapter
  - prompt activation adapter
  - RuleHost gate adapter
  - optional minimal trajectory evidence reader
- Extract or explicitly preserve Correction Observer before removing/quarantining the worker heartbeat that currently hosts it.
- Remove or quarantine queue backfill, watchdog, shadow observation, local worker routing, and stale lifecycle hooks only after proving no MVP caller remains.
- Do not modify frozen legacy files: `nocturnal-trinity.ts`, `nocturnal-arbiter.ts`, `nocturnal-service.ts`.

Acceptance:

- Hook tests still cover `before_prompt_build`, `before_tool_call`, `after_tool_call`, and `llm_output` where still enabled.
- No duplicate startup worker is left running.
- Correction Observer has an explicit live owner: independent MVP-Core observer, or maintainer-approved downgrade to MVP-Quiet.
- Health/canary output remains explainable.

Relevant ERR:

- ERR-024: dead validator/service that is not wired to enforcement is illusory.
- ERR-025: tests must exercise production hook paths.

### Phase 4: Move stable contracts into Runtime V2 / core

Goal: Make plugin code thin by moving pure contracts and validation into `packages/principles-core/src/runtime-v2` or another explicit core module. There is no separate SDK package today.

Actions:

- Move PromptActivationReader pure filtering/rendering contract into `packages/principles-core/src/runtime-v2` if it can remain pure.
- Keep plugin responsible only for workspace binding, OpenClaw hook context, and event logging.
- Move RuleHost input construction and validation into pure core helpers where possible.
- Move feature-flag parsing/validation into core only if it stays pure. Workspace file loading remains in plugin/CLI/Console I/O boundary.
- Add architecture guards preventing OpenClaw-specific imports from core.

Acceptance:

- `packages/principles-core` remains pure: no fs/db/network/OpenClaw imports in pure modules.
- Plugin adapter files become smaller and mostly orchestrate OpenClaw context -> core service -> OpenClaw response.
- Runtime contract tests cover untrusted DB/artifact/config input without `as` bypass.

Relevant ERR:

- ERR-001 / ERR-005 / ERR-013: runtime validation for untrusted input.
- ERR-011: I/O orchestration must stay behind the correct boundary.

### Phase 5: Approval and RuleHost activation hardening

Goal: Ensure the three MVP activation channels remain real after the cleanup.

Actions:

- Re-run Console approval flow for prompt activation.
- Re-run code_tool_hook activation through RuleHost, including approval queue and activation record.
- Re-run defer_archive activation path.
- Confirm each channel has a disable or rollback path visible to the operator.

Acceptance:

- Prompt activation changes live prompt behavior or at least injects visible directive evidence.
- RuleHost activation produces live `rulehost_evaluated` and block/allow behavior according to the activated rule.
- Defer archive produces observable archive/defer state.
- Console and CLI outputs contain reason and nextAction on degraded paths.

Relevant ERR:

- ERR-048: activation write path connected to live read path.
- ERR-024: enforcement must be wired, not only validated.

### Phase 6: Live MVP regression and seed-readiness gate

Goal: Prove the cleaned system still works in the real OpenClaw environment before seed users see it.

Actions:

- Install the current package into local OpenClaw.
- Run one clear task through OpenClaw to verify no overblocking.
- Run one ambiguous/risky task to verify RuleHost can still block when a real activated rule exists.
- Create one manual pain signal.
- Run diagnosis/intake/internalization path as far as current MVP supports.
- Create one feedback draft from Console or CLI.
- Capture canary, queue, integrity, and event log summaries.

Acceptance:

- No PLAN.md built-in gate returns.
- No Thinking OS prompt content appears by default.
- Runtime V2 activated prompt directives inject successfully.
- RuleHost events fire for mutating tools.
- Empathy/GFI evidence path still works.
- Correction Observer ownership is explicit and tested or explicitly deferred by maintainer decision.
- Feedback draft is created locally and not auto-submitted.
- Any degraded health is classified as historical noise, current-chain blocker, or follow-up.

This regression gate should also be run after each deletion phase, not only at the end.

## 6. Suggested Linear Slices

1. `PRI-new: Remove Thinking OS from MVP prompt path`
2. `PRI-new: Delete non-MVP plugin skills and templates`
3. `PRI-new: Reconcile Correction Observer ownership before EvolutionWorker deletion`
4. `PRI-new: Split EvolutionWorker-era services into MVP hook adapters`
5. `PRI-new: Move prompt activation reader contract into Runtime V2 core`
6. `PRI-new: Re-verify prompt / RuleHost / defer_archive / empathy after plugin slimming`

Each issue must answer the MVP three questions:

- What happens if we do not do this?
- How is it observed?
- How is it disabled?

## 7. Non-goals

- Do not build a new planning mode.
- Do not resurrect PLAN.md as a built-in gate.
- Do not add a new activation channel.
- Do not add generic memory or autonomous task routing.
- Do not rewrite frozen Nocturnal files.
- Do not delete production-referenced code without first cutting callers and proving the replacement path.

## 8. Maintainer Review Questions

Before implementation starts, confirm:

1. Should Thinking OS be fully deleted from the plugin bundle, or archived but unreachable by default?
2. Should legacy `<evolution_principles>` remain for one release as compatibility, or be removed in the same cleanup wave?
3. Should Correction Observer be extracted into an independent MVP-Core observer now, or should ADR-0014 be amended to downgrade it back to MVP-Quiet?
4. Should GFI attitude prompt text be removed while preserving GFI scoring for empathy evidence? The recommended answer is yes.
5. Which live OpenClaw smoke task should be reused as the seed-user regression fixture?
