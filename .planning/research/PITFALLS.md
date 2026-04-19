# Pitfalls Research

**Domain:** YAML runtime integration — wiring WorkflowFunnelLoader into RuntimeSummaryService
**Researched:** 2026/04/19
**Confidence:** MEDIUM-HIGH

## Critical Pitfalls

### Pitfall 1: FSWatcher leak on double-watch

**What goes wrong:**
Calling `loader.watch()` twice without calling `dispose()` first leaks the first FSWatcher handle. The second call overwrites `this.watchHandle` with a new watcher, leaving the original watcher dangling and still consuming OS resources.

**Why it happens:**
`watch()` does not check if a watch handle already exists. It directly assigns `this.watchHandle = fs.watch(...)`. There is no guard like `if (this.watchHandle) return;` or `this.dispose()` before creating a new watcher.

**How to avoid:**
Add an early-return guard at the top of `watch()`:
```typescript
if (this.watchHandle) return;
```
Or always call `this.dispose()` before assigning a new handle. Also expose `isWatching()` so consumers can check state.

**Warning signs:**
- Multiple `fs.watch` handles appearing for the same file in OS-level tooling (e.g., `lsof`, `handle` on Windows)
- Hot-reload firing more than once per actual file save
- `dispose()` not actually stopping file system events

**Phase to address:**
Phase 1 (Workflow Funnel Runtime) — must be resolved before `watch()` goes into production use.

---

### Pitfall 2: Silent fallback — RuntimeSummaryService never consumes WorkflowFunnelLoader

**What goes wrong:**
`RuntimeSummaryService` is the runtime display layer, but it currently has **zero integration** with `WorkflowFunnelLoader`. The funnel config is loaded and watched by the loader, but the summary display never reads from it. The YAML SSOT is effectively inert — it loads correctly but produces no visible output.

**Why it happens:**
The loader was built as a standalone component (D-04: code only reads YAML, never writes it). Integration into `RuntimeSummaryService` was deferred to a subsequent milestone. Without integration, the loader's data is never displayed.

**How to avoid:**
Plan the integration wire-up as part of Phase 1. The funnel stages should flow from `WorkflowFunnelLoader.getStages(workflowId)` into the summary's `phase3` or a new `funnels` section. Add an integration test that verifies the loader's output appears in the summary.

**Warning signs:**
- `WorkflowFunnelLoader` has tests but no tests exercising it via `RuntimeSummaryService`
- Funnel display queries return empty even when `workflows.yaml` is correctly populated
- No warning emitted when funnel config is present but summary ignores it

**Phase to address:**
Phase 1 (Workflow Funnel Runtime) — this is the core deliverable, not a nice-to-have.

---

### Pitfall 3: YAML parse errors surface only as console.warn — invisible to runtime summary consumers

**What goes wrong:**
When `workflows.yaml` contains malformed YAML or schema-invalid content, `WorkflowFunnelLoader.load()` catches the error, logs a `console.warn`, and preserves the last known-good config. But this warning is only visible in process logs. `RuntimeSummaryService.metadata.warnings` has no mechanism to receive loader warnings, so users see stale (silently-preserved) funnel data with no indication anything is wrong.

**Why it happens:**
Two separate warning systems: `WorkflowFunnelLoader` uses `console.warn` internally, while `RuntimeSummaryService` accumulates warnings in a `warnings: string[]` array that is included in the summary payload. These systems are not connected.

**How to avoid:**
Pass a warning callback into `WorkflowFunnelLoader.load()` so callers can receive parse warnings and incorporate them into their own warning list. Or expose a `getLastLoadWarnings()` method. Alternatively, have `RuntimeSummaryService` create the loader and surface its warnings directly.

**Warning signs:**
- User edits `workflows.yaml` with invalid YAML — no error shown in summary/status query
- Funnel stages appear unchanged after a YAML edit even though the edit "should" have changed them
- No validation error in the CLI output when running `/pd-status`

**Phase to address:**
Phase 1 — parse error visibility is essential for developer experience when editing `workflows.yaml`.

---

### Pitfall 4: Watcher debounce timer not cleared on file series (editor save patterns)

**What goes wrong:**
Text editors (VS Code, etc.) often write files in multiple rapid writes: content write + metadata write + atomic-save swap. The 100ms debounce may fire on the first write, reload with a partially-written file, then fire again on the second write before the debounce timer from the first fire has been cleared.

**Why it happens:**
`fs.watch` on Windows uses the `ReadDirectoryChangesW` API which can report multiple `change` events per logical save. Some editors produce >100ms gaps between sub-writes, causing premature reload of incomplete files.

**How to avoid:**
Validate the loaded YAML has a valid `version` string before committing it as the new config — a partially-written file is unlikely to parse to a valid `version` field. Alternatively, use `chokidar` which coalesces editor save patterns across platforms.

