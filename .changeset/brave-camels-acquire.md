---
"create-principles-disciple": patch
---

The update chain now refuses a non-HTTPS release-asset URL outright, re-checks
HTTPS on every redirect hop it follows (a carrier can no longer downgrade the
delivery to plaintext with a 302), and publishes verified asset bytes to their
canonical staging name only through a private, exclusively-created candidate
plus an atomic rename, so a plaintext carrier can no longer poison every
delivery and an unverified file can never be reachable under the name the
installer deploys from (PRI-927).
