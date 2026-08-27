# Anonymous Product Telemetry v1 — Maintainer Documentation

> Decision record: [ADR-0021](../adr/0021-anonymous-product-telemetry.md). Feasibility verification: [Phase 0 report](../audit/anonymous-product-telemetry-feasibility.md).
> Principle: **Collect signals, not users.** · Measurement honesty: **Unknown ≠ false.**

## 1. Architecture

```
Authoritative PD Local Facts (per workspace, read-only, tri-state)
        │  host-runtime product-telemetry readers
        ▼
Daily Snapshot (ProductTelemetrySnapshotV1, 8 fields, ~400 bytes)
        │  + dailyTelemetryId = HMAC(localSecret, "daily-workspace:" + workspaceScopeId + ":" + date)
        ▼
Gates: feature flag (workspace .pd/config.yaml, quiet, default off)
     ∧ explicit consent (~/.pd/product-telemetry.json, machine scope)
     ∧ environment not suppressed
        │  async fire-and-forget POST (8s timeout, bounded backoff, per-workspace lock)
        ▼
Cloudflare Pages Function  POST /api/product-telemetry/snapshot
        │  strict schema → abuse limit (keyed transport token) → KV rate limit (daily ID)
        │  → serverDailyId = HMAC(serverSecret, clientDailyId)
        ▼
D1 product_telemetry_daily  (PK (server_daily_id, bucket_date); 90-day retention:
                             scheduled cleanup endpoint + write-time sweep, same policy)
        ▼
Protected maintainer view   GET /product-signals (Bearer PRODUCT_SIGNALS_TOKEN)
```

Code map:

| Concern | Location |
|---|---|
| Pure contract (schema, daily ID, privacy guard) | `packages/principles-core/src/runtime-v2/product-telemetry/` |
| I/O (consent store, workspace scope, readers, eligibility, exporter, service) | `packages/host-runtime/src/product-telemetry/` |
| CLI control plane | `packages/pd-cli/src/commands/telemetry.ts` |
| Export triggers | `packages/openclaw-plugin/src/index.ts` (one-time workspace init), `packages/pd-console/src/server/index.ts` (startup) |
| Collector + cleanup + view | `packages/website/functions/api/product-telemetry/`, `functions/_lib/telemetry-core.ts`, `functions/_lib/telemetry-cleanup-core.ts`, `functions/_lib/product-signals-core.ts`, `functions/product-signals.ts` |
| D1 schema | `packages/website/migrations/` (0001 + 0002 — nullable tri-state columns) |
| Scheduled retention | `.github/workflows/telemetry-retention.yml` |

### Scope model (review remediation)

**Telemetry Unit = the workspace.** Consent, consentVersion, and the telemetry secret are **machine-scope** (`~/.pd/product-telemetry.json`, schema v2). The daily identity, dedup, retry/backoff, attempt caps, and the export lock are **workspace-scope**, keyed by an opaque local `workspaceScopeId = HMAC(secret, "workspace:" + canonicalWorkspacePath)` (canonical = resolve + realpath + separator/case normalization; equivalent Windows spellings collapse to one scope; a moved/renamed workspace deliberately becomes a new scope). The scope ID never leaves the machine — not in snapshots, not in lock filenames that reveal paths, not anywhere server-side. All maintainer-facing wording: "participating workspaces" / "daily-workspace observations".

## 2. Telemetry Schema Inventory (complete — no field exists without a row here)