**Warning signs:**
- `workflows.yaml` validation warning fires with "missing version or funnels array" on every save from a specific editor
- Funnel stages intermittently appear empty after saves
- "Skipping invalid funnel entry" warnings in logs after editor saves

**Phase to address:**
Phase 1 — should be validated with actual editor save patterns before declaring the watcher production-ready.

---

## Moderate Pitfalls

### Pitfall 5: Memory snapshot returned by getAllFunnels() — stale copy risk

**What goes wrong:**
`getAllFunnels()` returns `new Map(this.funnels)` — a shallow copy of the internal map. The `WorkflowStage[]` arrays are shared references. If a consumer mutates a returned stage array, it mutates the shared state inside the loader. Subsequent calls to `getAllFunnels()` return the already-mutated stages.

**Why it happens:**
`new Map(this.funnels)` creates a new Map object, but the values (the `WorkflowStage[]` arrays) are not cloned. The comment says "atomic replace" for the funnels map but only the map structure is atomic — not the stage arrays.

**How to avoid:**
Deep-clone the stage arrays in `getAllFunnels()`, or return a frozen view and document that mutation is prohibited. Alternatively, make `WorkflowStage` objects immutable by design (all fields readonly).

**Warning signs:**
- Funnel stages appearing to change spontaneously with no file change
- Tests that modify loader output and then observe unexpected behavior

**Phase to address:**
Phase 1 — before multi-consumer usage of the loader (e.g., summary service + another consumer simultaneously).

---

### Pitfall 6: No lifecycle management — loader instantiated but never disposed in long-running processes

**What goes wrong:**
If `WorkflowFunnelLoader` is instantiated at plugin startup and `watch()` is called, but the plugin is unloaded or the workspace is switched without calling `dispose()`, the FSWatcher handle persists. In long-running processes (OpenClaw daemon), this accumulates leaked watchers across workspace switches.

**Why it happens:**
There is no explicit lifecycle contract. The loader has a `dispose()` method but there is no guarantee it is called. The plugin entry point does not show any teardown logic for the loader.

**How to avoid:**
Register the loader in a resource registry that tracks all FSWatcher-backed resources and tears them down on plugin unload. Document the `dispose()` contract prominently. Consider using `AsyncDisposable` pattern if the service layer supports it.

**Warning signs:**
- Leaked FSWatcher handles observable after workspace switching
- Process cannot exit because FSWatcher keeps the event loop alive

**Phase to address:**
Phase 1 — lifecycle management must be designed before the watcher goes into production.

---

### Pitfall 7: Event filtering in fs.watch — 'rename' events ignored on Windows

**What goes wrong:**
`fs.watch` on Windows can emit `rename` events when files are saved (especially with editor atomic-save patterns). The current implementation only acts on `eventType === 'change'`. On Windows, some saves may produce a `rename` event instead of a `change` event, so the debounce never fires and the file change is not detected.

**Why it happens:**
`fs.watch` behavior is platform-dependent. The code filters to `eventType !== 'change'` and returns early. On Windows, atomic-save workflows can produce `rename` events that are silently ignored.

**How to avoid:**
Handle both `change` and `rename` events:
```typescript
if (eventType !== 'change' && eventType !== 'rename') return;
```
Alternatively, use `chokidar` which normalizes these events across platforms.

**Warning signs:**
- Hot-reload works on macOS/Linux but not on Windows
- File changes in VS Code on Windows not detected by the watcher

**Phase to address:**
Phase 1 — if cross-platform support is a requirement.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Using `console.warn` for YAML parse errors instead of typed error propagation | Simple, no API surface change | Errors invisible to consumers; no actionable user feedback | Never in production — only acceptable in quick prototyping |
| 100ms debounce hardcoded | Simple implementation | Wrong for some editor save patterns; cannot be tuned per-environment | Only acceptable if validated against all target editors |
| `getAllFunnels()` returns shared array references | No allocation overhead | Consumer mutation corrupts loader state | Never — violates immutability principle |
| No integration test between loader and RuntimeSummaryService | Faster initial delivery | SSOT silently produces no output; regressions undetected | Only in Phase 0 — must be added in Phase 1 |

---

## Integration Gotchas

