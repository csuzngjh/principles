# Document-vs-Code Drift Audit (2026-05-18)

> **Issue**: PRI-182
> **Auditor**: AI coding assistant
> **Date**: 2026-05-18
> **Baseline**: origin/main HEAD = `5a2847a8`
> **Scope**: `docs/architecture/` — component-location claims, status markers, progress tables

---

## Summary

| Metric | Count |
|--------|-------|
| Total drifts found | 15 |
| Move-doc (doc is wrong, code is correct) | 13 |
| Defer (intentional / harmless, annotated) | 2 |
| Move-code (code is wrong, doc is correct) | 0 |

---

## Drifts

### DRIFT-01: IdleTrigger location — core, not plugin

| | |
|---|---|
| **Documents** | `PD_SYSTEM_ARCHITECTURE.md` S3.3, `INTERNALIZATION_PIPELINE.md` S4.1, `PD_ARCHITECTURE_OVERVIEW.md` S2.2/S3, `COMPONENTS.md` S3.2.1/S4.2 |
| **Doc claim** | IdleTrigger is at `packages/openclaw-plugin/src/service/idle-trigger.ts` (Layer 3 / plugin) |
| **Code reality** | `packages/principles-core/src/runtime-v2/idle-trigger/` — 7 files. Zero IdleTrigger files in openclaw-plugin. |
| **Decision** | **Move-doc** — Pure-function policy is correctly placed in core. |
| **Resolution** | Updated all 6 documents to show core location. |

### DRIFT-02: ADR-0008/0009/0010/0011 status — Accepted, not Proposed

| | |
|---|---|
| **Documents** | `README.md` ADR table, `PD_ARCHITECTURE_OVERVIEW.md` S10 |
| **Doc claim** | ADR-0008/0009/0010/0011 status = `Proposed` |
| **Code reality** | All 4 ADR files: `Accepted` (dated 2026-05-16) |
| **Decision** | **Move-doc** |
| **Resolution** | Updated both tables to `Accepted`. |

### DRIFT-03: COMPONENTS.md IdleTrigger status — Done, not pending

| | |
|---|---|
| **Document** | `COMPONENTS.md` S3.2.1, S4.2 |
| **Doc claim** | `IdleTrigger | ... | pending` |
| **Code reality** | 7 files in core, tests passing |
| **Decision** | **Move-doc** |
| **Resolution** | Updated to Done with core path. |

### DRIFT-04: COMPONENTS.md IntakeToInternalizationBridge status

| | |
|---|---|
| **Document** | `COMPONENTS.md` S3.2.1 line 141 |
| **Doc claim** | `pending (breakpoint 1)` |
| **Code reality** | File exists with tests |
| **Decision** | **Move-doc** |
| **Resolution** | Updated to Done. |

### DRIFT-05: PD_SYSTEM_ARCHITECTURE.md S10 progress percentages

| | |
|---|---|
| **Document** | `PD_SYSTEM_ARCHITECTURE.md` S10 |
| **Doc claim** | Layer 2: 80%, Layer 3: 70% |
| **Code reality** | IntakeToInternalizationBridge, ActivationDispatcher, IdleTrigger core all Done |
| **Decision** | **Move-doc** |
| **Resolution** | Updated Layer 2 to 90%, Layer 3 to 75%. |

### DRIFT-06: PD_SYSTEM_ARCHITECTURE.md S3.2 activation/ marker

| | |
|---|---|
| **Doc claim** | `activation/ pending (5-channel activation)` |
| **Code reality** | 5 files already exist |
| **Decision** | **Move-doc** |
| **Resolution** | Updated marker to show existing files. |

### DRIFT-07: PD_SYSTEM_ARCHITECTURE.md S3.3 idle-trigger.ts

| | |
|---|---|
| **Doc claim** | `service/idle-trigger.ts pending` |
| **Code reality** | No file in plugin; module is in core |
| **Decision** | **Move-doc** |
| **Resolution** | Removed from Layer 3 listing. |

### DRIFT-08: Writer class names

| | |
|---|---|
| **Doc claim** | `LedgerPromptWriter` / `LedgerArchiveWriter` |
| **Code reality** | `PromptWriter` / `DeferArchiveWriter` |
| **Decision** | **Move-doc** |
| **Resolution** | Updated to use code names with alias note. |