| Field | Type | Source | Purpose | Privacy class |
|---|---|---|---|---|
| `schemaVersion` | `'1'` | constant | protocol evolution safety | non-content |
| `dailyTelemetryId` | 32 hex chars | `HMAC-SHA256(localSecret, "daily-workspace:" + workspaceScopeId + ":" + bucketDate)` truncated | same-day dedup only; cross-day AND cross-workspace unlinkable by construction | pseudonymous, daily-rotating |
| `bucketDate` | `YYYY-MM-DD` (UTC) | client clock | date bucket for daily aggregation | coarse time (day) |
| `pdVersion` | string ≤32 | installed `principles-disciple` package version | release adoption / old-version persistence | non-content |
| `hostKind` | `openclaw` \| `codex` \| `other` | `~/.pd/install.json` hosts[] | per-host product reach | coarse enum |
| `milestones.initialized` | boolean \| null | state.db `schema_version` populated | Q1: is PD actually initialized | boolean |
| `milestones.painObserved` | boolean \| null | trajectory.db `pain_events` EXISTS | Q2: value-path reach | boolean |
| `milestones.principleObserved` | boolean \| null | state.db `principle_candidates` EXISTS (authority) OR principle ledger non-empty (fallback) | Q2 | boolean |
| `milestones.activationObserved` | boolean \| null | state.db `activations` EXISTS | Q2 | boolean |
| `milestones.presenceReceiptObserved` | boolean \| null | state.db `principle_applications` level='presence' EXISTS | Q2 (presence ≠ behavior change) | boolean |
| `milestones.effectReceiptObserved` | boolean \| null | state.db `principle_applications` level='effect' EXISTS | Q2 (effect ≠ durable improvement) | boolean |
| `reliability.initializationFailed` | boolean \| null | readable state.db whose schema is DEFINITIVELY not initialized | Q4: coarse release health | boolean |
| `consentVersion` | string ≤8 | constant `'1'` | consent-text evolution tracking | non-content |

**NULL semantics (review remediation, "Unknown ≠ false")**: `null` = the milestone's source was not evaluable at read time (DB exists but unreadable, required table missing in an old schema, receipt collection flag disabled). NULL is stored as SQL NULL, excluded from dashboard denominators, and never summed as 0. `false` is reserved for *evaluated* absence (e.g. the DB file does not exist at all, or the query ran and found nothing).

Server-side only: `serverDailyId` = `HMAC-SHA256(TELEMETRY_HMAC_SECRET, dailyTelemetryId)` (the client ID is never stored raw), `created_at`/`updated_at` (write timestamps).

### Never collected (enforced by schema + privacy guard tests)

Conversations, prompts, Agent responses, Principle content, Pain content, source code, repository names/remotes, workspace/file paths, filenames, tool arguments/outputs, raw logs, stack traces, error messages, usernames, emails, hostnames, device fingerprints, geolocation, raw IPs in telemetry storage, arbitrary metadata, exact counts of anything, persistent/cross-day identifiers, persistent workspace or installation identifiers.

The privacy guard (`PROHIBITED_TELEMETRY_FIELD_TOKENS` + `assertTelemetrySchemaPrivacy`) fails tests if a schema field name ever matches a content-bearing concept. The collector's allowlist is drift-locked against the core builder via shared test vectors.

## 3. Authority matrix & milestone semantics (tri-state)

