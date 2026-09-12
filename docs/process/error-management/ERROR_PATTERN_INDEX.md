# Error Pattern Index

This compact index is the first stop for coding tasks. Use it to select the relevant detailed entries in `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` instead of loading the full incident log into context by default.

For a task, pick the matching pattern cards, read the listed ERR entries, and state how the implementation avoids recurrence. If a review finding is another instance of an existing pattern, update that pattern or the matching handbook entry's Recurrence field instead of creating a new top-level error class.

## Pattern Cards

### EP-01 Trust Boundary Validation

<!-- error-pattern-routing
{
  "id": "EP-01",
  "risk": "high",
  "pathSignals": [
    "src/adapters",
    "src/io",
    "validator",
    "parse",
    "schema"
  ],
  "diffSignals": [
    "JSON.parse",
    " as Record<",
    " as unknown as",
    " as TOutput",
    "Object.hasOwn",
    " in parsed",
    "degrad",
    "fallback"
  ],
  "requiredEvidence": [
    "Untrusted values stay unknown until a runtime guard validates them (rc-1/rc-2).",
    "Required fields fail loud when missing or malformed (rc-3).",
    "Every output-emitting path (happy/degraded/fallback/exhausted) emits only validated objects."
  ],
  "enforcement": "mixed"
}
-->

