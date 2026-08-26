# ADR-0021: Anonymous Product Telemetry v1 — Opt-In, Privacy-Preserving Product Signals

> **Status**: Accepted
> **Date**: 2026-08-26
> **Decider**: Owner
> **Context**: MVP-First (ADR-0014); maintainer cannot distinguish real product usage from ClawHub download counts (PRI-595~603)
> **Supersedes**: The "No analytics or telemetry upload" clause in [ADR-0016](0016-pd-owned-user-config.md) §5 — superseded **only** for the opt-in anonymous telemetry channel defined here. Everything else in ADR-0016 stands.
> **Related**: [Product Telemetry maintainer doc](../architecture/product-telemetry.md); [Phase 0 feasibility review](../audit/anonymous-product-telemetry-feasibility.md)

## 1. Context

PD's only distribution signal is ClawHub/npm download counts, which include repeat/automated/CI downloads. The maintainer cannot answer: *is PD actually being run, do participating installations reach the core value milestones, which versions are active, are releases broadly failing?* (PRI-595 product questions Q1–Q4).

Conventional analytics (user IDs, sessions, event streams, funnels) would violate PD's product identity: a governance system whose value proposition is Owner control cannot quietly profile its users.

## 2. Decision

Establish an **anonymous, opt-in, daily-snapshot product telemetry channel** under the highest principle:

> **Collect signals, not users.**

### 2.1 What is collected (complete list)

One JSON snapshot (`ProductTelemetrySnapshotV1`, 8 top-level fields) per **participating installation** per day: schema/consent versions, a daily unlinkable ID, UTC date bucket, PD version, coarse host kind, six **boolean** product milestones (`initialized`, `painObserved`, `principleObserved`, `activationObserved`, `presenceReceiptObserved`, `effectReceiptObserved`), and one boolean reliability signal (`initializationFailed`). No counts. No content. Full inventory: §schema table in the maintainer doc.

### 2.2 Identity: daily unlinkable by construction

No installation ID exists. The client keeps a local random secret (`~/.pd/product-telemetry.json`, never uploaded) and derives `dailyTelemetryId = HMAC-SHA256(secret, UTC-date)` per day. The collector additionally stores only `serverDailyId = HMAC(serverSecret, clientDailyId)` — the client ID itself never reaches D1. Cross-day correlation is impossible from stored data by construction; no retention/cohort analysis is technically possible.

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

Cloudflare Pages Function on the existing `principles-website` project + D1 (`pd-product-telemetry`). Strict schema (unknown fields ⇒ 400), 4 KB cap, KV rate limit, 90-day retention enforced by a write-time sweep (Pages Functions have no cron). The maintainer view (`/product-signals`, Bearer-token protected) shows only four aggregate signal groups with permanently displayed honest wording ("participating telemetry units", "7-day daily-unit observations", "Effect receipt observed" — never "users", "DAU", "Agent improved").

## 3. Consequences

- ADR-0016 §5's blanket "no telemetry" clause is superseded for this channel; `.pd/config.yaml` remains PD's single user config file (the release flag lives there; consent lives in `~/.pd/product-telemetry.json` because it is machine-scope, not workspace-scope).
- Measurement semantics are a contract: figures are opt-in samples of participating installations, never a population estimate; download counts must never be combined into conversion rates.
- Explicitly out of scope (non-goals reaffirmed): user profiles, DAU/MAU, retention/churn, session replay, event streaming, geographic/device profiling, attribution pipelines, causal "Agent improvement" claims, download→activation conversion.
- Rollback: four independent paths — flag default-off (current state; graduation to default-on is a separate owner decision), `pd telemetry disable`, `PD_TELEMETRY_DISABLED=1`, and server-side (remove endpoint / purge D1). No path requires a PR revert.

## 4. Graduation note

v1 ships with the release flag **default off** (MVP-Quiet per ADR-0014 §2.5). The full pipeline (client gates, collector, D1, view) is deployed and validated; activation for real users requires the owner to graduate the flag to default-on in a future release — consent remains the user's switch regardless.
