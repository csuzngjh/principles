# Agent Execution Modes Appendix

> Status: Draft v1  
> Date: 2026-04-21  
> Scope: How PD-specialized agents are actually executed in the new architecture

## 1. Purpose

This appendix clarifies a key ambiguity in the PD Runtime v2 redesign:

When PD defines an agent such as `diagnostician`, how is that agent actually executed?

This document exists to prevent a category error:

- `diagnostician` is not equal to an OpenClaw subagent
- `diagnostician` is not equal to an OpenClaw CLI command
- `diagnostician` is not equal to a Codex or Claude CLI process
- `diagnostician` is not equal to a direct model API call

Those are all possible execution backends.

`diagnostician` itself is a PD-native role described by `AgentSpec`.

## 2. Core Distinction

### 2.1 Agent Identity

An agent such as `diagnostician` is a PD-defined execution role with:

- input contract
- output contract
- timeout policy
- retry policy
- capability requirements
- artifact contract

### 2.2 Execution Backend

The execution backend is the concrete mechanism used to run that role.

Examples:

- OpenClaw native runtime adapter
- OpenClaw CLI invocation
- Codex CLI invocation
- Claude CLI invocation
- Gemini CLI invocation
- direct model API invocation

## 3. Main Design Rule

PD agents are stable.

Execution backends are interchangeable.

That is the core decoupling rule.

## 4. Execution Mode Taxonomy

PD v2 recognizes four practical execution modes.

### 4.1 Mode A: Runtime Adapter Direct Invocation

PD system code directly invokes a runtime adapter through the PD runtime protocol.

Example flow:

1. `DiagnosticianRunner` leases a task
2. `ContextAssembler` builds the context payload
3. PD calls `runtimeAdapter.startRun(...)`
4. the adapter executes the run
5. the adapter returns output
6. PD validates and commits the result

This is the preferred primary mode.

#### Advantages

- strongest architectural control
- explicit run lifecycle
- no dependence on prompt-side self-routing
- clean separation between reasoning and commit

#### Disadvantages

- adapter implementation must exist
- host runtime integration work is required

### 4.2 Mode B: CLI Transport Execution

PD invokes an external agent runtime through CLI.

Examples:

- `openclaw agent ...`
- `codex ...`
- `claude ...`
- `gemini ...`

This is still compatible with the runtime protocol as long as a runtime adapter wraps the CLI transport.

Important clarification:

CLI is transport, not identity.

So the correct statement is:

- `diagnostician` executed through `openclaw-cli`

not:

- `diagnostician is an openclaw-cli agent`

#### Advantages

- less coupling to host internal APIs
- easier to debug from the terminal
- easier to support multiple runtimes consistently
- more transparent for operators

#### Disadvantages

- stdout/stderr parsing must be standardized
- cancellation and session continuity may be weaker depending on the backend

### 4.3 Mode C: Host-Managed Dedicated Agent

A host runtime may maintain a dedicated named agent instance or workspace for a PD role.

Example:

- an OpenClaw-specific `diagnostician` agent workspace
- a host-managed worker profile that always runs diagnostician tasks

This mode may exist, but it must be treated as an implementation detail of a specific runtime adapter.

It must not define PD architecture.

#### Advantages

- can reuse host-native routing or workspace models
- may support persistent memory or specialized environment setup

#### Disadvantages

- strong coupling to host semantics
- difficult to preserve portability
- likely to reproduce current lifecycle and permission pain if made central

### 4.4 Mode D: Direct Model API Invocation

PD invokes a provider API directly through code, bypassing a host agent runtime.

Examples:

- OpenAI API
- Anthropic API
- Gemini API

This mode is valid when:

- context assembly is fully owned by PD
- state transitions are fully owned by PD
- artifact commit is fully owned by PD

This mode is especially useful for pure reasoning tasks with minimal external tool dependency.

#### Advantages

- strongest control over inference contract
- minimal host-runtime coupling
- predictable execution surface

#### Disadvantages

- requires direct provider integration and auth management
- tool-rich agent flows are harder unless PD supplies equivalent tools

## 5. Recommended Position by Agent Type

### 5.1 Diagnostician

Recommended priority order:

1. runtime adapter direct invocation
2. CLI transport execution
3. direct model API invocation
4. host-managed dedicated agent

Reason:

`diagnostician` should be driven by explicit task/run/commit semantics and should not depend on host-native session rituals.

### 5.2 Explorer

Recommended priority order:

1. CLI transport execution
2. runtime adapter direct invocation
3. direct model API invocation

Reason:

`explorer` often needs controlled retrieval and iterative evidence gathering, which can be well supported through PD CLI tools.

### 5.3 Dreamer / Philosopher / Scribe / Artificer

Recommended priority order:

1. runtime adapter direct invocation
2. CLI transport execution
3. direct model API invocation

Reason:

these roles are stage-based structured generators and evaluators, which map naturally to explicit run contracts.

### 5.4 Heartbeat Checkers / Lightweight Watchdogs

Recommended priority order:

1. host-native lightweight runtime
2. runtime adapter direct invocation

Reason:

these are cheap control-plane checks, not heavy reasoning tasks.

## 6. What Should Not Happen Anymore

The following anti-patterns should be treated as deprecated:

### 6.1 Prompt-Side Self-Dispatch

Example:

- inject a prompt telling the main model to call `sessions_spawn`
- hope the model obeys
- infer success from later side effects

This is fragile and must not be the primary execution strategy.

### 6.2 Host API as Domain Truth

Example:

- treating OpenClaw session or subagent semantics as the canonical PD task model

PD task and run truth must remain PD-owned.

### 6.3 LLM-Owned State Mutation

Example:

- model writes the completion marker
- model writes report JSON
- system infers task completion from those files

This must be replaced by validated commit logic.

## 7. Relationship to OpenClaw

### 7.1 What OpenClaw May Still Do

OpenClaw may remain useful as:

- one runtime adapter
- one CLI transport
- one source of signals and host context
- one place where compatibility wrappers live

### 7.2 What OpenClaw Must Stop Doing

OpenClaw must stop being the implicit owner of:

- diagnostician lifecycle
- task state truth
- PD workflow identity
- artifact commit truth

## 8. Recommended Default Strategy

For the new PD runtime architecture, the recommended default strategy is:

### 8.1 Identity Layer

Define PD specialized agents as `AgentSpec`.

### 8.2 Execution Layer

Run them through `PDRuntimeAdapter`.

### 8.3 Practical Backend Preference

Use the following backend preference order unless a workflow explicitly overrides it:

1. direct runtime adapter execution
2. CLI transport execution
3. direct API execution
4. host-managed dedicated agent mode

This preference order reflects the desire to maximize:

- deterministic orchestration
- portability
- debuggability

while minimizing:

- host lifecycle coupling
- prompt-side control
- hidden runtime behavior

## 9. One-Sentence Summary

In PD Runtime v2, an agent such as `diagnostician` is a PD-defined role first, and only secondarily a thing that may be executed through OpenClaw, Codex CLI, Claude CLI, Gemini CLI, or direct API depending on the selected runtime adapter.
