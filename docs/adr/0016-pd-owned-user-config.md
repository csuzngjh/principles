# ADR-0016: PD-Owned User Config and Internal Agent Runtime Bindings

> **Status**: Accepted
> **Date**: 2026-06-03
> **Drives**: PRI-301 / PRI-303 configuration and Control Center work
> **Context**: MVP-First, seed-customer readiness

## 1. Context

PD configuration is currently split across several places:

- `.pd/feature-flags.yaml`
- `.state/workflows.yaml`
- `pain_settings.json`
- OpenClaw `openclaw.json`
- environment variables
- CLI flags
- Console-local auth/settings

This made the product hard to operate and hard to explain. Seed users should not need to understand YAML internals, OpenClaw provider files, Runtime V2 funnel policy, and feature flag files before using PD.

At the same time, PD internal agents need model selection. The user must be able to choose which provider/model a PD internal agent uses, including OpenClaw-configured local models such as `lmstudio/qwen3.6-27b-mtp`.

## 2. Decision

PD will introduce `.pd/config.yaml` as the single PD-owned user configuration file.

The file owns:

- feature flags
- PD internal agent enablement
- default and per-agent runtime bindings
- PD-local runtime profiles
- safe UI-facing policy settings

The file does not own:

- raw API keys
- provider tokens
- OpenClaw gateway tokens
- OpenClaw provider objects
- raw prompt/chat/trajectory data

### 2.1 No compatibility with legacy user config

PD will not preserve `.state/workflows.yaml` or `.pd/feature-flags.yaml` as user-facing compatibility inputs.

During this MVP phase there are no external seed users depending on the old configuration shape. Keeping compatibility would preserve accidental complexity and undermine the purpose of this refactor.

If legacy files are detected, `pd config doctor` may report them with a structured warning, but production runtime resolution must use `.pd/config.yaml`.

### 2.2 Provider credentials are external

PD does not own provider credentials.

PD may display that a credential appears configured, but must not display, copy, persist, or log raw credential values.

### 2.3 Runtime Profiles

A Runtime Profile is a selectable model runtime reference for a PD internal agent.

Supported MVP profile types:

- `openclaw`: references OpenClaw model/provider configuration
- `pi-ai`: uses PD direct runtime with non-secret fields and `apiKeyEnv`

OpenClaw profile references must store only provider/model/source identifiers. They must not copy OpenClaw `baseUrl`, `apiKey`, gateway token, or raw provider config into `.pd/config.yaml`.

### 2.4 Internal Agent Runtime Bindings

PD internal agents use a global default runtime profile and may override it per agent.

Examples:

- Diagnostician uses `openclaw.model.lmstudio.qwen3.6-27b-mtp`
- CorrectionObserver is disabled or uses a cheaper model
- EmpathyObserver is disabled during MVP validation

### 2.5 Console UX

Console must not expose raw YAML editing.

Console should provide safe forms and diagnostics:

- choose runtime source
- choose OpenClaw model
- create PD-local profile using provider/model/apiKeyEnv, without storing secrets
- test connection
- show `ready`, `not_ready`, `needs_setup`, `disabled`, or `unknown`
- copy redacted diagnostics

Saving a valid config does not require connection tests to pass. Failed connection tests must be surfaced as `not_ready` or `needs_setup`, not hidden.

### 2.6 Installer behavior

The installer must generate `.pd/config.yaml`.

If `.pd/config.yaml` already exists and is malformed, installation must fail loud with a reason and next action. It must not overwrite malformed user config.

## 3. Initial Shape

```yaml
version: 1

features:
  prompt:
    category: core
    enabled: true
  code_tool_hook:
    category: core
    enabled: true
  defer_archive:
    category: core
    enabled: true
  correction_observer:
    category: quiet
    enabled: false
  empathy_observer:
    category: quiet
    enabled: false
  gfi:
    category: quiet
    enabled: false
  nocturnal:
    category: gone
    enabled: false
  idle_trigger:
    category: gone
    enabled: false
  model_training:
    category: gone
    enabled: false
  trainer:
    category: gone
    enabled: false

runtimeProfiles:
  openclaw.default:
    type: openclaw
    source: default
  openclaw.model.lmstudio.qwen3.6-27b-mtp:
    type: openclaw
    provider: lmstudio
    model: qwen3.6-27b-mtp
  pd.anthropic-sonnet:
    type: pi-ai
    provider: anthropic
    model: claude-3-5-sonnet
    apiKeyEnv: ANTHROPIC_API_KEY
    timeoutMs: 300000

internalAgents:
  defaultRuntime: openclaw.default
  agents:
    diagnostician:
      enabled: true
      runtimeProfile: openclaw.model.lmstudio.qwen3.6-27b-mtp
    correctionObserver:
      enabled: false
    empathyObserver:
      enabled: false

ui:
  diagnostics:
    mode: simple
```

## 4. Consequences

Positive:

- Seed users get one PD-owned configuration entrypoint.
- Console can present safe controls instead of raw YAML.
- PD can let users choose models for internal agents without owning secrets.
- Runtime and feature flag resolution become easier to test.
- Plugin code can become thinner because configuration validation lives in core contracts.

Negative:

- Existing internal tests and scripts that write `.pd/feature-flags.yaml` or `.state/workflows.yaml` must be updated.
- This is a breaking change for maintainer dogfood data.
- Runtime resolution must be carefully rewired to avoid stale compatibility reads.

## 5. Non-Goals

- No raw provider secret editor.
- No automatic copy from OpenClaw provider config to PD config.
- No raw YAML editor in Console.
- No analytics or telemetry upload.
- No broad settings platform beyond MVP configuration needs.