- **Use when**: handling parsed JSON, LLM output, SQLite rows, CLI options, artifact metadata, YAML, or caught errors — including degradation/fallback/retry-exhausted paths. Also applies to `as` casts on known-typed objects used to silence TypeScript index-signature complaints.
- **Failure mode**: `as` casts or typed helper parameters make untrusted runtime values look validated; runtime shape checks validate wrong field names, making checks vacuous; degradation paths emit objects built from validator-rejected candidates; **or `as Record<string, T>` casts silence TypeScript's index-signature complaint on a known-typed interface when direct `obj[key] = value` is type-safe (key is `keyof T`) — this sibling flavor needs NO runtime guard, just removal of the cast (ERR-001 recurrence PR #1104)**.
- **Must check**: values stay `unknown` until runtime guards validate them; required fields fail loud; arrays validate elements; `Object.hasOwn()` is used for untrusted keys; **plain-object lookup tables indexed by external input (`table[key]`) are guarded by `Object.hasOwn(table, key)` first — `table['__proto__']` returns `Object.prototype`, not `undefined` (ERR-013 broaden); prefer `Map` or `Object.create(null)` for externally-keyed tables**; shape checks validate fields that actually exist in the target type; **every output-emitting path (happy, degraded, fallback, exhausted) emits only validated objects — degradation is a content transform, not a trust escape hatch**; **for `as Record<string, T>` on a known-typed interface, attempt direct `obj[key] = value` first — if it compiles, the cast is unnecessary and must be removed (ERR-001 recurrence PR #1104)**.
- **Representative ERRs**: ERR-001, ERR-005, ERR-009, ERR-013, archived-054, archived-057, archived-061, ERR-065, ERR-069, ERR-076.
- **Automation target**: static scan for `as Record<string, unknown>`, `as TOutput`, `as Record<string,` (index-signature silencer pattern), and casts near parse/adapter/DB/CLI boundaries; grep degradation/fallback functions for emit-before-validate.

### EP-02 Production Path Wiring and Architecture Boundaries

<!-- error-pattern-routing
{
  "id": "EP-02",
  "risk": "high",
  "pathSignals": [
    "src/main",
    "src/preload",
    "src/index.ts",
    "package.json",
    "cli",
    "server",
    "dispatcher",
    "install"
  ],
  "diffSignals": [
    "BrowserWindow",
    "preload",
    "ipcMain",
    "export ",
    "registerCommand",
    ".command(",
    "new ",
    "resolve",
    "symlink",
    "link",
    "RETIRE",
    "retired",
    "gone",
    "tombstone",
    "census"
  ],
  "requiredEvidence": [
    "Prove the real production/public entry point consumes the changed mechanism (production-path integration or smoke evidence).",
    "If a shared contract changed, inspect and exercise the relevant cross-package consumers.",
    "Do not use isolated helper tests as the only production-wiring evidence.",
    "When retiring/renaming a registry-published value or deleting an operator-facing artifact, ALL read/display sites of the changed value plus every doc/test/inventory reference were enumerated before claiming synced/retired; audit-deferred surfaces stayed out of delete scope (ERR-024)."
  ],
  "enforcement": "semantic"
}
-->

- **Use when**: adding validators, dispatchers, activation paths, CLI commands, baselines, guards, helper APIs, or PDRuntimeAdapter implementations; also when tightening a shared store/API contract by adding a rejection guard, precondition, or FK check that throws; **also when changing a shared type union, interface, or service method signature that crosses package boundaries**; **also when changing a package's `name` field in `package.json` — CI workflows and scripts reference packages by name via `--workspace=<name>`, not by directory**; **also when a browser package imports a shared package barrel that may export Node-only modules, or when a diff adds an entry to an architecture/I/O exception registry**.
- **Failure mode**: a component exists and has isolated tests, but the real user/operator path never calls it; an adapter hand-builds a return object from a remembered schema instead of the real one, masked by `as`; OR a shared store method is tightened with a new rejection guard and isolated same-package tests pass, but cross-package production paths that call it without satisfying the new precondition break (ERR-083); **OR a shared type union is changed (e.g. status enum) or a new service method is added, but UI validators, integration tests, and `vi.mock` mocks are not updated, causing CI failures in downstream packages (ERR-083 broaden)**; **OR a browser runtime import targets a Node-oriented barrel, so tree-shaking still resolves filesystem, database, crypto, or other Node-only modules and the client build fails (ERR-100)**; **OR a shared constant or default value (e.g. `PRODUCTION_WORKSPACE_PATHS`) is changed from hardcoded values to cross-platform ones, but same-package or cross-package tests that hardcode the old values are not updated, causing CI failures on platforms where the old values were valid (ERR-083 recurrence PR #1183)**; **OR a shared test fixture/environment assumption is changed in one test file, but a sibling in-process test still reads env/filesystem directly — passes on dev machines whose real artifacts mask it, fails on clean CI runners (ERR-083 recurrence PRI-526)**.
- **Must check**: tests exercise the production entry point, not only leaf helpers; new CLI commands are registered in Commander; activation writes are read by the live prompt path; adapter return objects are built from the verbatim Typebox schema (RunHandleSchema/RunStatusSchema), not memory; new public types/functions are re-exported from barrel `index.ts` at every ancestor level; **a finally-blocked per-cycle budget/cleanup must not depend on a resource constructed after an early-return branch — enumerate every early return between resource-open and the budget and prove the budget still runs on each (the idle/empty path is usually the one the budget exists for; ERR-024 recurrence PR #1358)**; **when a durable decision is persisted before side effects, EVERY re-entry path (retry, lease-expiry recovery, reconciliation, resume) must consume that decision as the authority — never re-consult a non-deterministic advisor (LLM) for a decision already durably recorded but not yet applied (ERR-024 recurrence PR #1358 round 5: verdict drift)**; **when adding optional deps/fields/handlers to a constructor/service interface, grep ALL construction sites (`new X(` / `X({`) and update each one to pass the new deps — isolated tests on the helper alone do not prove the production path uses it (ERR-024 recurrence PRI-510)**; **the mirror applies when STARTING to pass a previously-dormant optional dependency into a construction path: grep ALL of the dependency's consumption sites (e.g., every `this.eventEmitter?.…` emission) — each dormant site activates with the new wiring's channel/semantics; route every site intentionally or filter to the intended events, with a negative-control test proving unintended sites stay dormant (ERR-024 recurrence PR #1389: wiring an emitter to forward two new events re-emitted routine `candidate_admission_decision` as `degradation_triggered` and changed flag-off behavior)**; **when a pure classifier sits behind a production resolver, "absent on valid input" and "input unresolvable" are different states — collapsing them creates dead branches that direct-call tests cannot catch; add one resolver→classifier composition test with the production input shape (ERR-024 recurrence PR #1551: the v2-out-of-scope partition was unreachable for v1 rules because key-absent collapsed into unresolvable-null)**; **when adding evidence fields to a failure payload mirrored across MULTIPLE observability surfaces (error details / evidencePack / telemetry events), grep ALL emission sites of the same logical failure and assert the full field set on EACH surface — partial propagation blinds the consumers the evidence was added for, and the gap lands outside the diff (ERR-024 recurrence PR #1574 review: evidencePack + `output_extraction_failed` carried finish metadata but the terminal `output_repair_exhausted` event kept its old payload)**; **when retiring/renaming a registry-published value (flag category, enum, shared constant) or deleting an operator-facing artifact (CLI command, scenario, doc section), grep ALL read/display sites of that value (config merge functions, CLI surfaces, console summaries) plus every doc/test/inventory reference (runner loops, file trees, counts) before claiming "synced/retired" — a write-side change does not propagate itself; a surface an audit explicitly deferred to a separate Owner decision stays out of delete scope until that decision lands (ERR-024 recurrence PRI-752)**; **when adding a `throw`-on-missing guard to a `principles-core` store method consumed by other packages, grep all cross-package callers, confirm each satisfies the new precondition, and run at least one test in each consuming package**; **when changing a shared type union, grep `Set<string>` validators and `as` narrowing in UI layers; when adding a new method to a service that has `vi.mock` in tests, grep `vi.mock('../../src/core/<service>.js')` and add the new method to each mock**; **when changing a shared constant or default value (e.g. `PRODUCTION_WORKSPACE_PATHS`), grep for tests that hardcode the old value (e.g. `'D:\\.openclaw\\workspace'`) and replace with a constant mirroring the production default — same-package tests can break too, not just cross-package**; **when changing a package's `name` field, grep `--workspace=<old-name>` in `.github/workflows/*.yml` and all `package.json` scripts — npm workspace resolution uses the `name` field, not the directory name (ERR-083 broaden)**; **when changing a shared test fixture or environment assumption in a test file (beforeEach setup, HOME/path redirection), audit EVERY test in the file — in-process handler tests read env/filesystem directly while subprocess tests inherit the injected env — and re-verify under the clean condition (e.g., `HOME=<bogus>` locally) before pushing; a dev machine's real artifacts (e.g. a real `~/.openclaw` install) mask the failure that CI will hit (ERR-083 recurrence PRI-526)**; **UI display copy/styling derived from a status union must use an exhaustive `Record<Union, …>` map — binary ternaries fold unhandled members into a default that misrepresents their state (ERR-106)**.
- **Durable round-trip addition (ERR-083 recurrence)**: for optional strings written from UI/CLI input, test empty-input → write → read and normalize blank input to the reader's canonical absent value (`null`).
- **Representative ERRs**: ERR-011, ERR-024, ERR-025, ERR-035, ERR-048, archived-053, archived-060, ERR-063, archived-064, ERR-067, ERR-069, ERR-070, ERR-083, ERR-100, ERR-106, ERR-107.
- **Automation target**: command-tree tests, production-path smoke tests, fixture evidence that names the real dispatcher/facade, and schema-field cross-checks for adapter return shapes; cross-package CI tests that exercise store methods after a guard is added.

### EP-03 Fail Loud and Observable Degradation

<!-- error-pattern-routing
{
  "id": "EP-03",
  "risk": "high",
  "pathSignals": [
    "src/main",
    "server",
    "install",
    "cli",
    "runtime"
  ],
  "diffSignals": [
    "safeStorage",
    "saveState",
    "restart",
    "catch",
    "rollback",
    "nextAction",
    "reason",
    "persist",
    "success: true",
    "return true"
  ],
  "requiredEvidence": [
    "Persistence/failure cannot become success: every refusal or degradation carries a structured reason + nextAction (rc-9).",
    "No empty catch blocks and no assertions hidden behind truthy conditionals.",
    "Failed stages do not report success or partial results as complete."
  ],
  "enforcement": "mixed"
}
-->

- **Use when**: adding catch blocks, validators, degraded modes, installer results, JSON output, or fallback behavior.
- **Failure mode**: invalid input, failed cleanup, malformed config, or incomplete delivery silently becomes success or an unexplained fallback; **or a stricter optional authority is enabled but unavailable and the UI falls through to a legacy allow decision (ERR-102)**; **or a missing required fact is substituted with a sentinel value that satisfies a downstream structural check (non-empty/non-null), while the operator-facing success criterion measures an upstream dimension (generated/submitted) instead of the outcome dimension (admitted/delivered) — three individually-correct layers then compound into silently losing the Owner's input AND reporting success (ERR-112)**.
- **Must check**: every refusal/degradation includes a structured reason and next action; no `catch {}`; no `if (valid) { assert }` tests that pass when data is absent; **for any sentinel/placeholder substitution on a semantically-required field, name the downstream consumer that performs a structural check the sentinel satisfies — if one exists, the substitution is a bug; classify missing facts as a discriminated `unavailable{reasonCode}` result instead (ERR-112)**; **every branch of a multi-path degradation (happy / V1-fallback / exhausted) applies the SAME failure guard — an alternate/degraded code path that skips the try/catch its siblings use will throw past a never-throws contract (PRI-428 recurrence: the V1 branch of runAdversarialLoop called createEvaluatorTask unguarded while the V2 branch wrapped it; the loop documented "never throws" but the V1 path could)**; **a concurrency primitive's failure/contention path (lock eviction, retry backoff) is itself a degradation path — it must be hardened so it cannot re-open the data-loss/race class the primitive was added to close (ERR-079: age-based lock eviction stole a live holder's lock after lockStaleMs, re-introducing the lost-update class the lock existed to prevent)**; **when FIXING a bug in a multi-branch failure path (happy / !ok / catch-throw / degraded), audit ALL sibling branches for the same defect — fixing only the primary failure path leaves sibling branches with stale state, wrong command paths, or CLI contract violations (ERR-089: the fix-side sibling of ERR-074)**; **new-guard placement audit: a fail-loud guard added to a multi-step mutating flow must execute BEFORE the first irreversible mutation of the thing it protects — a guard that runs after the swaps/copies has nothing left to protect and its own failure path exits on an already-mutated state (PRI-561 recurrence, PR #1379 review round: the host-runtime link check was originally placed AFTER plugin/console/core/pd-cli were swapped, so its early return reported requiresRestart:false over a half-updated install; fixed by moving delivery+links ahead of every package swap)**; **when one concept (workspace, session, store) is resolved through TWO entry-point chains, diff their priority orders and require a convergence test plus a divergence warning on each chain — a silent priority asymmetry between hook-side and command-side resolvers split state trees across two PD instances for days with all gates "correctly" rejecting (ERR-117, PRI-686)**; **reserve-then-fill resource creation must not publish the reserved handle (path/ID/registry entry) until the fill phase completes inside its own error boundary — a mid-fill failure otherwise advertises an incomplete resource as valid (ERR-118: a reserved backup dir was recorded as backupPath before the copy finished, so a mid-copy EPERM made /rollback eligible to restore a fragment as if complete)**; **an install/update pipeline that swaps runtime components must end with a post-apply boot smoke of the swapped entrypoint BEFORE recording success, and component node_modules materialization must be data-driven over the SAME component list everywhere it exists — the resolution-gap class recurred a third time (PRI-561 host-runtime links; the 2026-08-29 install-layout component gap; PRI-711 codex-adapter: the release-locks component list omitted codex-adapter so the payload shipped it bare, and pd-cli's eager import graph — health-codex statically importing it since PRI-625 Slice D — crashed every pd command at startup while the update still recorded success)**.
- **Representative ERRs**: ERR-002, ERR-009, ERR-014, ERR-017, ERR-029, archived-041, archived-062, ERR-070, ERR-071, ERR-072, ERR-074, ERR-079, ERR-082, ERR-089, ERR-102, ERR-109, ERR-112, ERR-114, ERR-117, ERR-118.
- **Automation target**: grep/static guard for empty catch blocks and test assertions hidden behind truthy conditionals; for any function with a documented never-throws/degrades contract, diff-check that EVERY branch (including alternate-type/V1/early-exit branches) wraps the same external calls that the primary branch wraps; for fix PRs touching multi-branch failure paths, diff-check that the same CLI/rollback/exit contract is applied to every sibling branch (happy / !ok / catch / throw); review checklist: for each newly added guard in a diff, name the first mutation below its insertion point — if any exists, move the guard above it or prove the mutation is reversible; **for merges over tri-state facts (`boolean | null` where null = unavailable), require the Kleene test rows (false+null→null and null+false→null) alongside true+unknown — a definite `false` from one source must never resolve another source's unknown (ERR-109)**.

### EP-04 CLI and Operator Contract

<!-- error-pattern-routing
{
  "id": "EP-04",
  "risk": "medium",
  "pathSignals": [
    "packages/pd-cli",
    "commands",
    "installer"
  ],
  "diffSignals": [
    "--json",
    "process.exit",
    "parseAsync",
    "commander",
    "dry-run",
    "dryRun",
    "--yes",
    "nonInteractive",
    "inquirer",
    "db.transaction"
  ],
  "requiredEvidence": [
    "Parser-level tests exercise the real Commander program (cli-7), not only handlers.",
    "Failed validation stops execution and does not mutate state (cli-2/cli-5).",
    "--json stdout emits exactly one parseable machine result (cli-1)."
  ],
  "enforcement": "semantic"
}
-->

- **Use when**: touching `packages/pd-cli`, operator commands, installers, command registration, or JSON mode.
- **Failure mode**: flags parse differently than handlers expect, `process.exit()` falls through, dry-run mutates, JSON stdout is polluted, or nextAction is unusable.
- **Must check**: parser-level tests use the real Commander program; failed paths stop execution and do not mutate state; `--json` emits exactly one parseable object; `--no-<flag>` options are stored as the positive form (e.g., `--no-enqueue-next` → `opts.enqueueNext`), never `opts.noEnqueueNext`; **one-shot migration scripts that mutate multiple DB rows must wrap the mutation loop in `db.transaction(() => { ... })()` so partial failures roll back; docstrings claiming "default dry-run" must match `parseArgs()` actual default — verify by reading the flag-parsing code, not the docstring (ERR-023 recurrence on PR #1079)**; **interactive prompts (`inquirer` `select`/`confirm`/`input`) inside a function reachable from `--yes`/`--non-interactive`/`--json` must be gated on the real `nonInteractive` signal, not on `jsonMode`/`quiet` alone (`--yes` is non-interactive but still emits human output), and each non-interactive mode needs its own test (ERR-096)**.
- **Representative ERRs**: ERR-021, ERR-022, ERR-023, ERR-029, archived-043, archived-053, ERR-063, ERR-066, ERR-089, ERR-096.
- **Automation target**: command wiring tests that call `program.parseAsync()` with full command paths; for migration scripts, grep the script for `db.transaction` and assert it wraps every `db.prepare(...).run()` call in the apply/mutate phase.

### EP-05 Loop State Freshness

<!-- error-pattern-routing
{
  "id": "EP-05",
  "risk": "medium",
  "pathSignals": [
    "retry",
    "repair",
    "loop",
    "runner"
  ],
  "diffSignals": [
    "attempt",
    "retry",
    "repair",
    "iteration",
    "maxAttempts",
    "for (",
    "while ("
  ],
  "requiredEvidence": [
    "Each iteration reads fresh errors/current state, not a stale prior-iteration result (rc-7).",
    "Records are written with current-iteration data; next-attempt state is not stored as current evidence.",
    "Tests cover two distinct failing attempts with per-attempt assertions."
  ],
  "enforcement": "semantic"
}
-->

- **Use when**: implementing retries, repairs, multi-attempt validation, evidence timelines, or iterative LLM repair.
- **Failure mode**: current, next, and recorded state are conflated, so telemetry and repair prompts use stale errors.
- **Must check**: each iteration reads fresh errors; records are written with current-iteration data; next-attempt state is not stored as current-attempt evidence.
- **Representative ERRs**: ERR-018, ERR-067.
- **Automation target**: tests with two distinct failing attempts and assertions on per-attempt recorded errors.

### EP-06 Source of Truth and Generated Artifacts

<!-- error-pattern-routing
{
  "id": "EP-06",
  "risk": "high",
  "pathSignals": [
    "dist/",
    "generated",
    "create-principles-disciple",
    "package.json",
    ".github/workflows",
    "lockfile",
    "package-lock.json",
    "src/ui/pages",
    "src/ui/utils",
    "src/ui/components"
  ],
  "diffSignals": [
    "npm pack",
    "workspace:",
    "uses:",
    "spawn(",
    "process.exit",
    "main\":",
    "exports",
    "webServer",
    "port",
    "lstatSync",
    "import { format",
    "import { validate",
    "from \"../../utils/",
    "from '../utils/"
  ],
  "requiredEvidence": [
    "The source of truth was edited and the generator/artifact rebuilt, not the generated copy patched.",
    "The lockfile CI consumes is the one updated; smoke installs run from packed output.",
    "New/changed entry points exist in ALL build paths (tsc, esbuild) that reference them.",
    "Before adding a NEW import of a shared utility (formatting/validation/logging/hashing), sibling implementations of the same purpose were searched (rg) and the one whose contract documents the needed guardrails was reused — two live implementations are a retirement signal, not a third-consumer license (ERR-126)."
  ],
  "enforcement": "semantic"
}
-->

- **Use when**: editing bundled packages, generated copies, package manifests, installer payloads, lockfiles, files under `packages/create-principles-disciple`, creating GitHub Actions workflows, or writing test infrastructure scripts (e.g., Playwright webServer launchers).
- **Failure mode**: fixes are applied to generated copies or source-tree tests pass while the published artifact is incomplete; or the wrong package manager's lockfile is updated so CI's install step fails; **or `package.json` entry point (`main`/`exports`) is changed to reference a file that only one build tool generates (e.g., esbuild's `bundle.js`), breaking CI paths that use a different build tool (e.g., tsc generates `index.js`) (ERR-090)**; **or an E2E harness reuses any process already listening on a shared fixed port, so the browser tests an installed/stale build instead of the current worktree (ERR-101)**; **or a test hard-fails on a host network capability (e.g., IPv6 loopback) that a VPN/WFP filter silently blocks — `connect('::1')` returns EACCES while the IPv6 stack itself is healthy, so the test must probe-and-skip optional capabilities instead of assuming them (ERR-111)**.
- **Must check**: edit the source of truth and rerun the generator; package runtime dependencies are declared in the package that imports them; the lockfile CI consumes is the one updated; smoke tests install from packed output; **a PR that adds or changes network-egress / privacy-boundary capability in a shipped package must update that package's published README disclosure (and root README absolute claims) in the same diff, locked by a disclosure-contract test (ERR-110)**; **when changing `package.json` entry points, verify the referenced file exists in ALL build paths (tsc, esbuild, webpack) — if not, add a re-export shim or post-build copy step**; **when creating new GitHub Actions workflows, grep existing workflows (e.g., ci.yml) for the `uses:` pinning convention and match it (commit SHA with `# vX` comment); when using `child_process.spawn()` in test scripts, avoid `shell: true` on Linux/CI (signals only kill the shell wrapper, orphaning the subprocess) and never call `process.exit()` in signal handlers before `child.on('exit')` fires**; **when adding LFS-tracked binary assets that tests read in CI, ensure every `actions/checkout` job running those tests has `lfs: true` (default is `false`, producing 132-byte pointer files that fail size/content assertions), and extend any pre-deploy LFS-pointer guard to cover the new asset paths (ERR-091)**; **Playwright `webServer` must use a test-only configurable port with `reuseExistingServer: false`; a port collision must fail loud rather than select an unidentified server (ERR-101)**; **on Windows, directory-ness checks that gate path canonicalization/containment must use stat-following semantics (`statSync().isDirectory()`), not `lstatSync()` — junctions and directory symlinks report as non-directories under lstat, silently skipping canonicalization and defeating lexical containment guards (ERR-090 recurrence)**; **a single-rename atomic directory publication issued right after a mass file write needs a bounded EPERM/EACCES retry with immutable-destination re-checks — antivirus/indexer handles transiently deny the rename on Windows (ERR-090 recurrence)**; **lexical path-containment guards must normalize BOTH sides (`path.resolve`) before comparing — a resolved read path never prefix-matches a raw env/workflow-provided root on Windows, where `${{ runner.temp }}` mixes `\` and `/` separators (ERR-090 recurrence 2026-08-28)**.
- **Representative ERRs**: ERR-040, archived-041, archived-050, ERR-068, ERR-084, ERR-090, ERR-091, ERR-101, ERR-110, ERR-111, ERR-113, ERR-126.
- **Automation target**: generated-artifact checks plus clean `npm pack` install smoke tests; CI lockfile-consistency gate; entry-point resolution check after both tsc and bundler builds; **for generators that reset+rewrite a tree, a rebuild test with a planted rogue file (must vanish) and a post-run `git status` cleanliness assertion (ERR-113)**; **before importing a utility (formatting/validation/logging/hashing), rg-search for sibling implementations of the same purpose and reuse the one whose contract documents the needed guardrails — two live implementations are a retirement signal, not a third-consumer license (ERR-126)**.

### EP-07 Runtime State Source Alignment

<!-- error-pattern-routing
{
  "id": "EP-07",
  "risk": "medium",
  "pathSignals": [
    "resolver",
    "config",
    "state",
    "cache"
  ],
  "diffSignals": [
    "let cached",
    "let last",
    "{...output",
    "timeout",
    "Timeout",
    "deadline",
    "AbortSignal",
    "headersTimeout"
  ],
  "requiredEvidence": [
    "Returned state is read from the canonical source after writes; lineage fields come from one authority (rc-6).",
    "Module-level caches keyed by input use Map<string, T>, not single-valued slots.",
    "A configured deadline is proven to be the tightest timer on the actual wire path."
  ],
  "enforcement": "semantic"
}
-->

- **Use when**: returning config, reading disk state, resolving runtime/provider endpoints, lineage, or artifact source IDs; **also when caching per-workspace derived values (file paths, DB connections, service instances) at module scope**; **also when configuring any timeout/deadline on a layered request stack (runner budget → SDK request timeout → HTTP transport)**.
- **Failure mode**: output reports requested inputs instead of actual state, or fields from different sources are mixed into one lineage/config result; **OR a module-level cache (`let cachedX` / `let lastX`) stores a value derived from a function parameter (workspaceDir, stateDir) but is NOT keyed by that parameter — the first caller's value leaks to all subsequent callers, writing workspace B's output to workspace A's destination (ERR-092)**; **OR an "additive" envelope/annotation merged via `{...output, newKey}` reuses a field name the target output schema already declares, silently overwriting the legitimate field, OR a validator reconstructs its validated output field-by-field and omits a declared section — the transform's key set is never diffed against the target type (ERR-095); **OR two sequential read-modify-writes target one persisted record and the second is built from a pre-first-write snapshot — a lost update erasing the first write's keys (ERR-095 recurrence PR #1551: the second diagnosticJson write re-parsed the stale ctx.task snapshot and erased output_failure_details)****; **OR a configured deadline is NOT the tightest timer on the wire — an implicit library default below the configuration surface (undici headersTimeout/bodyTimeout 300s, undici connectTimeout 10s, OpenAI SDK 600s, runner 300s) aborts the request first, with an abort-family error message that makes it look like the configured authority fired early (ERR-118)**.
- **Must check**: returned state is read from the canonical source after writes; lineage and evidence fields come from the same source; config resolver output is consumed by callers; **before adding a convenience reader for a persistent state file that already has a strict reader, grep for existing parse sites of the same file — a second, weaker schema beside the strict one drifts silently and its corruption errors leak bare SyntaxError or a misleading reason code (PR #1413: dual ActiveRecord readers; also map every corrupt-JSON read of required state to a typed error with nextAction)**; **when one resolved value (e.g. a port base from an env var) must drive multiple derived windows, derive every window from the single resolved constant — a hardcoded sibling constant drifts the moment the env var shifts (PR #1413: autolaunch base vs verification window)**; **module-level caches for per-input-derived values use `Map<string, T>` keyed by `path.resolve(input)`, not single-valued `let` slots that only track "last seen" input**; **envelope/annotation key merges check `Object.hasOwn(output, key)` first and skip-on-collision when the target schema is not owned by the writer**; **when a timeout is configured at layer N, enumerate every timer below N on the actual wire path and assert the configured deadline is the tightest — distinguishing fingerprint: death at exactly an implicit default with an abort-family message (transport layer) vs death at exactly the configured value with an "after Nms" message (budget layer) (ERR-118)**.
- **Representative ERRs**: ERR-004, ERR-008, ERR-034, archived-042, archived-049, archived-059, ERR-092, ERR-095, ERR-118.
- **Automation target**: mismatch tests where requested state differs from disk/canonical state; **static scan for `let cached` / `let last` at module scope where the cached value is derived from a function parameter — flag any that are single-valued instead of `Map`-keyed**; **1s-scale transport regression against a local slow-header server (capped Agent aborts at cap / production transport survives / outer AbortSignal still fires — `pi-ai-http-transport.test.ts`)**.

### EP-08 Security Boundary Placement

<!-- error-pattern-routing
{
  "id": "EP-08",
  "risk": "high",
  "pathSignals": [
    "security",
    "redact",
    "guard",
    "path",
    "shell"
  ],
  "diffSignals": [
    "redact",
    "execSync",
    "spawn(",
    "shell: true",
    "startsWith",
    "realpathSync",
    "statSync",
    "byteLength",
    "truncate",
    "MAX_",
    "length <= "
  ],
  "requiredEvidence": [
    "Enforcement operates on the raw/canonical input (post-transform output for bounds; canonical paths for containment).",
    "Shell args pass as argv, not interpolated strings; SQL binds values.",
    "Path containment canonicalizes BOTH sides before comparison.",
    "When content moves out of a bounded artifact, the bound keeps a numeric-bound assertion on what remains (not just warning emission)."
  ],
  "enforcement": "semantic"
}
-->

- **Use when**: adding redaction, command blocking, path handling, shell execution, security validators, prompt budget guards, or file size caps; **also when a refactor relocates content out of an artifact that carries size/validation bounds**.
- **Failure mode**: a security control is placed at the wrong layer, matches the wrong scope, is bypassed by interpolation/substrings, **applies its bound to the wrong input (raw vs. escaped, metadata vs. actual content, raw param path vs. canonical `normalizedPath`)**, or has a TOCTOU window between check and use; **OR a refactor moves content out of a bounded artifact and the bound's logic is mechanically re-pointed at the relocated content — the limit stops enforcing while still emitting its warnings (ERR-123)**.
- **Must check**: enforcement input is not prematurely redacted; persistence output is redacted; shell arguments are passed as argv; SQL chooses between complete static prepared statements and binds values only; path checks use segment boundaries; **size/budget bounds are applied to the POST-transform output (escaped/encoded), not the pre-transform input**; **when a diff moves a field out of a serialized/persisted artifact, re-derive the artifact's size/validation rules against what remains and require a numeric-bound assertion (`bounded.length <= limit`), not just a warning-emission assertion (ERR-123)**; **file size caps via statSync are re-verified with `Buffer.byteLength` after readFileSync**; **new logs that include external session/user/channel identifiers apply the surrounding file's established truncation or redaction convention before emission**; **path-containment comparisons between two independently sourced paths (env-supplied root vs payload-supplied candidate) canonicalize BOTH sides first, and on Windows via `fs.realpathSync.native` — the JS `realpathSync` preserves 8.3 short-name segments (`C:\\Users\\ADMINI~1\\...`), so a short-form env root vs a long-form payload path fails containment on machines where `os.tmpdir()` (or a host-propagated env var) is short-named (caught by the Codex Slice A real smoke 2026-08-29, not by temp-dir unit tests)**.
- **Representative ERRs**: ERR-024, ERR-030, ERR-045, archived-051, ERR-055, archived-056, archived-058, ERR-080, ERR-081, ERR-093, ERR-103, ERR-123.
- **Automation target**: tests for composite sensitive keys, value-based redaction, raw enforcement input, sibling path false positives, escape-then-truncate ordering, and post-read byte re-verification.

### EP-09 Test Reality Gap

<!-- error-pattern-routing
{
  "id": "EP-09",
  "risk": "high",
  "pathSignals": [
    "tests/",
    "test/",
    "__tests__",
    "e2e",
    "fixtures"
  ],
  "diffSignals": [
    "toContain(",
    "expect(source)",
    "readFileSync",
    "not.toThrow",
    "toBeUndefined",
    "process.platform",
    "process.arch",
    "skip",
    "head -",
    "tail -",
    "grep -m",
    "rg -m",
    "zero consumers",
    "RETIRE",
    "tombstone",
    "census"
  ],
  "requiredEvidence": [
    "A positive assertion uniquely identifies the intended execution path; indirect signals (undefined return, absence of error, zero count) are not the only proof.",
    "Regression tests for a fix include the negative control that fails against the pre-fix state.",
    "Tests exercise the production boundary (real parser/registration/route), not source-string scans.",
    "Every completeness claim in a deletion/cleanup/audit PR cites the FULL untruncated output of a re-runnable command; the owning lifecycle doc's state machine is followed as binding removal semantics; every DoD command was executed once with its real output in the PR (ERR-127)."
  ],
  "enforcement": "semantic"
}
-->

- **Use when**: changing tests, fixtures, baselines, smoke tests, database schemas, package installs, or UI route/action state; also when asserting indirect/non-unique signals (undefined return, timing metrics, absence of error, zero side-effect count).
- **Failure mode**: tests prove strings, helper behavior, or hand-written schemas instead of the real behavior users rely on; **OR the asserted signal is non-unique — a fail-soft / no-op / never-executed / cached-empty path also produces it, so the test passes on the unintended path without proving the claimed invariant (ERR-088)**; **OR a newly added conditional ships an alternate branch no production seam can reach — the new tests cover only the reachable side, codecov/patch fails on the dead alternate (ERR-099)**; **OR auth/splash/onboarding bootstrap renders a generic shell but overwrites the protected deep link the test and Owner actually requested (ERR-104)**; **OR implementation and tests are both written from a summarized spec interpretation, so they validate each other while both drift from the normative clauses — precedence orders and evidence requirements degrade to what the summary remembered (ERR-108)**; **OR an identity/route matcher extracted from legacy prefix code (`startsWith`) keeps the prefix form, so adjacent-but-different routes (`#/login` vs `#/login-help`) silently inherit the exemption and strand the user exactly where the fix promised not to (ERR-119)**; **OR a fixture declares platform-keyed data (platform/arch/node ABI) with hardcoded values while the code under test selects by `process.*` — green on the author's machine, fails in CI at an earlier step with a different refusal reason (ERR-121)**; **OR a benchmark/evaluation fixture deploy ships lab-side docs, packaging manifests, or tutorial-style verifier comments into the subject's workspace — the answer surface is the DEPLOYED FILE LIST, not repo-side intent, and hint leakage measures recall instead of the target behavior (ERR-122)**.
- **Must check**: fixtures match production schema; tests fail if expected output is absent; package tests are run when package code changes; UI tests verify route/action contracts, not just source substrings; generated media dimensions and formats are read from the final file metadata, not inferred from viewport or render settings; **for any test asserting an indirect signal (undefined return, timing, absence of error, zero count), enumerate all code paths that produce the same signal — if a fail-soft / no-op / never-executed path is among them, add a positive assertion (status field, probe rule with unique reason, side-effect with distinguishing payload) that uniquely identifies the intended path**; **for every new conditional in a diff, name the production seam that makes EACH side true — if none exists for one side, restructure branch-free (join/fold degrading to the legacy format) or add a test for that branch before pushing (ERR-099)**; **a regression test that proves a fix must ship with its NEGATIVE CONTROL — the same probe/assertion run against the pre-fix state must fail; without it the positive test can pass vacuously once the probe stops exercising the claimed mechanism (PRI-561 follow-up: the ERR_MODULE_NOT_FOUND negative control committed beside the host-runtime resolution probe caught two parser bugs in the delivery-parity contract test during its own development — bite-verify every contract test before trusting green)**; **for specs with numbered normative clauses, walk each ordering/forbidden-inference/evidence sentence against the final diff during self-review and name the test locking it — rewrite any test that only asserts the implementation's own output shape (ERR-108)**; **for every contract claim in a diff defined over an identity (owner/key/actor — renew/idempotent-retry/resume), run the DEFAULT identity path once in a test, not only explicit parameters — execute the documented quick-start command verbatim twice and require the documented non-conflicting behavior on the second run (ERR-116)**; **when extracting a legacy conditional into a named matcher/predicate, re-derive its semantics from the authoritative identity registry (registered routes, enum members, ID spaces) instead of carrying the form over — prefix/equality choice must be justified against near-miss identities, with a negative test proving a prefix-sharing but non-identical value does NOT match (ERR-119)**; **when a ReDoS/security flag is fixed by removing one cited trigger, enumerate the remaining backtracking contributors of the flag before declaring closure — prefer replacing the whole regex with a linear implementation when input is untrusted, prove equivalence with an old-vs-new battery, and treat "the alert closes post-merge" as acceptance evidence that must be re-checked during closeout (ERR-120)**; **for any test whose code under test reads `process.platform|arch|versions.*`, check the fixture data it feeds declares those keys hardcoded — derive them from `process.*`, and when the trap is fixed in one fixture, fix every sibling fixture feeding the same module in the same commit (ERR-121)**; **for any test that mutates a process-global singleton (`process.platform` / `process.env` / prototype patches), require save-original + `try/finally` restore — a mid-test assertion failure must not leak the mutated state into sibling tests (ERR-124)**. **for deletion/cleanup/audit PRs, every completeness claim ("zero consumers", "condition met", "only these files") must cite the FULL untruncated output of a re-runnable command, the owning lifecycle doc's state machine must be followed as binding semantics, and every DoD command must be executed once with its real output pasted into the PR (ERR-127)**.
- **Representative ERRs**: ERR-025, ERR-040, ERR-073, ERR-077, ERR-088, ERR-094, ERR-099, ERR-104, ERR-108, ERR-115, ERR-116, ERR-117, ERR-119, ERR-120, ERR-121, ERR-122, ERR-125, ERR-127.
- **Automation target**: production schema fixtures and real-path smoke tests; **static scan for assertions on `undefined` returns, timing-only assertions, and `not.toThrow()` without subsequent positive assertions — flag any that lack a companion assertion uniquely identifying the intended execution path**; **static scan for `expect(... >= ... || ... <= ...).toBe(true)` and similar `||`-joined range bounds in tests — these are tautologies when `low <= high` and must use `&&` (ERR-094)**; review checklist: for each new regression test in a diff, ask what specifically fails if the mechanism under test regresses — if the answer is "nothing else in the suite", require the pre-fix-state negative control in the same PR. **Root-cause claims about module interfaces must not rest on static text scans: rg/regex/`includes()` symbol searches are ALL blind to `export *` re-export chains — verify with a REAL Node import (scratch-process dynamic import) and first confirm WHICH physical copy Node actually resolves (nearest `node_modules` wins) before blaming the package. Multiple checks sharing one blind spot are not independent evidence (2026-09-04 PRI-665 misdiagnosis: three text-level checks converged on a nonexistent barrel defect while the real cause was stale physical dependency copies shadowing the canonical package).**

### EP-10 Workflow and Branch Hygiene

<!-- error-pattern-routing
{
  "id": "EP-10",
  "risk": "medium",
  "pathSignals": [
    "scripts/dev",
    ".github/workflows"
  ],
  "diffSignals": [
    "worktree",
    "cherry-pick",
    "rebase",
    "Remove-Item",
    "rm -rf",
    "git clean",
    "pre-existing",
    "stash"
  ],
  "requiredEvidence": [
    "Any 'pre-existing on main' CI-failure claim is reproduced on origin/main or proven unreachable from changed files.",
    "Deletion-capable cleanup commands over junction/symlink trees are junction-safe (git worktree remove / reparse-point check).",
    "PR diff scope matches the stated task; commit list inspected before cherry-pick."
  ],
  "enforcement": "semantic"
}
-->

- **Use when**: reviewing/fixing PRs, cherry-picking, recording errors, or working on stacked branches.
- **Failure mode**: comments are missed, stale main rolls back merged code, unrelated commits contaminate a PR, **or a PR body self-reports a CI failure as "pre-existing/unrelated/flaky" without verifying it against the base branch (ERR-078)** — the false classification then ships a real regression under a false exoneration.
- **Must check**: fetch PR reviews/comments with retries; inspect source branch commit list before cherry-pick; compare diff scope against target branch; **for any "pre-existing on main" claim in a PR body, reproduce the failing test on `origin/main` (or prove the changed files can't reach the failing code) before accepting the claim — flag-flips that change `DEFAULT_FEATURE_FLAGS` defaults re-route execution paths in mocked tests**; **before any deletion-capable cleanup command (`Remove-Item -Recurse`, `rm -rf`, `git clean -fdx`) on a directory that may contain junctions/symlinks into a shared repo, use `git worktree remove` or verify the target has no reparse points — PowerShell 7's recursive delete follows junctions (ERR-098)**.
- **Representative ERRs**: ERR-012, ERR-032, ERR-052, ERR-078.
- **Automation target**: PR pre-review checklist and `git log main..source-branch` before cherry-pick; reviewer check that reproduces each "pre-existing" failure claim against the merge-base.

### EP-11 i18n and Accessibility String Consistency

<!-- error-pattern-routing
{
  "id": "EP-11",
  "risk": "low",
  "pathSignals": [
    "i18n",
    "locales",
    "ui/"
  ],
  "diffSignals": [
    "aria-label",
    "placeholder=\"",
    "title=\"",
    "useTranslation",
    "t('"
  ],
  "requiredEvidence": [
    "Every new user-facing string in an i18n-enabled component routes through t() with a key present in all locale files."
  ],
  "enforcement": "advisory"
}
-->

- **Use when**: adding any user-facing string (visible text, `aria-label`, `title`, `placeholder`, `alt`) in a component that already uses an i18n translation function (`t()`, `useTranslation`, `i18next`).
- **Failure mode**: new strings are hardcoded in the source language (usually English) while the rest of the component routes text through `t()`, causing screen readers, tooltips, and visible text to read in a different language than the active UI locale.
- **Must check**: every new string attribute in an i18n-enabled component uses `t()` with a translation key; corresponding keys are added to all locale files (`en.json`, `zh-CN.json`, etc.); interpolation parameters (e.g. `{{count}}`) are passed through `t()` options.
- **Representative ERRs**: ERR-075.
- **Automation target**: grep for `aria-label={`, `aria-label="`, `title="`, `placeholder="` in `.tsx` files that import `useTranslation`/`t()`; any match not using `t(...)` is a finding.

### EP-12 Host Environment Contract

<!-- error-pattern-routing
{
  "id": "EP-12",
  "risk": "medium",
  "pathSignals": [
    "create-principles-disciple",
    "openclaw-plugin",
    "extensions/",
    "plugin-skills"
  ],
  "diffSignals": [
    "plugins.allow",
    "skills",
    "manifest",
    "extensions/",
    "hooks",
    "commands"
  ],
  "requiredEvidence": [
    "Every write into host-managed paths/keys cites the host rule that interprets it (discovery scan, publication uniqueness, allowlist gate).",
    "PD-owned data lives outside discovery roots; shared host collections stay append-only."
  ],
  "enforcement": "semantic"
}
-->

- **Use when**: placing files under host-managed directories (`~/.openclaw/extensions`, `~/.openclaw/plugin-skills`, workspace `skills/`), writing host config keys (`openclaw.json` `plugins.*`, `skills.*`), or declaring manifest arrays OpenClaw consumes (`skills`, `commands`, hooks) — in pd-console, create-principles-disciple, or openclaw-plugin packaging.
- **Failure mode**: PD treats its writes as inert data, but the host actively interprets them: backup dirs inside extensions/ are re-discovered as duplicate plugins; same-named skill roots across languages silently collapse to the first; a created `plugins.allow` silently disables every discovered plugin not on it.
- **Must check**: cite the host rule that interprets the path/key (discovery scan + ignore-name conventions, publication-by-name uniqueness, allowlist hard gate that `entries.enabled` does NOT bypass) in the PR description; place PD-owned data outside discovery roots (`pd-backups`); shared host collections are append-only; manifest declares exactly one skills root with unique skill names.
- **Representative ERRs**: ERR-097.
- **Automation target**: manifest invariant test (single skills root, no cross-root name collisions); repo grep for writes creating directories under `extensions/` outside install/update flows.

### EP-13 Theme Token Consistency

<!-- error-pattern-routing
{
  "id": "EP-13",
  "risk": "low",
  "pathSignals": [
    "pd-console/src/ui",
    "pd-companion/src/ui",
    "globals.css",
    "src/renderer",
    "components/"
  ],
  "diffSignals": [
    "#[0-9a-fA-F]",
    "rgb(",
    "style={{",
    "data-theme"
  ],
  "requiredEvidence": [
    "New visual styling uses theme tokens/CSS variables instead of raw hex/rgb literals that encode one theme's values."
  ],
  "enforcement": "advisory"
}
-->

- **Use when**: adding or changing visual styling (colors, shadows, radii) in packages with themed surfaces — pd-console (`[data-theme="dark"]` in `globals.css`) and Companion.
- **Failure mode**: raw hex/rgb literals encode one theme's values; when the theme flips, elements render with wrong or low-contrast styling (e.g., light-mode navy timeline dots nearly invisible in dark mode), and inline styles escape Tailwind's class pipeline entirely.
- **Must check**: new styles use token utilities (`bg-gov`, `text-danger`) or CSS variables; grep the diff for `#[0-9a-fA-F]{3,8}` / `rgb(` inside `.tsx` style props of themed packages; verify built CSS contains any newly referenced utility classes.
- **Representative ERRs**: ERR-105.
- **Automation target**: static scan for hex/rgb literals in style props under themed package UI directories.

## Maintenance Rules

- Every ERR in a pattern card must exist in `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md`.
- Every detailed ERR must be mapped to at least one pattern card. If an error is genuinely novel, add a new EP card before recording the ERR.
- Prefer updating a pattern card or Recurrence field over adding a new top-level error class for the same root cause.
- Run `npm run check:error-handbook` after editing this file or the handbook.

## Routing Metadata

Each pattern card carries an `error-pattern-routing` HTML-comment JSON block. This metadata lives in this file (the pattern semantic SSoT) — there is no separate patterns database. `npm run error:context` consumes it deterministically to surface relevant patterns before/during a task; it supplements agent judgment and never replaces reading this index. Schema: `id`, `risk` (high|medium|low), `pathSignals[]`, `diffSignals[]`, `requiredEvidence[]`, `enforcement` (blocking|advisory|semantic|mixed). `npm run check:error-handbook` validates the block's syntax, enum values, and heading/ID consistency.
