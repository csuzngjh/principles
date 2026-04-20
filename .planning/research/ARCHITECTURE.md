# Research: Architecture for PD CLI

## Integration with Existing SDK

| SDK Component | PD CLI Usage |
|---|---|
| PainSignalSchema + validatePainSignal() | Direct import — build pain signal with schema validation |
| PainSignalAdapter<TRawEvent> | Direct import — if CLI has hook framework |
| StorageAdapter | Direct import — FileStorageAdapter as production impl |
| EvolutionHook | Direct import — no-op default available |

## New Components Needed

```
packages/pd-cli/
├── src/
│   ├── index.ts              # Commander.js entry
│   ├── commands/
│   │   ├── pain.ts           # pd pain record
│   │   ├── samples.ts        # pd samples list/review
│   │   ├── evolution.ts      # pd evolution tasks
│   │   ├── health.ts         # pd health
│   │   └── central.ts        # pd central sync
│   ├── adapters/
│   │   └── pd-storage.ts     # PD-specific storage (extends FileStorageAdapter)
│   └── lib/
│       └── workspace-resolver.ts  # Reuse from openclaw-plugin
├── package.json
└── tsconfig.json
```

## Key Architecture Decisions

1. **WorkspaceContext.fromHookContext** — same factory used by plugin commands works for standalone CLI if passing workspaceDir directly
2. **No OpenClaw dependency** — core logic has no plugin hook requirement
3. **SDK-first** — consume @principles/core for types and interfaces
4. **Gradual migration** — keep existing tools + add CLI as new path
