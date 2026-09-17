<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-041",
  "displayId": "ERR-041",
  "title": "Install success reported when delivered components are incomplete",
  "status": "archived",
  "category": null,
  "ep": "EP-03",
  "createdAt": "2026-05-26",
  "source": "PRI-247 / PR #721"
}
-->

**Recurrence**: Same class as ERR-002, ERR-009. Recurred 2026-05-26 PRI-247 (PR #721): `bundle-plugin.mjs` silently skipped missing artifacts without exit(1). If `templates/` or `openclaw.plugin.json` was absent, the bundle would produce an incomplete tarball that passes CI but fails at runtime. Fixed by adding PLUGIN_REQUIRED/PD_CLI_REQUIRED arrays with process.exit(1) on missing items, and PLUGIN_OPTIONAL for items that skip with warning.