| Milestone | Durable authority | Semantics |
|---|---|---|
| initialized | `<ws>/.pd/state.db` + populated `schema_version` | PD reached effective runtime state (uniform for both hosts). Missing DB = definitive false; unreadable = null. |
| painObserved | trajectory.db `pain_events` | ≥1 admitted, canonical-deduped pain (failed pains live in `dead_letter_pains`, excluded). Missing file = false; unreadable/table-missing = null. |
| principleObserved | `principle_candidates` ∪ principle ledger (two evidence populations, three-valued OR) | Either source observing evidence → true; false only when BOTH populations are definitively empty; any unknown population without observed evidence → null (Kleene OR — an evaluated-empty source cannot resolve another source's unknown; the ledger is preflight-checked because loadLedger is fail-soft). |
| activationObserved | `activations` | ≥1 durable activation fact ever |
| presenceReceiptObserved | `principle_applications` level='presence' | ≥1 presence receipt (principle entered an Agent context) — **presence ≠ behavior change** |
| effectReceiptObserved | `principle_applications` level='effect' | ≥1 effect receipt (`rule_blocked` / `auto_correct_applied` / `self_reported`, aggregated without self-report breakdown) — **effect ≠ durable improvement** |
| initializationFailed | readable state.db, schema definitively absent | True ONLY from a readable DB whose schema is definitively not initialized. Missing DB → false (never ran). Unreadable/unevaluable → **null** — a read failure must never fabricate release-health signal. |

Receipt gating: when the `principle_receipt_ledger` flag is disabled, no receipt rows are written, so "no rows" proves nothing — presence/effect receipt milestones render `null` (unavailable), not false. The `principle_receipt_self_report` sub-flag does NOT gate the milestones (other capture paths still write the ledger).

Receipt facts are 90-day-window observed evidence (PRI-590 semantics), never complete history.

## 4. Suppression & eligibility

`canExport = flag ∧ consent ∧ ¬suppressed`. Suppression reasons (each named in `pd telemetry status`): `env_kill_switch` (`PD_TELEMETRY_DISABLED` ∈ {1,true}), `ci_environment` (CI), `vitest_environment` (VITEST), `e2e_mode` (PD_E2E_MODE=1), `workspace_environment` ({test,demo,development}), `install_layout_missing`, `repo_checkout` (executing module inside a PD monorepo checkout — build-layout fact, not a path heuristic).

Export policy (per workspace): ≤1 successful snapshot/workspace/day (client-side same-day skip + server-side upsert dedup + per-workspace export lock closing the multi-process race — workspace A's lock never blocks workspace B). Failed attempts are hard-capped at **5 per UTC day per workspace** (`dailyAttemptCount`/`attemptBucketDate` in that workspace's control-state entry; backoff 1h then 6h — the worst-case timeline 0h/1h/7h/13h/19h is bounded by the counter, independent of clock skew). Failures are recorded as coarse codes only (`timeout`, `network_error`, `http_400`, `http_429`, `http_5xx`, `http_unexpected_status`, `invalid_response`); a success clears the counter. Workspace bookkeeping entries untouched for 30 days are pruned on write (bounded local operational state).

Control-state migration: v1 (machine-global export bookkeeping) files are migrated on read — consent, consentVersion, and the secret are preserved; legacy export bookkeeping is discarded (it cannot be attributed to a workspace, and it is operational state, not a governance fact).

## 5. Cloudflare deployment

Project `principles-website` (existing). Binding: `[[d1_databases]] PD_PRODUCT_TELEMETRY → pd-product-telemetry` (id `c96b7ef1-f6f4-43b0-bce7-9c12881d6b21`, APAC). Migrations: `packages/website/migrations/` (`wrangler d1 migrations apply pd-product-telemetry --remote`; 0002 rebuilds the table with nullable tri-state columns). KV rate limiting reuses `FEEDBACK_KV` with `tl-rl:` (layer 1, 60/hour/daily-ID) and `tl-ab:` (layer 2, 120/hour/keyed-IP-token) prefixes. **KV limits are best-effort, not strict**: the get→put counters are not atomic (same trade-off as the feedback relay). Strict limiting would need a D1 counter table or Durable Objects; zone-level Cloudflare WAF rate limiting is the recommended optional hardening for flood resistance beyond the Worker tier.

Secrets (wrangler pages secret put … --project-name=principles-website):

| Secret | Floor | Purpose |
|---|---|---|
| `TELEMETRY_HMAC_SECRET` | ≥32 bytes as hex (64+ chars), fail-closed 500 | server-side daily-ID protection |
| `TELEMETRY_ABUSE_HMAC_SECRET` | ≥32 bytes as hex (64+ chars), fail-closed 500 | keyed transport abuse tokens (domain-separated, independent) |
| `PRODUCT_SIGNALS_TOKEN` | ≥24 bytes as hex (48+ chars) | maintainer view Bearer (constant-time compare) |
| `PRODUCT_TELEMETRY_CLEANUP_TOKEN` | ≥24 bytes as hex (48+ chars) | retention cleanup endpoint Bearer (constant-time compare; independent of the signals token) |

GitHub repository secret: `PRODUCT_TELEMETRY_CLEANUP_TOKEN` (used by `.github/workflows/telemetry-retention.yml`; never in yaml/docs/fixtures).

Retention: **90 days**, one policy computation (`retentionCutoffDate` in telemetry-core.ts) shared by both paths — (1) scheduled daily `POST /api/product-telemetry/cleanup` from the GitHub workflow (fails the workflow on non-2xx or non-`ok:true`), and (2) the opportunistic write-time sweep after each accepted snapshot. Cleanup runs with zero new writes. Local development: `packages/website/.dev.vars` (gitignored), `wrangler d1 migrations apply pd-product-telemetry --local` after starting `wrangler pages dev`.

## 6. Metric semantics & caveats (part of the metric contract)

- Figures are **opt-in samples of participating workspaces** — never a population estimate, never "installations" or "users". The view permanently displays this warning.
- **Signals are forgeable**: the collector is an anonymous public endpoint by design — anyone can POST well-formed snapshots (fake versions/milestones). The two-layer rate limiting bounds transport abuse (random daily-ID rotation cannot bypass the keyed-IP token), but nothing here proves origin. Treat all figures as **accepted anonymous submissions — directional opt-in signals, not authenticated measurements**.
- Workspaces ≠ users. 7-day sums are "daily-workspace observations" (cross-day dedup is intentionally impossible — never present them as unique workspaces).
- NULL facts are excluded from denominators: each milestone shows Observed / Evaluable / Unavailable. Unknown ≠ false; unknown ≠ zero.
- "Effect receipt observed" is NOT "Agent improved" — it proves one governance mechanism affected one execution.
- ClawHub download counts are an external distribution metric; combining them with telemetry into a conversion rate is forbidden.
- Codex-only installations without console/Companion activity are invisible to telemetry (subprocess hooks cannot host async export) — an accepted, documented bias.
- Measurement non-goals: DAU/MAU, retention/churn, LTV, engagement, session duration, cohorts, geography, device profiles, per-workspace timelines, causal attribution.

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| No snapshots arriving | `pd telemetry status` (blockers list) → flag on? consent granted? environment suppressed? |
| 500 `collector_misconfigured` | `TELEMETRY_HMAC_SECRET` / `TELEMETRY_ABUSE_HMAC_SECRET` missing/short on Pages |
| 500 `storage_unavailable` | D1 binding/migration state: `wrangler d1 migrations apply pd-product-telemetry --remote` (both 0001+0002) |
| 429 bursts | layer 1 = 60/hour/daily-ID; layer 2 = 120/hour/source-network — client backoff handles this; check client `lastFailureCode` |
| View 401 | wrong/absent `PRODUCT_SIGNALS_TOKEN` Bearer header |
| Cleanup endpoint 401/500 | wrong `PRODUCT_TELEMETRY_CLEANUP_TOKEN`; check the Telemetry Retention Cleanup workflow run |
| Verify stored rows | `wrangler d1 execute pd-product-telemetry --remote --command "SELECT bucket_date, COUNT(*) FROM product_telemetry_daily GROUP BY bucket_date"` |

## 8. Validation harnesses (reusable)

- Collector E2E: `node scripts/telemetry-e2e-validate.mjs --endpoint <url> [--signals-token <t>]` (14+5 checks incl. dedup, rejections, view protection/content/wording).
- Production-equivalent client loop (isolated canonical install, real network): `node scripts/telemetry-production-smoke.mjs --endpoint <url>` then run the printed RUNNER script.
- Retention live check: `workflow_dispatch` the Telemetry Retention Cleanup workflow, or POST the cleanup endpoint manually with the token; verify `deleted`/`cutoff` in the response.
