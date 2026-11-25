# PRI-1292 Round 3 — OpenClaw 2026.11.5 isolated-host config acceptance

Date: 2026-11-25  
Host artifact: npm `openclaw@2026.11.5` (`OpenClaw 2026.11.5 (e13cf15)`)  
Isolation root used during execution: `/tmp/pd-oc-realhost-r3` (temporary, not production state)

## Isolation

The real host commands ran with all of the following set:

- `OPENCLAW_STATE_DIR=/tmp/pd-oc-realhost-r3/state`
- `OPENCLAW_HOME=/tmp/pd-oc-realhost-r3/home`
- `OPENCLAW_CONFIG_PATH=/tmp/pd-oc-realhost-r3/config/openclaw.json`
- `PD_EXPERIMENT_ROOT=/tmp/pd-oc-realhost-r3/pd-exp`
- `PD_WORKSPACE_DIR=/tmp/pd-oc-realhost-r3/workspace`
- `HOME=/tmp/pd-oc-realhost-r3/home`

No production OpenClaw config or production workspace was edited. The first local-path plugin install required a retry after OpenClaw normalized its own config write (`config changed since last load`); the second install succeeded in linked mode. That install-time retry did not affect the acceptance config because the include test config was written afterward.

## False-through-include acceptance

Main config (`openclaw.json`) contained:

```json5
{
  gateway: { mode: 'local' },
  plugins: {
    $include: './plugins.json5',
    load: { paths: ['/home/ubuntu/repos/_worktrees/principles/PRI-1292-pipeline-spine-2a/packages/openclaw-plugin'] },
  },
  meta: {
    migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true },
    lastTouchedVersion: '2026.11.5',
  },
}
```

Included `plugins.json5` contained `plugins.entries.principles-disciple.hooks.allowConversationAccess: false` in JSON5 form.

SHA256 before gateway start:

```text
636f672ccad223f597f3089d4b696a5a588fe4fc88311eabc1566c56b5ad3a3a  /tmp/pd-oc-realhost-r3/config/openclaw.json
ba8334db35550ff952e665bde7bddd8f4e4d869b369397237a8fb56ffb198f0b  /tmp/pd-oc-realhost-r3/config/plugins.json5
```

SHA256 after gateway start was byte-identical (same two hashes). No automatic rewrite to `true` occurred.

Real gateway evidence:

```text
[plugins] loading principles-disciple from .../packages/openclaw-plugin/dist/bundle.js
[gateway] [plugins] typed hook "before_prompt_build" blocked because non-bundled plugins must set plugins.entries.principles-disciple.hooks.allowConversationAccess=true
[gateway] [plugins] typed hook "llm_output" blocked because non-bundled plugins must set plugins.entries.principles-disciple.hooks.allowConversationAccess=true
[gateway] [plugins] typed hook "llm_input" blocked because non-bundled plugins must set plugins.entries.principles-disciple.hooks.allowConversationAccess=true
[plugins] [PD:health] conversation hooks (llm_output / trajectory) disabled by explicit configuration — honoring Owner opt-out (allowConversationAccess=false).
```

The first three lines are the host's own gate proving the included effective `false` blocked conversation-capable hooks. The fourth is PD's real plugin-side read of the same effective config.

## True-through-include acceptance

Only the included file was changed to `allowConversationAccess: true`; the main config remained include-backed.

SHA256 before gateway start:

```text
636f672ccad223f597f3089d4b696a5a588fe4fc88311eabc1566c56b5ad3a3a  /tmp/pd-oc-realhost-r3/config/openclaw.json
6c54fad452a9173dfc85e288a5d49a1d2e04454a792f3a3444c96117c210006a  /tmp/pd-oc-realhost-r3/config/plugins.json5
```

SHA256 after gateway start was byte-identical (same two hashes). No startup repair write occurred.

Real gateway evidence:

```text
[gateway] http server listening (15 plugins: ..., principles-disciple, ...)
[plugins] [PD:health] conversation hooks (allowConversationAccess) OK
```

No `typed hook ... blocked because ... allowConversationAccess=true` line appeared in the true run.

## Follow-up review hardening

Post-acceptance review additionally fixed and covered by unit regression: atomic repair preserves the original config mode (0600 stays 0600), include lexical roots and symlink real roots are checked independently exactly like the host, ordinary `..`-prefixed filenames inside a permitted root are not misclassified as traversal, and startup repair is blocked only when a permission-parent node (`root/plugins/entries/principles-disciple/hooks`) is itself include-managed, and repair through a symlinked main config is refused so `rename` cannot detach the link from its managed target. The compatibility reader also mirrors OpenClaw's bounded include-file boundary: raw and resolved paths are length-limited, reads are descriptor-based and bounded to 2 MiB, non-regular files and hardlinked fragments are rejected, and the opened file identity/root is revalidated. Because JSON5 comments cannot be preserved by `JSON.stringify`, startup repair refuses JSON5-only main configs and leaves the existing manual repair command as the Owner-facing recovery path; strict-JSON repair creates temporary files with the original mode at open time. Startup recovery copy now recommends only explicitly setting the flag to `true` in the original host config (direct editing preserves JSON5 comments/formatting), never presents deletion of an explicit deny as a generally sufficient recovery path, and warns that the CLI rewrite path may remove comments.

## Limitations honestly recorded

- The temporary experiment workspace was intentionally independent and triggered PD's existing experiment-isolation warnings because it was outside the smaller temporary `PD_EXPERIMENT_ROOT` subdirectory. Those warnings concern workspace isolation, not the OpenClaw config authorization decision; the authorization evidence above is produced before/independently of workspace ingestion.
- This acceptance verifies the real gateway startup path, host hook admission, and PD's real plugin config-health read. It does not run a model conversation or submit pain traffic.
