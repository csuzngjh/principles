# Roadmap

## Milestones

- ✅ **v1.0-alpha MVP** - Phases 1-3 (shipped 2026-03-26)
- 🚧 **v1.4 OpenClaw v2026.4.3 Compatibility** - Phase 5 (in progress)
- 📋 **v1.5** - Planned

## Phases

<details>
<summary>✅ v1.0-alpha MVP (Phases 1-3) - SHIPPED 2026-03-26</summary>

### Phase 1: SDK Integration
**Goal**: OpenClaw plugin SDK integration
**Plans**: 1 plan

Plans:
- [x] 01-01: SDK Integration

### Phase 2: Memory Search
**Goal**: Basic memory search capability
**Plans**: 1 plan

Plans:
- [x] 02-01: Memory Search

### Phase 2.5: SDK Refinement
**Goal**: SDK refinement and factory pattern
**Plans**: 1 plan

Plans:
- [x] 02.5-01: SDK Refinement

### Phase 3A: Input Quarantine
**Goal**: PD-specific input isolation
**Plans**: 1 plan

Plans:
- [x] 03A-01: Input Quarantine

### Phase 3B: Gate Split
**Goal**: Gate module refactoring (72% code reduction)
**Plans**: 1 plan

Plans:
- [x] 03B-01: Gate Split

### Phase 3C: Defaults & Errors
**Goal**: Centralized configuration and error handling
**Plans**: 1 plan

Plans:
- [x] 03C-01: Defaults & Errors

</details>

### 🚧 v1.4 OpenClaw v2026.4.3 Compatibility (In Progress)

**Milestone Goal:** Migrate PD plugin to OpenClaw SDK v2026.4.3, fixing breaking changes in tools, hooks, memory search, and workspace handling.

#### Phase 1: SDK Type Cleanup ✅
**Goal**: Remove false type declarations from openclaw-sdk.d.ts
**Plans**: 1 plan

Plans:
- [x] 01-01: SDK Type Cleanup

#### Phase 2: Memory Search (FTS5) ✅
**Goal**: Replace deprecated createMemorySearchTool with FTS5 search on pain_events
**Plans**: 1 plan

Plans:
- [x] 02-01: FTS5 Search Migration

#### Phase 5: Integration Testing 🚧
**Goal**: Runtime verification of all v1.4 changes
**Depends on**: Phase 1, Phase 2
**Plans**: 1 plan

Plans:
- [ ] 05-01: Integration Testing

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1 | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 2 | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 2.5 | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 3A | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 3B | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 3C | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 1 | v1.4 | 1/1 | Complete | 2026-04-05 |
| 2 | v1.4 | 1/1 | Complete | 2026-04-05 |
| 5 | v1.4 | 0/1 | In progress | — |
