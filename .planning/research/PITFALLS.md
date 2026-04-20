# Research: Pitfalls for PD CLI

## Critical Pitfalls

| Pitfall | Severity | Phase | Prevention |
|---------|----------|-------|------------|
| OpenClawPluginApi tight coupling | HIGH | Phase 0 | Extract WorkspaceResolver interface |
| TrajectoryRegistry singleton dependency | HIGH | Phase 1 | Define TrajectoryStore interface |
| Hardcoded .state/.pain_flag path | MEDIUM | Phase 1 | Define PainFlagPathResolver in SDK |
| atomicWriteFileSync not in SDK | MEDIUM | Phase 0-1 | Export from principles-core |
| Tool registration pattern mismatch | MEDIUM | Phase 0 | Create PainRecorder class decoupled from OpenClawPluginApi |
| painEventId propagation gap | MEDIUM | Phase 1 | Document dependency, allow undefined |
| SDK too abstract for tool use | HIGH | Phase 2 | Add PainFlagStore to SDK |
| Dual-write race during migration | MEDIUM | Phase 1-2 | Use existing asyncLockQueues |

## Recommended Phase 0 Work

1. Extract WorkspaceResolver interface from resolveWorkspaceDirFromApi
2. Create PainRecorder class decoupled from OpenClawPluginApi
3. Export atomicWriteFileSync from principles-core
4. Add PainFlagPathResolver to SDK
