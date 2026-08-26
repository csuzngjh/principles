# ADR-0021: Anonymous Product Telemetry v1 — Opt-In, Privacy-Preserving Product Signals

> **Status**: Accepted (amended 2026-08-26 by the PR #1419 review remediation: measurement unit corrected to the workspace, tri-state facts, transport abuse control, scheduled retention)
> **Date**: 2026-08-26
> **Decider**: Owner
> **Context**: MVP-First (ADR-0014); maintainer cannot distinguish real product usage from ClawHub download counts (PRI-595~603)
> **Supersedes**: The "No analytics or telemetry upload" clause in [ADR-0016](0016-pd-owned-user-config.md) §5 — superseded **only** for the opt-in anonymous telemetry channel defined here. Everything else in ADR-0016 stands.
> **Related**: [Product Telemetry maintainer doc](../architecture/product-telemetry.md); [Phase 0 feasibility review](../audit/anonymous-product-telemetry-feasibility.md)

## 1. Context

PD's only distribution signal is ClawHub/npm download counts, which include repeat/automated/CI downloads. The maintainer cannot answer: *is PD actually being run, do participating workspaces reach the core value milestones, which versions are active, are releases broadly failing?* (PRI-595 product questions Q1–Q4).

Conventional analytics (user IDs, sessions, event streams, funnels) would violate PD's product identity: a governance system whose value proposition is Owner control cannot quietly profile its users.

## 2. Decision

Establish an **anonymous, opt-in, daily-snapshot product telemetry channel** under the highest principle:

> **Collect signals, not users.**

### 2.0 Measurement unit and scope model (review remediation)

The **telemetry measurement unit is the workspace**, not the installation:

- **Machine scope**: consent, consentVersion, and the telemetry secret (`~/.pd/product-telemetry.json`).
- **Workspace scope**: the daily identity, same-day dedup, retry/backoff bookkeeping, attempt caps, and the cross-process export lock — all keyed by an opaque local `workspaceScopeId = HMAC(secret, canonical workspace path)`. The scope ID exists only in local bookkeeping and lock filenames; the server never sees it, and it is never uploaded. One workspace's success, backoff, or lock never suppresses another workspace on the same installation.
- A workspace that is moved or renamed resolves to a new scope and is deliberately treated as a new telemetry workspace — no stable cross-path identity is created.

All maintainer-facing wording says "participating workspaces" / "daily-workspace observations" — never "installations" or "users".

### 2.1 What is collected (complete list)

One JSON snapshot (`ProductTelemetrySnapshotV1`, 8 top-level fields) per **participating workspace** per day: schema/consent versions, a daily unlinkable ID, UTC date bucket, PD version, coarse host kind, six **tri-state** product milestones (`initialized`, `painObserved`, `principleObserved`, `activationObserved`, `presenceReceiptObserved`, `effectReceiptObserved`), and one tri-state reliability signal (`initializationFailed`). No counts. No content. Full inventory: §schema table in the maintainer doc.

**Tri-state semantics ("Unknown ≠ false")**: each fact is `true` (source evaluable AND evidence observed), `false` (source evaluable AND definitively no evidence), or `null` (source not currently evaluable — DB unreadable, required table missing in an old schema, receipt collection disabled). `initializationFailed=true` is claimable **only** from a readable DB whose schema is definitively not initialized — a read failure reports `null`, never a fabricated failure. SQL NULL facts are excluded from dashboard denominators (Observed / Evaluable / Unavailable) and never summed as 0.

### 2.2 Identity: daily unlinkable by construction

No installation or workspace ID exists on the server. The client keeps a local random secret (`~/.pd/product-telemetry.json`, never uploaded) and derives, per workspace per day:

```
workspaceScopeId = HMAC-SHA256(secret, "workspace:" + canonicalWorkspacePath)   [local only]
dailyTelemetryId = HMAC-SHA256(secret, "daily-workspace:" + workspaceScopeId + ":" + bucketDate)
```

The collector additionally stores only `serverDailyId = HMAC(serverSecret, clientDailyId)` — the client ID itself never reaches D1. Cross-day AND cross-workspace correlation is impossible from stored data by construction; no retention/cohort analysis is technically possible.

### 2.3 Gating: three independent switches, default OFF everywhere

```
canExport = feature flag anonymous_product_telemetry (quiet, default off)
          AND explicit user consent (pd telemetry enable --confirm)
          AND environment not suppressed
```

Suppression: `PD_TELEMETRY_DISABLED` kill switch, `CI`, `VITEST`, `PD_E2E_MODE=1`, `workspace.environment ∈ {test, demo, development}`, nothing-installed, and monorepo-checkout module detection. Zero consent ⇒ zero network requests, proven by the gate-matrix tests.

### 2.4 Control plane

`pd telemetry status | enable | disable | preview | reset`. `preview` prints the **exact outbound payload** with "Preview only. Nothing was sent." `reset` rotates the local secret. No prompts, no nags — consent is CLI-only in v1.

### 2.5 Non-interference

Telemetry is read-only with respect to all PD governance facts. Export is fire-and-forget (unref'd timer, contained failures, bounded backoff) and can never block or crash PD startup, hooks, or governance. Triggers: OpenClaw plugin workspace init + pd-console startup (the Codex pd-hook subprocess is deliberately excluded — its lifetime is shorter than the network timeout; documented limitation: Codex-only installations without console export nothing).

### 2.6 Server side

Cloudflare Pages Function on the existing `principles-website` project + D1 (`pd-product-telemetry`). Strict schema (unknown fields ⇒ 400), 4 KB cap, two-layer rate limiting, 90-day retention enforced by a **scheduled cleanup** plus a write-time sweep. The maintainer view (`/product-signals`, Bearer-token protected) shows only four aggregate signal groups with permanently displayed honest wording ("participating workspaces", "7-day daily-workspace observations", "Effect receipt observed" — never "users", "DAU", "Agent improved", never "verified installations").

**Abuse protection (review remediation)**: layer 1 rate-limits per client-provided `dailyTelemetryId` (KV, best-effort); layer 2 rate-limits per **keyed transport token** — `HMAC(TELEMETRY_ABUSE_HMAC_SECRET, "telemetry-abuse:" + sourceIp + ":" + hourBucket)` (an independent, domain-separated secret) stored only as the KV key with ~1h TTL. An attacker rotating client IDs cannot rotate this key. Raw IPs are never written to D1, never logged, never echoed. Zone-level Cloudflare WAF rate limiting is the optional strict tier (deployment recommendation, not required for v1).

**Retention (review remediation)**: 90 days, enforced by (1) a protected `POST /api/product-telemetry/cleanup` endpoint (Bearer `PRODUCT_TELEMETRY_CLEANUP_TOKEN`, constant-time compare, server-computed cutoff from the single shared `retentionCutoffDate()` policy) invoked daily by a scheduled GitHub workflow that FAILS on any non-2xx or non-`ok` response, and (2) the opportunistic write-time sweep using the same cutoff computation. Cleanup runs independently of new telemetry writes.

## 3. Consequences

- ADR-0016 §5's blanket "no telemetry" clause is superseded for this channel; `.pd/config.yaml` remains PD's single user config file (the release flag lives there; consent lives in `~/.pd/product-telemetry.json` because it is machine-scope, not workspace-scope).
- Measurement semantics are a contract: figures are opt-in samples of participating workspaces, never a population estimate; the collector cannot prove senders are real PD deployments — figures are "accepted anonymous submissions"; download counts must never be combined into conversion rates.
- Explicitly out of scope (non-goals reaffirmed): user profiles, installation profiles, DAU/MAU, retention/churn, session replay, event streaming, geographic/device profiling, attribution pipelines, causal "Agent improvement" claims, download→activation conversion, cross-workspace or cross-day linkage of any kind.
- Rollback: four independent paths — flag default-off (current state; graduation to default-on is a separate owner decision), `pd telemetry disable`, `PD_TELEMETRY_DISABLED=1`, and server-side (remove endpoint / purge D1). No path requires a PR revert.

## 4. Graduation note

v1 ships with the release flag **default off** (MVP-Quiet per ADR-0014 §2.5). The full pipeline (client gates, collector, D1, view) is deployed and validated; activation for real users requires the owner to graduate the flag to default-on in a future release — consent remains the user's switch regardless.
