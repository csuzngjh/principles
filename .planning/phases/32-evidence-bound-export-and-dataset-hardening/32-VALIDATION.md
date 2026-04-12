# Validation 32

## 32-01

- `npm test -- --run tests/core/nocturnal-export.test.ts tests/core/nocturnal-trinity.test.ts tests/core/pain-integration.test.ts tests/service/evolution-task-dispatcher.contract.test.ts`
  - Result: pass (`102 passed`)
- `npm run build`
  - Result: pass

## Remaining 32 Scope

- Promotion-facing narratives still need the same evidence-bound treatment
- Dataset read/report helpers should expose evidence state directly instead of requiring export-time reconstruction
- `32-02` replay/promotion evidence summary hardening completed
- `npm test -- --run tests/core/replay-engine.test.ts tests/core/promotion-gate.test.ts tests/core/nocturnal-export.test.ts`
  - Result: pass (`49 passed`)
- `npm run build`
  - Result: pass
