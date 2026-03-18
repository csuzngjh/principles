# MEMORY

> Updated: 2026-03-18
> Purpose: Persistent working memory for ongoing productization and architecture analysis of Principles Disciple

## Current Shared Understanding

- Principles Disciple is best understood as an externalized learning and governance framework around an LLM agent, not as model training.
- The core idea is: capture pain, convert pain into reflection and principles, then reinject those principles into future reasoning.
- A useful framing is "externalized reinforcement learning" or "context-layer policy shaping", not parameter-layer RL.
- The most mature product value today is governance and risk control, not strong self-evolution.
- `D:\Code\openclaw` is an important upstream dependency repo for this project and should be treated as a standing compatibility reference.
- Future feature work for Principles Disciple should routinely verify OpenClaw plugin APIs, hooks, path/context behavior, and runtime expectations against `D:\Code\openclaw`.

## High-Level Architecture

- Main product code lives in `packages/openclaw-plugin/`.
- Installer CLI lives in `packages/create-principles-disciple/`.
- Main plugin entry: `packages/openclaw-plugin/src/index.ts`
- Prompt injection center: `packages/openclaw-plugin/src/hooks/prompt.ts`
- Safety/governance center: `packages/openclaw-plugin/src/hooks/gate.ts`
- Pain capture: `packages/openclaw-plugin/src/hooks/pain.ts`
- Background evolution loop: `packages/openclaw-plugin/src/service/evolution-worker.ts`
- Principle state machine: `packages/openclaw-plugin/src/core/evolution-reducer.ts`
- Trust model: `packages/openclaw-plugin/src/core/trust-engine.ts`

## Core System Loop

1. Tool failure, gate interception, or user frustration creates a pain signal.
2. Pain is recorded into state and friction/trust systems.
3. The evolution worker converts pain into queued diagnostic work.
4. The reducer turns repeated or important pain into principle objects.
5. Prompt injection reinserts runtime constraints, principles, and thinking context into the next model turn.

Short form:

`failure -> pain -> queue -> reflection/diagnosis -> principle -> reinjection -> behavior shift`

## Product Interpretation

- The system is closer to an "agent immune system" than a magical self-improving mind.
- It helps the agent:
  - make fewer repeated mistakes
  - act more cautiously in risky contexts
  - retain local lessons across tasks
  - behave more like a governed long-term collaborator

## What Is Already Solid

- Governance/risk-control path is the strongest part of the system.
- Hook wiring and background service loop are real, not just documented concepts.
- Prompt reinjection is implemented and central to the design.
- The repo has substantial automated tests in `packages/openclaw-plugin/tests/`.

## What Is Not Yet Proven

- High-quality principle distillation is still limited; many principles are template-like.
- Long-term measurable self-improvement is not yet strongly evidenced.
- "Evolution Points replacing Trust Engine" is not fully reflected in runtime reality.
- The product narrative is ahead of the current implementation in some places.

## Evidence We Already Verified

- `npm run build` passes in `packages/openclaw-plugin/`.
- `npm test` mostly passes in `packages/openclaw-plugin/`.
- Current failures are concentrated in path normalization and cross-platform path expectations.
- README/documentation drift exists.
- There is visible text encoding corruption in several Chinese-facing files.

## Important Risks

- `prompt.ts` and `gate.ts` are central and highly coupled.
- Documentation and implementation are not fully aligned.
- Cross-platform path handling still needs work.
- Encoding/mojibake hurts maintainability and product credibility.
- The installer package appears less mature than the plugin core.

## OpenClaw Upstream Compatibility Memory

- OpenClaw compatibility should be anchored on stable plugin surfaces, not internal business logic.
- The most important upstream files to monitor are:
  - `D:\Code\openclaw\src\plugins\types.ts`
  - `D:\Code\openclaw\src\plugins\hooks.ts`
  - `D:\Code\openclaw\src\plugins\registry.ts`
  - `D:\Code\openclaw\src\plugins\loader.ts`
  - `D:\Code\openclaw\src\plugins\manifest.ts`
  - `D:\Code\openclaw\src\plugins\discovery.ts`
  - `D:\Code\openclaw\src\plugins\runtime\index.ts`
  - `D:\Code\openclaw\src\agents\runtime-plugins.ts`
  - `D:\Code\openclaw\src\agents\agent-command.ts`
  - `D:\Code\openclaw\src\agents\pi-tools.before-tool-call.ts`
  - `D:\Code\openclaw\src\agents\pi-embedded-runner\run\attempt.ts`
  - `D:\Code\openclaw\src\agents\pi-embedded-subscribe.handlers.tools.ts`

### OpenClaw Areas That Matter Most For Principles Disciple

- Plugin discovery rules
- Plugin manifest shape and entry resolution
- `OpenClawPluginApi` surface
- hook names, event payloads, and context types
- hook scheduling semantics
- `resolvePath(...)` behavior
- workspace/session/run/tool-call context propagation
- command/tool/service registration rules
- runtime surface used by plugin code

### Current OpenClaw Compatibility Conclusions

- The most important stable surface is the plugin SDK and plugin types, not arbitrary `src/` internals.
- `workspaceDir` is often optional in upstream plugin contexts; plugin code must continue to defensively fall back to `api.resolvePath('.')` when needed.
- `before_prompt_build`, `before_tool_call`, and `after_tool_call` are the most important hook contracts for Principles Disciple.
- Hook execution semantics matter as much as hook names:
  - modifying hooks are merged/serialized with priority semantics
  - event-like hooks may run without strong ordering guarantees
- `register(api)` remains the formal integration point for plugin startup.
- Async assumptions in plugin registration are risky; OpenClaw loader behavior should be rechecked before introducing async registration dependencies.
- Manifest/discovery changes in OpenClaw can break plugin loading even if local code still compiles.
- Prompt injection policy changes upstream would directly affect Principles Disciple's core value, because the project depends heavily on prompt mutation plus state reinjection.

### Upstream Reference Examples In OpenClaw

- `D:\Code\openclaw\extensions\synthetic\index.ts`
- `D:\Code\openclaw\extensions\voice-call\index.ts`
- `D:\Code\openclaw\extensions\memory-core\index.ts`
- `D:\Code\openclaw\extensions\diffs\index.ts`
- `D:\Code\openclaw\extensions\discord\index.ts`

### Upstream Tests Worth Watching

- `D:\Code\openclaw\test\extension-plugin-sdk-boundary.test.ts`
- `D:\Code\openclaw\test\plugin-extension-import-boundary.test.ts`
- `D:\Code\openclaw\test\helpers\extensions\plugin-api.ts`
- `D:\Code\openclaw\test\helpers\extensions\plugin-runtime-mock.ts`

## Working Conclusions For Future Sessions

- Treat this project first as a productizable governance framework, second as a self-evolution framework.
- When prioritizing product work, prefer:
  1. governance clarity
  2. observable user value
  3. measurable reduction in repeated failures
  4. better principle quality
  5. cleaner documentation and UX

## Documents Created During This Session

- `docs/maps/principles-disciple-panorama-zh.md`
- `docs/okr/CURRENT_FOCUS.md`
- `docs/maps/openclaw-compatibility-map.md`

## Recommended Next Work

- Create a productization roadmap for MVP.
- Build a "philosophy vs implementation gap" document.
- Identify the top engineering fixes that most improve product credibility.
- Define measurable outcome metrics for "evolution" beyond narrative language.
- Build a reusable OpenClaw compatibility map from `D:\Code\openclaw` for plugin API and lifecycle verification.
