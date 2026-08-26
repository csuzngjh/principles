# Anonymous Product Telemetry v1 — Maintainer Documentation

> Decision record: [ADR-0021](../adr/0021-anonymous-product-telemetry.md). Feasibility verification: [Phase 0 report](../audit/anonymous-product-telemetry-feasibility.md).
> Principle: **Collect signals, not users.**

## 1. Architecture

```
Authoritative PD Local Facts (per workspace, read-only)
        │  host-runtime product-telemetry readers
        ▼
Boolean Daily Snapshot (ProductTelemetrySnapshotV1, 8 fields, ~400 bytes)
        │  + dailyTelemetryId = HMAC(localSecret, UTC-date)
        ▼
Gates: feature flag (workspace .pd/config.yaml, quiet, default off)
     ∧ explicit consent (~/.pd/product-telemetry.json)
     ∧ environment not suppressed
        │  async fire-and-forget POST (8s timeout, bounded backoff)
        ▼
Cloudflare Pages Function  POST /api/product-telemetry/snapshot
        │  strict schema → KV rate limit → serverDailyId = HMAC(serverSecret, clientDailyId)
        ▼
D1 product_telemetry_daily  (PK (server_daily_id, bucket_date); 90-day retention sweep on write)
        ▼
Protected maintainer view   GET /product-signals (Bearer PRODUCT_SIGNALS_TOKEN)
```

Code map:

| Concern | Location |
|---|---|
| Pure contract (schema, daily ID, privacy guard) | `packages/principles-core/src/runtime-v2/product-telemetry/` |
| I/O (consent store, readers, eligibility, exporter, service) | `packages/host-runtime/src/product-telemetry/` |
| CLI control plane | `packages/pd-cli/src/commands/telemetry.ts` |
| Export triggers | `packages/openclaw-plugin/src/index.ts` (one-time workspace init), `packages/pd-console/src/server/index.ts` (startup) |
| Collector + view | `packages/website/functions/api/product-telemetry/`, `functions/_lib/telemetry-core.ts`, `functions/_lib/product-signals-core.ts`, `functions/product-signals.ts` |
| D1 schema | `packages/website/migrations/0001_product_telemetry_daily.sql` |

Telemetry Unit = **the PD installation** (`~/.pd` boundary). The daily snapshot is derived from the installation's active workspace. All maintainer-facing wording: "participating installations".

## 2. Telemetry Schema Inventory (complete — no field exists without a row here)

| Field | Type | Source | Purpose | Privacy class |
|---|---|---|---|---|
| `schemaVersion` | `'1'` | constant | protocol evolution safety | non-content |
| `dailyTelemetryId` | 32 hex chars | `HMAC-SHA256(localSecret, bucketDate)` truncated | same-day dedup only; cross-day unlinkable by construction | pseudonymous, daily-rotating |
| `bucketDate` | `YYYY-MM-DD` (UTC) | client clock | date bucket for daily aggregation | coarse time (day) |
| `pdVersion` | string ≤32 | installed `principles-disciple` package version | release adoption / old-version persistence | non-content |
| `hostKind` | `openclaw` \| `codex` \| `other` | `~/.pd/install.json` hosts[] | per-host product reach | coarse enum |
| `milestones.initialized` | boolean | state.db `schema_version` populated | Q1: is PD actually initialized | boolean |
| `milestones.painObserved` | boolean | trajectory.db `pain_events` EXISTS | Q2: value-path reach | boolean |
| `milestones.principleObserved` | boolean | principle tree ledger OR state.db `principle_candidates` EXISTS | Q2 | boolean |
| `milestones.activationObserved` | boolean | state.db `activations` EXISTS | Q2 | boolean |
| `milestones.presenceReceiptObserved` | boolean | state.db `principle_applications` level='presence' EXISTS | Q2 (presence ≠ behavior change) | boolean |
| `milestones.effectReceiptObserved` | boolean | state.db `principle_applications` level='effect' EXISTS | Q2 (effect ≠ durable improvement) | boolean |
| `reliability.initializationFailed` | boolean | state.db exists but schema not initialized | Q4: coarse release health | boolean |
| `consentVersion` | string ≤8 | constant `'1'` | consent-text evolution tracking | non-content |

Server-side only: `serverDailyId` = `HMAC-SHA256(TELEMETRY_HMAC_SECRET, dailyTelemetryId)` (the client ID is never stored raw), `created_at`/`updated_at` (write timestamps).

### Never collected (enforced by schema + privacy guard tests)

Conversations, prompts, Agent responses, Principle content, Pain content, source code, repository names/remotes, workspace/file paths, filenames, tool arguments/outputs, raw logs, stack traces, error messages, usernames, emails, hostnames, device fingerprints, geolocation, IPs (never read by the collector), arbitrary metadata, exact counts of anything, persistent/cross-day identifiers.

The privacy guard (`PROHIBITED_TELEMETRY_FIELD_TOKENS` + `assertTelemetrySchemaPrivacy`) fails tests if a schema field name ever matches a content-bearing concept. The collector's allowlist is drift-locked against the core builder via shared test vectors.

## 3. Authority matrix & milestone semantics

| Milestone | Durable authority | Semantics |
|---|---|---|
| initialized | `<ws>/.pd/state.db` + populated `schema_version` | PD reached effective runtime state (uniform for both hosts) |
| painObserved | trajectory.db `pain_events` | ≥1 admitted, canonical-deduped pain (failed pains live in `dead_letter_pains`, excluded) |
| principleObserved | principle ledger / `principle_candidates` | ≥1 principle or pipeline candidate exists (any status) |
| activationObserved | `activations` | ≥1 durable activation fact ever |
| presenceReceiptObserved | `principle_applications` level='presence' | ≥1 presence receipt (principle entered an Agent context) — **presence ≠ behavior change** |
| effectReceiptObserved | `principle_applications` level='effect' | ≥1 effect receipt (`rule_blocked` / `auto_correct_applied` / `self_reported`, aggregated without self-report breakdown) — **effect ≠ durable improvement** |

