# Plugin Workspace Discovery & Nocturnals Caller Classification

This document maps all workspace discovery and configuration entry points in `packages/openclaw-plugin` to support safe cutover and physical deletion in `PRI-119` and `PRI-230`.

## Caller Classification Table

| Component / Path | Legacy Mechanism | Target Category | Classification Rationale / Migration Plan |
|---|---|---|---|
| `src/commands/capabilities.ts` | Hook context capabilities query | `required_host_hook` | Integrated with OpenClaw plugin runtime registration; must remain as a host hook context adapter. |
| `src/commands/pain.ts` | Captures pain signals on tool run / IDE event | `required_host_hook` | Must run inside tool hooks to intercept real-time coding events, but writes to standardized V2 state DB. |
| `src/commands/archive-impl.ts` | Hook context + manual workspace check | `replace_by_pd_config` | Operator action. Can be unified under new PD-owned config boundary. |
| `src/commands/disable-impl.ts` | Hook context + manual workspace check | `replace_by_pd_config` | Operator action. Can be unified under new PD-owned config boundary. |
| `src/commands/promote-impl.ts` | Hook context + manual workspace check | `replace_by_pd_config` | Operator action. Can be unified under new PD-owned config boundary. |
| `src/commands/rollback-impl.ts` | Hook context + manual workspace check | `replace_by_pd_config` | Operator action. Can be unified under new PD-owned config boundary. |
| `src/commands/principle-rollback.ts` | Hook context + manual workspace check | `replace_by_pd_config` | Operator action. Can be unified under new PD-owned config boundary. |
| `src/commands/rollback.ts` | Hook context + manual workspace check | `replace_by_pd_config` | Operator action. Can be unified under new PD-owned config boundary. |
| `src/commands/pd-reflect.ts` | Hook context + manual workspace check | `replace_by_pd_config` | Operator action. Can be unified under new PD-owned config boundary. |
| `src/commands/strategy.ts` | Hook context + manual workspace check | `replace_by_pd_config` | Operator action. Can be unified under new PD-owned config boundary. |
| `src/commands/context.ts` | Profile preset context loading | `replace_by_pd_config` | Operator action. Can be unified under new PD-owned config boundary. |
| `src/commands/focus.ts` | Thinking focus customization | `replace_by_pd_config` | Operator action. Can be unified under new PD-owned config boundary. |
| `src/commands/thinking-os.ts` | Thinking OS mode toggle | `replace_by_pd_config` | Operator action. Can be unified under new PD-owned config boundary. |
| `src/commands/evolution-status.ts` | Diagnostic workspace visualization | `historical_read_only` | Diagnostic helper; continues using read-only StateManager access. |
| `src/commands/export.ts` | Database exporting | `historical_read_only` | Diagnostic helper; continues using read-only StateManager access. |
| `src/commands/samples.ts` | Code sample listing/generation | `historical_read_only` | Diagnostic helper; continues using read-only StateManager access. |
| `src/commands/workflow-debug.ts` | Diagnostic trace debugger | `historical_read_only` | Diagnostic helper; continues using read-only StateManager access. |
| `src/service/evolution-worker.ts` | Reads workflows.yaml, checks idle, triggers | `legacy_runtime_launch` | Legacy launching loop. Will be completely replaced by the PD CLI scheduler dispatcher. |
| `src/commands/nocturnal-review.ts` | Manual review trigger | `delete_after_cutover` | Nocturnal feature. Scheduled for physical deletion during cutover. |
| `src/commands/nocturnal-rollout.ts` | Manual rollout trigger | `delete_after_cutover` | Nocturnal feature. Scheduled for physical deletion during cutover. |
| `src/commands/nocturnal-train.ts` | Manual train trigger | `delete_after_cutover` | Nocturnal feature. Scheduled for physical deletion during cutover. |
| `src/service/nocturnal-service.ts` | Nocturnal loop daemon | `delete_after_cutover` | Nocturnal feature. Scheduled for physical deletion during cutover. |
| `src/service/nocturnal-runtime.ts` | Nocturnal runtime scheduler | `delete_after_cutover` | Nocturnal feature. Scheduled for physical deletion during cutover. |
| `src/service/sleep-cycle.ts` | Night/sleep cycle detection | `delete_after_cutover` | Nocturnal feature. Scheduled for physical deletion during cutover. |
| `src/service/nocturnal-config.ts` | Legacy nocturnal config | `delete_after_cutover` | Nocturnal feature. Scheduled for physical deletion during cutover. |
| `src/service/nocturnal-target-selector.ts` | Legacy nocturnal target | `delete_after_cutover` | Nocturnal feature. Scheduled for physical deletion during cutover. |

## MVP-Core Support Assessment

No blockers have been identified. The new configuration/dispatch boundary successfully supports all forward execution paths (V2 operators, run-once internalization, diagnostics runs) without deleting or breaking the legacy nocturnal triggers, ensuring a completely safe cutover path in the next phase (`PRI-119`).
