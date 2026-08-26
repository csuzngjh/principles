---
title: Anonymous Telemetry (Privacy)
description: Principles Disciple's opt-in, anonymous product telemetry — what it collects, what it never collects, and how to control it.
---

# Anonymous Telemetry (Privacy)

Principles Disciple includes an **opt-in** anonymous product telemetry channel that helps the maintainer understand whether PD is actually being used and whether releases are healthy. It follows one principle:

> **Collect signals, not users.**

## Off by default

Telemetry is **OFF** unless you explicitly turn it on. Without your consent, PD makes **zero** telemetry network requests.

## What is collected (complete list)

If you opt in, PD sends **one small snapshot per workspace per day** containing only:

- PD version
- Coarse host kind (openclaw / codex / other)
- The day's date (UTC)
- A one-day anonymous ID that **cannot be linked to any other day or any other workspace**
- Six yes/no product milestones: PD initialized · pain evidence observed · a principle exists · an activation happened · a presence receipt observed · an effect receipt observed. A milestone can also be **"unavailable"** (null) when its local data source cannot be evaluated — that is reported as "unknown", never as "no".
- One yes/no reliability signal (initialization failed), with the same "unavailable" state

The measurement unit is the **workspace**: each workspace on your machine sends its own independent daily snapshot, derived only from that workspace's durable facts. Consent is given once per machine and can be withdrawn at any time.

## What is never collected

- ❌ Conversations, prompts, or Agent responses
- ❌ Principle content or Pain content
- ❌ Source code, file names, file paths, repository names
- ❌ Tool arguments or outputs, logs, stack traces, error messages
- ❌ Usernames, emails, hostnames, device fingerprints, location
- ❌ Exact counts of anything (principles, pains, receipts, sessions)
- ❌ Any identifier that persists across days or across workspaces

## How the anonymous ID works

When you enable telemetry, PD generates a random secret that **never leaves your machine**. Each day, for each workspace, it derives `HMAC(secret, workspace-scope, date)` — a one-day ID. The server receives only an additional HMAC of that ID, so even the collector cannot tell that two days — or two workspaces — came from the same machine. There is no installation ID, no user ID, no persistent workspace ID, and no way to reconstruct your activity timeline from the collected data.

## Control (CLI)

```bash
pd telemetry status    # consent, gates, eligibility, last export status
pd telemetry preview   # shows the EXACT payload that would be sent — nothing is sent
pd telemetry enable --confirm    # opt in
pd telemetry disable --confirm   # opt out and delete the local identity
pd telemetry reset --confirm     # rotate the anonymous identity
```

`pd telemetry preview` prints the exact outbound payload with a "Preview only. Nothing was sent." notice — inspect exactly what would leave your machine before opting in.

## Enterprise / CI hard-off

Set the environment variable `PD_TELEMETRY_DISABLED=1`. It outranks any local setting. CI, test, and development environments are additionally suppressed automatically — they never send product telemetry.

## Retention & transport metadata

PD applies a **90-day telemetry retention policy**: records older than the retention window are removed by a scheduled cleanup process, with write-time cleanup as an additional safeguard. (Deletion is policy-based, not an exact-to-the-second guarantee.)

Transport abuse prevention: Cloudflare provides the source network information required to deliver each request. PD's collector may transiently use the source IP to derive a keyed, short-lived abuse-prevention token (a rate-limit key that expires after about an hour). **Raw IP addresses are not stored in product telemetry, are not persisted to the product database, never appear in logs or responses, and the abuse token expires automatically.** No user agent or other request headers are read.

## Limitations you should know

Telemetry is opt-in, so the numbers represent only **participating workspaces** that submitted anonymous snapshots — never the whole PD population, and not a verified count of anything. Milestone values are conservative observations, not claims: an "effect receipt observed" means a governance mechanism affected one execution, not that your Agent permanently improved.
