---
'@principles/host-runtime': patch
---

Consent-store single-format convergence (PRI-1138, PRI-1104/5): the product-telemetry control state now has exactly one writable/persisted schema. `writeProductTelemetryControlState` refuses any non-current schemaVersion, so no code path can persist or regenerate a legacy v1 file. Parsing converges from the `isV1`/`isV2` branches into one `parseConsentState` entry with a single current-format whitelist; legacy v1 files remain readable through the strictly one-way, read-only migrator (`migrateLegacyConsentFile` — legacy reader semantics only), which preserves consent/consentVersion/telemetrySecret verbatim and drops the retired machine-global export bookkeeping. The load that recognizes a v1 file persists the migration immediately through the normal atomic write (disk converges on first load; idempotent afterwards), and a failed migration write fails loud without touching the original file. No wire values or public API shapes changed.