| Integration Point | Common Mistake | Correct Approach |
|-------------------|----------------|-----------------|
| WorkflowFunnelLoader -> RuntimeSummaryService | Instantiating loader independently in each service (duplicate FSWatchers) | Single shared loader instance per workspace, injected into consumers |
| Loader `watch()` -> lifecycle | Calling `watch()` without teardown path | `dispose()` must be called on workspace switch or plugin unload; register in resource tracker |
| Loader `load()` -> error handling | Ignoring `console.warn` output in headless environments | Surface warnings in RuntimeSummaryService.metadata.warnings or a dedicated `/pd-status` warnings section |
| YAML file -> runtime display | Treating missing file as "all funnels empty" when it means "config not yet created" | Distinguish: missing file (first-time setup) vs empty file (explicit no-funnels state); warn on missing file, don't silently clear |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| `fs.watchFile` (polling) instead of `fs.watch` (native events) | High CPU usage in large workspaces | Use `fs.watch` with native events; `fs.watchFile` only as fallback | At scale with many files being watched |
| Loading and validating full YAML on every summary query | Slow `/pd-status` responses when YAML is large | Cache parsed funnel data in loader; `watch()` triggers invalidation; summary reads from cache | When workflows.yaml grows beyond ~50 stages |
| `getAllFunnels()` called on every summary query, creating new Map copies | Memory churn from many Map/Array allocations | Return frozen view or cached immutable snapshot | At high query frequency |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Using `yaml.load()` with DEFAULT_SCHEMA (includes arbitrary JS types like `!!js/function`) | Arbitrary code execution if YAML contains malicious constructs | Use `yaml.SAFE_SCHEMA` or `yaml.DEFAULT_SCHEMA` with `schema: yaml.JSON_SCHEMA` to exclude JS types |
| No path traversal guard on `stateDir` | If `stateDir` is user-controlled, config path could escape expected directory | `path.join()` used correctly here; validate `stateDir` is absolute and inside expected workspace root before constructing path |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No feedback when `workflows.yaml` is loaded successfully | User cannot confirm their edits were picked up | Log at `console.debug` level (not warn/error) on successful load, or add verbose flag to `/pd-status` |
| Silent "preserving last valid config" on bad YAML | User's bad YAML is silently ignored; they think they changed behavior when they didn't | At minimum, surface a clear warning in `/pd-status` output that YAML parse failed and last valid config is being used |
| No diff / no preview of how funnel config changes affect summary | Users cannot validate their `workflows.yaml` changes before reloading | Consider a dry-run or validate mode that shows what the summary would look like with the new YAML |

---

## "Looks Done But Isn't" Checklist

- [ ] **FSWatcher cleanup:** `dispose()` is called — verify with integration test that watch handle is actually closed after dispose
- [ ] **YAML errors visible:** `/pd-status` shows a warning when `workflows.yaml` parse fails — verify by corrupting the YAML and checking output
- [ ] **Funnel data in summary:** Runtime summary includes funnel stage data from `WorkflowFunnelLoader` — verify with a populated `workflows.yaml`
- [ ] **Double-watch safe:** Calling `watch()` twice does not leak handles — verify with OS-level handle count
- [ ] **Windows compatibility:** `rename` events handled — verify with VS Code on Windows saves
- [ ] **Memory isolation:** `getAllFunnels()` returns immutable data — verify consumers cannot mutate internal state

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| FSWatcher leak | MEDIUM | Restart the OpenClaw daemon; fix `watch()` guard in code; add integration test to catch regression |
| YAML parse error invisible | LOW | Run `cat .state/workflows.yaml` to inspect raw YAML; check process logs for `console.warn` output from loader |
| Stale memory snapshot (shared array references) | MEDIUM | Force a fresh load by touching the YAML file (triggers watch -> load); identify mutation source from stack trace if reproducible |
| Funnel data not in summary (no integration) | LOW | Add the integration wire in Phase 1; no runtime recovery needed, just missing feature |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| FSWatcher leak on double-watch | Phase 1 | Unit test calling `watch()` twice; verify `dispose()` closes handle |
| Silent fallback — loader not integrated | Phase 1 | Integration test: populated `workflows.yaml` -> verify summary includes funnel data |
| YAML parse errors invisible | Phase 1 | Corrupt YAML -> run `/pd-status` -> verify warning in output |
| Watcher debounce too short for editor saves | Phase 1 | Test with VS Code, Sublime, nano save patterns; observe reload behavior |
| Shared array reference mutation | Phase 1 | Unit test mutating returned stages; verify internal state unchanged |
| No lifecycle / dispose on workspace switch | Phase 1 | Workspace switch test; verify no leaked handles in process |
| `rename` event ignored on Windows | Phase 1 | Test on Windows with VS Code; verify reload fires on save |

---

## Sources

- `packages/openclaw-plugin/src/core/workflow-funnel-loader.ts` — FSWatcher lifecycle, YAML loading, debounce
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` — RuntimeSummaryService architecture, warning accumulation
- Node.js `fs.watch` documentation — platform differences, event types
- `js-yaml` documentation — safe load, schema options
- Project memory: `project-v1.21.1-workflow-funnel-runtime.md` — YAML SSOT design intent

---

*Pitfalls research for: YAML runtime integration (WorkflowFunnelLoader -> RuntimeSummaryService)*
*Researched: 2026/04/19*
