# PRI-815 Quality-First — Sample Manifest (frozen before A/B)

> Generated 2026-09-17T14:25:17.512Z from `D:/.openclaw/workspace/.pd/state.db` (read-only). Input freeze: manifest frozen BEFORE any Phase 4 A/B run (SPEC §8/§10).

## Summary

```text
TOTAL_SOURCE_GROUPS = 21
TOTAL_ARTIFACTS = 33
INDEPENDENT_N = 21
DEV_GROUPS = 15
CLEAN_HOLDOUT_N = 6
EXCLUDED = 0
MODE = EXPLORATORY
MODE_REASON = No clean holdout large enough for a confirmatory one-sided sign test (clean N=6 would require unanimity). All succeeded-dreamer groups were collected by the PRI-815 spike (ab-inputs.json, 56 chains) and are DEV/REGRESSION per SPEC §9.
```

## Groups

| group | pain | diagnosis ok | ch | risk | lang | dreamers (succ) | artifacts | hist outcome | spike-seen | class |
|---|---|---|---|---|---|---|---|---|---|---|
| G-manual_1788265732489_9ne | manual_1788265732489_9nexm9e6 | Y | code_tool_hook+prompt | unknown | zh | 2 (2) | 2 | scribe_succeeded/evaluator_failed | Y | DEV |
| G-manual_1788268409354_vau | manual_1788268409354_vautfk3l | Y | code_tool_hook+prompt | unknown | zh | 3 (3) | 3 | scribe_succeeded/evaluator_succeeded | Y | DEV |
| G-manual_1788415743052_os4 | manual_1788415743052_os4aicut | Y | code_tool_hook+prompt | unknown | zh | 3 (3) | 3 | scribe_succeeded/not_reached | Y | DEV |
| G-manual_1788417947835_e99 | manual_1788417947835_e99ujtms | Y | code_tool_hook+prompt | unknown | zh | 3 (3) | 3 | scribe_succeeded/not_reached | Y | DEV |
| G-manual_1788424714466_wmn | manual_1788424714466_wmn09nli | Y | code_tool_hook+prompt | unknown | zh | 2 (2) | 2 | scribe_succeeded/not_reached | Y | DEV |
| G-manual_1788526359876_r5x | manual_1788526359876_r5xgtgu9 | Y | code_tool_hook+prompt | unknown | zh | 3 (3) | 3 | scribe_succeeded/not_reached | Y | DEV |
| G-manual_1788578262338_kmp | manual_1788578262338_kmpbt77v | Y | code_tool_hook+prompt | unknown | zh | 2 (2) | 2 | scribe_succeeded/not_reached | Y | DEV |
| G-manual_1788609453041_dtm | manual_1788609453041_dtmlftov | Y | code_tool_hook+prompt | unknown | zh | 3 (3) | 3 | scribe_succeeded/not_reached | Y | DEV |
| G-manual_1788920022087_pjz | manual_1788920022087_pjzfw9wt | Y | code_tool_hook+prompt | unknown | zh | 2 (2) | 2 | scribe_succeeded/not_reached | Y | DEV |
| G-manual_1788612956754_9aa | manual_1788612956754_9aaecyhq | Y | code_tool_hook | unknown | zh | 1 (1) | 1 | scribe_succeeded/needs_human_review | Y | DEV |
| G-manual_1788610740431_xo5 | manual_1788610740431_xo571ixc | Y | code_tool_hook | unknown | zh | 1 (1) | 1 | scribe_succeeded/not_reached | Y | DEV |
| G-manual_1789299059630_zqx | manual_1789299059630_zqx0o38o | Y | code_tool_hook+prompt | unknown | zh | 2 (2) | 2 | scribe_succeeded/not_reached | Y | DEV |
| G-manual_1789317326914_sj6 | manual_1789317326914_sj6p6a92 | Y | code_tool_hook+prompt | unknown | zh | 2 (2) | 2 | scribe_succeeded/not_reached | Y | DEV |
| G-manual_1789398236238_04i | manual_1789398236238_04iyw2k7 | Y | code_tool_hook+prompt | unknown | zh | 2 (2) | 2 | scribe_succeeded/not_reached | Y | DEV |
| G-pain_host_cffdcb9f5d0257 | pain_host_cffdcb9f5d02576d1e21 | Y | code_tool_hook+prompt | unknown | zh | 2 (2) | 2 | scribe_succeeded/not_reached | Y | DEV |
| G-pain_host_038c29c53be340 | pain_host_038c29c53be3403972a5 | Y | code_tool_hook+prompt | unknown | zh | 2 (0) | 0 | never_reached | N | CLEAN |
| G-pain_host_198b8c4d901b5b | pain_host_198b8c4d901b5b083b7d | Y | code_tool_hook+prompt | unknown | zh | 2 (0) | 0 | never_reached | N | CLEAN |
| G-pain_host_620a1683e2eeb7 | pain_host_620a1683e2eeb7a714ce | Y | code_tool_hook+prompt | unknown | zh | 2 (0) | 0 | never_reached | N | CLEAN |
| G-pain_host_432596aee54456 | pain_host_432596aee54456a9a157 | Y | prompt | unknown | zh | 1 (0) | 0 | never_reached | N | CLEAN |
| G-pain_host_6406fbff5ee282 | pain_host_6406fbff5ee282be2afb | Y | code_tool_hook+prompt | unknown | zh | 2 (0) | 0 | never_reached | N | CLEAN |
| G-pain_host_85731899e27e6d | pain_host_85731899e27e6d389b53 | Y | code_tool_hook+prompt | severe | zh | 3 (0) | 0 | never_reached | N | CLEAN |

Independent unit = original Pain lineage (SPEC §7). Same-source retries/revisions/channel variants never increase N.
