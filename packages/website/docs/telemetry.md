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

If you opt in, PD sends **one small snapshot per day** containing only:

- PD version
- Coarse host kind (openclaw / codex / other)
- The day's date (UTC)
- A one-day anonymous ID that **cannot be linked to any other day**
- Six yes/no product milestones: PD initialized · pain evidence observed · a principle exists · an activation happened · a presence receipt observed · an effect receipt observed
- One yes/no reliability signal (initialization failed)

## What is never collected

- ❌ Conversations, prompts, or Agent responses
- ❌ Principle content or Pain content
- ❌ Source code, file names, file paths, repository names
- ❌ Tool arguments or outputs, logs, stack traces, error messages
- ❌ Usernames, emails, hostnames, device fingerprints, location
- ❌ Exact counts of anything (principles, pains, receipts, sessions)
- ❌ Any identifier that persists across days

## How the anonymous ID works

When you enable telemetry, PD generates a random secret that **never leaves your machine**. Each day it derives `HMAC(secret, date)` — a one-day ID. The server receives only an additional HMAC of that ID, so even the collector cannot tell that two days came from the same installation. There is no installation ID, no user ID, and no way to reconstruct your activity timeline from the collected data.

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

Daily snapshots are stored for **90 days**, then deleted. PD does not read or store your IP address, user agent, or request headers at the application level. (As with any HTTPS service, Cloudflare's network processes transport metadata to deliver requests — that is platform-level networking, not PD analytics.)

## Limitations you should know

Telemetry is opt-in, so the numbers represent only **participating installations** — never the whole PD population. Milestone booleans are conservative observations, not claims: an "effect receipt observed" means a governance mechanism affected one execution, not that your Agent permanently improved.
