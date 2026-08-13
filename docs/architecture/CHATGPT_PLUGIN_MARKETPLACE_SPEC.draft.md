# Codex Repository Marketplace Plugin SPEC v0.2

> **Status**: **Accepted** for repository/personal Marketplace testing, organization-internal Workspace publication, and local shared-runtime delivery (all sections except §9)
> **Draft/Hold boundary**: §9 universal public-directory submission only
> **Created**: 2026-08-12
> **Amended**: 2026-08-13
> **Authority**: [PRI-523](https://linear.app/principles-disciple/issue/PRI-523) (`mvp-exception`), ADR-0020 §10
> **Baseline**: Codex 0.147
> **Depends on**: ADR-0020; `CODEX_CLI_ADAPTER_SPEC.md` for the validated hook codec contract

## 1. Decision and scope

PD will first ship as a Codex plugin installed from a repository/personal Marketplace and used in a selected Codex CLI/Desktop Workspace. The plugin uses trusted lifecycle hooks to expose the same three MVP-Core host behaviors as OpenClaw:

1. prompt injection;
2. before-tool RuleHost enforcement;
3. after-tool pain/evidence capture.

The plugin does not add a new activation channel. It packages the Codex protocol adapter and calls the shared `@principles/host-runtime` orchestration approved by ADR-0020 §10.

This accepted local-delivery scope intentionally does **not** claim universal public-directory availability, ChatGPT Web/Mobile hook support, IDE parity, automatic public updates, or public submission acceptance. OpenAI's current public submission documentation lists Skills and MCP servers; it does not confirm lifecycle-hook plugins as a submission type. Only that universal public-directory portion remains Draft/Hold in §9. The historical `.draft.md` filename is retained to avoid link churn; the status block and per-section status control.

## 2. Verified Codex 0.147 platform contract

| Capability | Status used by this SPEC | Constraint |
|---|---|---|
| Plugin-bundled lifecycle hooks | Verified | Codex loads default `hooks/hooks.json` or the manifest-declared hooks path |
| `PLUGIN_ROOT` | Verified | Location of the installed plugin's code/assets; use it in hook commands |
| `PLUGIN_DATA` | Verified | Plugin-private writable auxiliary storage; not PD Workspace state authority |
| Hook trust | Required | Owner must review/trust hooks before relying on their behavior |
| Repository/personal Marketplace | Supported first route | Test/install the local plugin source in Codex CLI/Desktop |
| Workspace publication | Supported second route after testing | Workspace admin publishes the local plugin to selected roles; organization-internal only |
| Public directory lifecycle-hook submission | Unverified | Current public submission types mention Skills/MCP, not lifecycle hooks |

When this document conflicts with a later Codex release, implementation must pin/re-verify the host version before changing product claims.

## 3. Package layout

The repository Marketplace entry points to a plugin bundle with this minimum layout:

```text
principles-disciple/
├── .codex-plugin/
│   └── plugin.json
├── hooks/
│   ├── hooks.json
│   └── pd-hook.js
└── package payload required by pd-hook.js
```

`hooks/hooks.json` is the default hook location. A manifest may declare another hook path, but PD should use the default unless packaging evidence requires an override. Do not install directly into Codex's internal cache and do not make direct `~/.codex/hooks.json` mutation the preferred plugin flow.

Skills, MCP configuration, icons, and marketing assets are not required for PRI-523 acceptance. Adding them requires its own scoped decision.

## 4. Hook registration

The bundle invokes one validated entrypoint through `PLUGIN_ROOT`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|apply_patch",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${PLUGIN_ROOT}/hooks/pd-hook.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${PLUGIN_ROOT}/hooks/pd-hook.js\"",
            "timeout": 5,
            "async": true
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${PLUGIN_ROOT}/hooks/pd-hook.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${PLUGIN_ROOT}/hooks/pd-hook.js\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The exact matcher/event payload and output schema remain governed by `CODEX_CLI_ADAPTER_SPEC.md` and codec fixtures. The installed bundle must be tested; a source-tree-only test is insufficient.

Node.js `>=20` is a delivery prerequisite (repository CI compatibility matrix: Node 20 and 22). The installer package's broader historical engine declaration does not expand this plugin support contract. Repository Marketplace installation and Workspace publication do not install Node. Setup and health checks must detect `node` and its major version before enabling hooks; missing/unsupported Node is a failed prerequisite with a structured reason and next action, not a warning followed by partial installation.

## 5. Runtime and state authority

### 5.1 Responsibilities

- `codex-adapter`: validate Codex stdin, map host events, encode only schema-valid stdout, and handle Codex trust/install concerns.
- `@principles/host-runtime`: orchestrate the three approved I/O behavior paths.
- `@principles/core`: pure domain logic only; no filesystem, database, network, or host I/O.
- `openclaw-plugin`: translate OpenClaw events/results and call the same host runtime.

### 5.2 Workspace authority

The selected Workspace remains authoritative through the two physical stores defined by [`DATA_ARCHITECTURE.md`](./DATA_ARCHITECTURE.md):

```text
<workspace>/.pd/
├── config.yaml                         # unified workspace config and feature flags
└── state.db                            # Runtime V2 SQLite tasks/runs/artifacts/approvals

<workspace>/.state/
├── principle_training_state.json       # Principle Tree ledger
├── trajectory.db                       # host trajectory/pain/evidence support state
└── sessions/ and other runtime artifacts
```

The plugin must resolve and pass the current Workspace to the shared runtime. `.pd/` is authoritative for configuration and Runtime V2 SQLite state; `.state/principle_training_state.json` is authoritative for the Principle Tree ledger, while the existing remaining `.state/` paths hold Workspace-scoped host/runtime artifacts. Principles, approval state, pain/evidence, lineage, feature flags, ledger entries, and runtime artifacts must not silently move to plugin-global storage.

`PLUGIN_DATA` may hold bounded plugin-private auxiliary data such as install metadata or non-authoritative cache entries. It must not become the database/config authority and must be safe to delete without losing governed Workspace state. `PLUGIN_ROOT` identifies packaged code/assets.

## 6. Installation, trust, and disable flow

1. Owner adds or selects the PD repository/personal Marketplace.
2. Owner installs the plugin into Codex.
3. Codex discovers the bundle's default `hooks/hooks.json` (or manifest-declared path).
4. Owner reviews and trusts the lifecycle hooks.
5. In the selected Workspace, PD reads `.pd/config.yaml`; behavior runs only when `host.codex.enabled` is true.
6. Health/acceptance evidence distinguishes installed, discovered, trusted, enabled, and behavior-verified states. "Installed" alone must never be reported as functional parity.
7. After repository/personal Marketplace testing passes, a Workspace admin may publish the local plugin to selected Workspace roles. This publication stays inside that organization and does not publish PD to the universal public directory.

Fresh setup and migration must write both rollout entries explicitly; omission is not accepted as delivery evidence:

```yaml
features:
  host.codex:
    category: core
    enabled: true
  abstraction_layer_v1:
    category: quiet
    enabled: false
```

The registry retains `host.codex` since 2026-08-11 and adds `abstraction_layer_v1` since 2026-08-13. Loader tests must read fresh and migrated files, then explicitly set each flag false and prove the Codex-neutral/OpenClaw-legacy operator rollback plus its observable reason.

Rollback is exact: set `host.codex.enabled: false` in the Workspace `.pd/config.yaml`. All Codex hook events then return the host-neutral allow/empty result, emit a structured skip reason outside strict stdout, and perform no prompt injection, RuleHost enforcement, or pain/evidence write. OpenClaw behavior, `.pd/config.yaml`, `.pd/state.db`, `.state/principle_training_state.json`, and existing `.state/` runtime artifacts remain unchanged. Uninstalling the plugin is a separate packaging action, not the primary behavior kill switch.

## 7. Observable acceptance contract

PRI-523 is accepted only when the installed repository-Marketplace bundle, in one test Workspace after hook trust, proves:

- **Prompt**: a known active, Owner-approved principle appears in Codex prompt context and matches the OpenClaw result.
- **Before tool**: a known RuleHost fixture denies the same unsafe tool call in Codex and OpenClaw, while a safe control call is allowed.
- **After tool**: a completed Codex tool call creates pain/evidence with Codex source lineage in that same Workspace and no duplicate write.
- **Kill switch**: after `host.codex.enabled: false`, all three effects are absent and the structured disabled reason is observable.
- **Bundle reality**: tests install/use the packaged plugin layout and default `hooks/hooks.json`, not a hand-wired source path.
- **Quoted path**: the installed bundle runs successfully when `PLUGIN_ROOT` contains spaces; all hook commands keep the executable script path quoted.
- **Node prerequisite**: setup/health succeeds on supported Node 20/22 and fails loud with reason/next action when Node is missing or below 20.
- **Workspace publication**: after repository/personal Marketplace testing, a Workspace admin can publish that local plugin to selected roles without rewriting either Workspace authority path.
- **Explicit flags**: fresh and migrated `.pd/config.yaml` contain both entries, and loader tests exercise `host.codex` neutral rollback and `abstraction_layer_v1` legacy rollback.

The OpenClaw adapter cutover must also pass the three-path parity E2E. PRI-523 registers `abstraction_layer_v1` as quiet/default-off/since 2026-08-13: off uses legacy OpenClaw orchestration and on is limited to controlled `@principles/host-runtime` parity validation. It may be promoted to core/default-on only after OpenClaw parity and Codex installed-bundle E2E both pass, and PRI-523 must not remove the legacy path. `host.codex` remains the existing core/default-on Codex kill switch; ADR-0020 §2.4's old quiet/default-off text is historical and superseded.

## 8. Emotional-value review

The plugin should reduce **失控感** and **不信任感**: the Owner can distinguish installed, trusted, enabled, and behavior-verified states, while one Workspace remains authoritative. It should create **掌控感** and **安心感** through explicit trust, owner-reviewed principles, observable parity, and the `host.codex` kill switch. Sharing the three behavior paths reduces repeated-correction **疲惫感** without adding a new dashboard or notification stream.

## 9. Universal public-directory submission — DRAFT / HOLD

The following remain Post-MVP/Hold even while PRI-523 proceeds:

- ChatGPT Web/Mobile or IDE feature parity;
- a PD MCP server or public Web command surface;
- automatic Skill activation or a new thinking-OS distribution channel;
- long-running service replacement, outbound host runtimes, schedulers, or general memory;
- universal public-directory submission, review, discovery, or auto-update claims; organization-internal Workspace publication is already supported and is not this public route.

Public submission may restart only when all are true:

- OpenAI documentation explicitly accepts lifecycle-hook plugins as a public submission type;
- at least one seed customer requests public discovery or non-Codex parity;
- Workspace/plugin-data lifecycle has been verified on the target channel;
- the proposal remains inside `PRODUCT_IDENTITY.md` and receives a separately recorded Owner scope decision.

This section alone remains `DRAFT / HOLD` until the public-submission uncertainty is resolved or the universal public-directory portion is removed. Sections 1-8 and 10-11 remain Accepted for local/repository/Workspace delivery.

## 10. Risks and mitigations

| Risk | Impact | Required mitigation |
|---|---|---|
| Plugin installed but hooks untrusted | False sense of protection | Report installed/discovered/trusted/enabled separately; require trust in acceptance |
| Node absent or unsupported | Hooks cannot start | Require Node >=20; setup/health fails loud with detected state and next action; Marketplace does not install Node |
| `PLUGIN_ROOT` contains spaces | Hook command fails to launch | Quote every command path and run installed-bundle path-with-spaces acceptance |
| Codex codec fails open | Unsafe call proceeds | Keep schema/whitelist fixture gates from `CODEX_CLI_ADAPTER_SPEC.md`; positive deny E2E |
| `PLUGIN_DATA` becomes state authority | Cross-host drift or apparent data loss | Preserve `.pd/` config/SQLite and `.state/` ledger/runtime authority paths; auxiliary data must be deletable |
| Shared runtime regresses OpenClaw | Existing MVP path breaks | Three-path parity E2E plus `abstraction_layer_v1` rollback |
| Public support is overstated | Owner/customer distrust | Keep universal public submission gated and §9 explicitly Draft/Hold |

## 11. Relationship to existing work

- **ADR-0020 §10**: authorizes `@principles/host-runtime`, thin OpenClaw/Codex adapters, supported distribution facts, acceptance, and rollback.
- **Post-MVP Conditional Roadmap §21/§22**: records which PRI-523 slices are active by exception and which remain Hold.
- **`DATA_ARCHITECTURE.md`**: authority for the split `.pd/` config/SQLite and `.state/` ledger/runtime paths.
- **`host.codex`**: existing Workspace kill switch; stays enabled only through the production feature-flag loader.
- **PRI-521**: long-running service replacement remains deferred.
- **CODEX_CLI_ADAPTER_SPEC**: codec schema, fail-open risks, and hook result contract remain authoritative unless separately amended.
