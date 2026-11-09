---
---

@types/node 26.4.1 -> 26.6.6, plus a declaration-only bridge in
packages/principles-core/src/runtime/adapter/pi-ai-http-transport.ts.

@types/node 26.6.6 bundles undici-types ~8.9, whose ambient Response declares
a `textStream` getter that undici@7's own Response declaration lacks. Both
declarations describe the same Node runtime object, so the bridge returns the
response unchanged. No runtime behaviour, public API or published artifact
content changes; this is an explicit no-release declaration.
