# Roadmap: v1.22 PD CLI Redesign

## Milestones

- [x] **v1.21.2** — YAML Funnel 完整 SSOT (Phase 5-7) — SHIPPED 2026-04-19
- [ ] **v1.22** - PD CLI Redesign (Phase 8-13)

## Phase Summary

- [ ] **Phase 8: SDK Foundation** — Extract interfaces, export primitives, add PainFlagPathResolver
- [ ] **Phase 9: Pain Record CLI** — `pd pain record` command
- [ ] **Phase 10: Samples CLI** — `pd samples list` and `pd samples review`
- [ ] **Phase 11: Evolution Tasks CLI** — `pd evolution tasks` command
- [ ] **Phase 12: Health + Central Sync CLI** — `pd health` and `pd central sync` commands
- [ ] **Phase 13: Migration Safeguards** — Dual-write protection during migration

---

## Phase Details

### Phase 8: SDK Foundation
**Goal**: Core SDK interfaces and primitives needed by all CLI commands
**Depends on**: Nothing
**Requirements**: CLI-FOUNDATION-01, CLI-FOUNDATION-02, CLI-FOUNDATION-03, CLI-FOUNDATION-04
**Success Criteria** (what must be TRUE):
1. WorkspaceResolver interface is extracted and used in place of OpenClawPluginApi direct calls
2. PainRecorder class exists independently of OpenClawPluginApi
3. atomicWriteFileSync is exported from @principles/core
4. PainFlagPathResolver is available in @principles/core SDK

---

### Phase 9: Pain Record CLI
**Goal**: Users can record pain signals via `pd pain record` command
**Depends on**: Phase 8
**Requirements**: PAIN-RECORD-01
**Success Criteria** (what must be TRUE):
1. `pd pain record` command is registered and executable
2. Command accepts pain signal input and writes to pain flag file
3. Command provides feedback on successful recording

---

### Phase 10: Samples CLI
**Goal**: Users can list and review samples via `pd samples` commands
**Depends on**: Phase 8
**Requirements**: SAMPLES-01, SAMPLES-02
**Success Criteria** (what must be TRUE):
1. `pd samples list` command displays available samples
2. `pd samples review` command opens review flow for selected sample
3. Both commands work against sample store without OpenClaw dependency

---

### Phase 11: Evolution Tasks CLI
**Goal**: Users can view evolution tasks via `pd evolution tasks` command
**Depends on**: Phase 8
**Requirements**: EVOLUTION-01
**Success Criteria** (what must be TRUE):
1. `pd evolution tasks` command is registered and executable
2. Command displays pending evolution tasks with status
3. Output is human-readable and consistent with existing PD status formats

---

### Phase 12: Health + Central Sync CLI
**Goal**: Users can run health checks and central sync via `pd health` and `pd central sync`
**Depends on**: Phase 8
**Requirements**: HEALTH-01, SYNC-01
**Success Criteria** (what must be TRUE):
1. `pd health` command runs diagnostics and reports system status
2. `pd central sync` command synchronizes with central server
3. Both commands handle errors gracefully with user-friendly messages

---

### Phase 13: Migration Safeguards
**Goal**: Existing openclaw tools continue working while CLI is adopted; no dual-write data loss
**Depends on**: Phases 9, 10, 11, 12
**Requirements**: MIGRATE-01
**Success Criteria** (what must be TRUE):
1. Existing `write_pain_flag` tool still writes pain flags correctly
2. CLI commands write to the same storage locations as existing tools
3. No race conditions or data loss when both paths are active
4. Migration path is documented for users

---

## Progress

| Phase | Goal | Requirements | Status |
|-------|------|--------------|--------|
| 8. SDK Foundation | Core SDK interfaces | 4 reqs | Not started |
| 9. Pain Record CLI | pd pain record | 1 req | Not started |
| 10. Samples CLI | pd samples list/review | 2 reqs | Not started |
| 11. Evolution Tasks CLI | pd evolution tasks | 1 req | Not started |
| 12. Health + Central Sync CLI | pd health + central sync | 2 reqs | Not started |
| 13. Migration Safeguards | Dual-write protection | 1 req | Not started |

---

*Created: 2026-04-20 for v1.22 PD CLI Redesign milestone*