Conservative-boolean rule: missing/unreadable/disabled sources render `false` (never overclaim), recorded in local-only notes. Receipt facts are 90-day-window observed evidence (PRI-590 semantics), never complete history.

## 4. Suppression & eligibility

`canExport = flag ∧ consent ∧ ¬suppressed`. Suppression reasons (each named in `pd telemetry status`): `env_kill_switch` (`PD_TELEMETRY_DISABLED` ∈ {1,true}), `ci_environment` (CI), `vitest_environment` (VITEST), `e2e_mode` (PD_E2E_MODE=1), `workspace_environment` ({test,demo,development}), `install_layout_missing`, `repo_checkout` (executing module inside a PD monorepo checkout — build-layout fact, not a path heuristic).

Export policy: ≤1 successful snapshot/installation/day (client-side same-day skip + server-side upsert dedup + machine-scope export lock closing the multi-process race). Failed attempts are hard-capped at **5 per UTC day** (`dailyAttemptCount`/`attemptBucketDate` in the control state; backoff 1h then 6h — the worst-case timeline 0h/1h/7h/13h/19h is bounded by the counter, independent of clock skew). Failures are recorded as coarse codes only (`timeout`, `network_error`, `http_400`, `http_429`, `http_5xx`, `http_unexpected_status`, `invalid_response`); a success clears the counter.

## 5. Cloudflare deployment

Project `principles-website` (existing). Binding added: `[[d1_databases]] PD_PRODUCT_TELEMETRY → pd-product-telemetry` (id `c96b7ef1-f6f4-43b0-bce7-9c12881d6b21`, APAC). Migrations: `packages/website/migrations/` (`wrangler d1 migrations apply pd-product-telemetry --remote`). KV rate limiting reuses `FEEDBACK_KV` with `tl-rl:` prefix (60/hour/daily-ID). **KV limits are best-effort, not strict**: the get→put counter is not atomic (concurrent requests can undercount; same trade-off as the feedback relay). Strict per-ID limiting would need a D1 counter table or Durable Objects — acceptable to add later if abuse is observed.

Secrets (already set, production): `TELEMETRY_HMAC_SECRET` (server-side ID protection; **enforced format: ≥32 bytes as hex, i.e. 64+ hex chars — anything else fails closed with 500**), `PRODUCT_SIGNALS_TOKEN` (maintainer view Bearer token; **enforced format: ≥24 bytes as hex, i.e. 48+ hex chars**; compared in constant time). Rotate: `wrangler pages secret put <NAME> --project-name=principles-website`.

Retention: 90 days, enforced by an indexed `DELETE` sweep after each accepted write (**best-effort write-time cleanup** — Pages Functions have no cron; if a sweep hiccups, the accepted snapshot stays accepted and stale rows are reclaimed by the next successful write). Local development: `packages/website/.dev.vars` (gitignored; see `.gitignore`), `wrangler d1 migrations apply pd-product-telemetry --local` after starting `wrangler pages dev`.

## 6. Metric semantics & caveats (part of the metric contract)

- Figures are **opt-in samples of participating installations** — never a population estimate. The view permanently displays this warning.
- **Signals are forgeable**: the collector is an anonymous public endpoint by design — anyone can POST well-formed snapshots (fake versions/milestones). Schema strictness, size caps, rate limits, and the server-side HMAC bound storage and abuse, but cannot prove origin. Treat all figures as **directional opt-in signals, not authenticated measurements**.
- Telemetry units ≠ users. 7-day sums are "daily-unit observations" (cross-day dedup is intentionally impossible).
- "Effect receipt observed" is NOT "Agent improved" — it proves one governance mechanism affected one execution.
- ClawHub download counts are an external distribution metric; combining them with telemetry into a conversion rate is forbidden.
- Codex-only installations without console/Companion activity are invisible to telemetry (subprocess hooks cannot host async export) — an accepted, documented bias.
- Measurement non-goals: DAU/MAU, retention/churn, LTV, engagement, session duration, cohorts, geography, device profiles, per-unit timelines, causal attribution.

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| No snapshots arriving | `pd telemetry status` (blockers list) → flag on? consent granted? environment suppressed? |
| 500 `collector_misconfigured` | `TELEMETRY_HMAC_SECRET` missing/short on Pages |
| 500 `storage_unavailable` | D1 binding/migration state: `wrangler d1 migrations apply pd-product-telemetry --remote` |
| 429 bursts | rate limit is 60/hour/daily-ID; client backoff handles this — check client `lastFailureCode` |
| View 401 | wrong/absent `PRODUCT_SIGNALS_TOKEN` Bearer header |
| Verify stored rows | `wrangler d1 execute pd-product-telemetry --remote --command "SELECT bucket_date, COUNT(*) FROM product_telemetry_daily GROUP BY bucket_date"` |

## 8. Validation harnesses (reusable)

- Collector E2E: `node scripts/telemetry-e2e-validate.mjs --endpoint <url> [--signals-token <t>]` (14+5 checks incl. dedup, rejections, view protection/content).
- Production-equivalent client loop (isolated canonical install, real network): `node scripts/telemetry-production-smoke.mjs --endpoint <url>` then run the printed RUNNER script.
