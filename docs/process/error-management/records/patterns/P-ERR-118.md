<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-118",
  "displayId": "ERR-118",
  "title": "A configured deadline is not the only timer on a request — transport-layer implicit timeout defaults (undici headersTimeout/bodyTimeout = 300s) silently cap requests below every explicitly configured timeout",
  "status": "active",
  "category": "Missing Tests & Verification",
  "ep": "EP-03",
  "createdAt": "2026-09-05",
  "source": "PRI-683 lab evidence `pd-labs/pri653-r2b/evidence/artificer-300s-inner-cap-proof.json` + state.db runs table (8+ attempts at 300.0s, abort-family reason, vs d0a0305a chain aborting at exactly 600.0s with \"after 600000ms\" — fingerprint separation)."
}
-->

**Recurrence**: 2026-09-04 PRI-670 (runner-layer 300s default — PR #1512) → 2026-09-05 PRI-683 (transport-layer 300s implicit default). Same week, same symptom ("requests die around 300s"), two different layers; the first fix's success (600s/900s firing precisely) is what made the second layer visible. Historical member: PRI-633 undici connectTimeout 10s (2026-08-31, documented in issue text only). Lesson: when a timeout family recurs, audit the WHOLE stack top-to-bottom in one pass instead of peeling one layer per incident.
