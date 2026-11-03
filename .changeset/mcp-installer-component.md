---
'create-principles-disciple': minor
---

Gate 4-F (PRI-1071): the installer bundles and deploys `@principles/pd-mcp-server` as a runtime sibling component (release-locks, release asset, npm-distributed components and files manifest all carry it). The WorkBuddy host installer writes the MCP launcher binding during marketplace materialization. Payloads older than the component deploy unaffected — the MCP server then fails closed with an honest missing-entry state.