### DRIFT-09: ApprovalStatus — 6 states vs 4

| | |
|---|---|
| **Doc claim** | 6 states including `expired` / `awaiting_second_confirmation` |
| **Code reality** | 4 states: `pending | approved | rejected | cancelled` |
| **Decision** | **Defer** — Target states per ADR-0006, not yet implemented. |
| **Resolution** | Added footnotes clarifying future vs current states. |

### DRIFT-10: PD_SYSTEM_ARCHITECTURE.md S8 writer name

| | |
|---|---|
| **Doc claim** | `LedgerPromptWriter.activate` |
| **Code reality** | `PromptWriter` |
| **Decision** | **Move-doc** |
| **Resolution** | Updated. |

### DRIFT-11: INTERNALIZATION_PIPELINE.md S11 status table

| | |
|---|---|
| **Doc claim** | IdleTrigger described as "plugin thin adapter" |
| **Code reality** | Core module done; plugin adapter not built separately |
| **Decision** | **Move-doc** |
| **Resolution** | Updated description. |

### DRIFT-12: PD_ARCHITECTURE_OVERVIEW.md S9 Activation Pipeline progress

| | |
|---|---|
| **Doc claim** | Activation Pipeline 60% |
| **Code reality** | Dispatcher + writers + queue + stores + UI all done (75%) |
| **Decision** | **Move-doc** |
| **Resolution** | Updated to 75%. |

### DRIFT-13: PD_ARCHITECTURE_OVERVIEW.md S9 Operations Pipeline

| | |
|---|---|
| **Doc claim** | "pd-console approvals basic UI/API not built" |
| **Code reality** | 4 endpoints + TasksPage approvals tab Done |
| **Decision** | **Move-doc** |
| **Resolution** | Updated description. |

### DRIFT-14: COMPONENTS.md S5.3 ApprovalConsoleModel

| | |
|---|---|
| **Doc claim** | `ApprovalConsoleModel | TBD | pending` |
| **Code reality** | Approvals handled directly via core API |
| **Decision** | **Defer** — Acceptable architectural choice |
| **Resolution** | Added note. |

### DRIFT-15: INTERNALIZATION_PIPELINE.md S9.4 IdleTrigger Jitter path

| | |
|---|---|
| **Doc claim** | Jitter code at plugin `idle-trigger.ts` |
| **Code reality** | Jitter config in core `idle-trigger-types.ts` |
| **Decision** | **Move-doc** |
| **Resolution** | Updated path reference. |

---

## Files Modified

| File | Changes |
|------|---------|
| `PD_ARCHITECTURE_OVERVIEW.md` | S2.2 IdleTrigger ownership, S3 Layer diagram, S9 progress, S10 ADR status |
| `PD_SYSTEM_ARCHITECTURE.md` | S3.2 activation/ listing, S3.3 idle-trigger, S8 writer name, S10 progress |
| `INTERNALIZATION_PIPELINE.md` | S4.1 IdleTrigger location, S11 status table, S9.4 jitter path |
| `COMPONENTS.md` | S3.2.1 IdleTrigger + Bridge status, S4.2 IdleTrigger status |
| `README.md` | ADR table status |
| `ACTIVATION_CHANNELS.md` | Writer names, ApprovalStatus footnote |
| `DATA_ARCHITECTURE.md` | Approval status column footnote |

## No-Drift Confirmations

| Check | Result |
|-------|--------|
| `DOMAIN_MODEL.md` IdleTrigger location | Done: correctly says core |
| `DOMAIN_MODEL.md` ApprovalStatus annotations | Done: correctly marks future states |
| `COMPONENTS.md` ActivationDispatcher/ApprovalQueue/PromptWriter rows | Done: correctly marked |
| `COMPONENTS.md` BALM/LRAS/GAP/MissionScheduler all pending | Confirmed: no code exists |
| `INTERNALIZATION_PIPELINE.md` S11 all Done rows for runners | Confirmed: all match code |
| ADR-0001 through ADR-0007 status in README.md | Confirmed: all Accepted |
