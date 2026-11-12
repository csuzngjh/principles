# PRI-1182 · Shared-window acceptance

The previous batch made four attempts, all cancelled near its 500 ms header
cutoff. Preserve its claim, results and original manifest.

- Same five inputs, candidate order, configuration, model allowlist and scoring
  thresholds. The new manifest changes the time limit and expiry.
- One shared 2000 ms deadline from send through full validation, or the earlier
  Codex deadline with its existing reserves. Zero retries. At most one request
  per case and four total. The explicit thanks case sends zero requests.
- OpenRouter Decisions, model respan/span-01-lite:free, Respan only, fallback
  disabled. Response model IDs must match the frozen allowlist. A missing
  response provider field is recorded as absent.
- Only the frozen fixture prompt, bounded candidate refs/text/digests and
  scoring questions are sent. No history. See the original card for field caps.
- Expires 2026-11-15 23:59:59 +08:00.

Build core, install-layout, host-runtime and the Codex adapter. Run
`node scripts/dev/adaptive-activation/run-cases.mjs --preflight` with fake transport.
For approval, bind the actual execution commit and tree, the manifest, config
and build SHA-256 values from the preflight record, the route and response model
IDs, envelopeTotalMs 2000, criteriaVersion v1-20261111, maxRequests 4 and expiry.
Follow the original card's approval JSON shape. After approval run the same
runner with `--approved <approval.json>`. The new batch has its own claim and results.

Pass only if the five frozen expectations hold, including an actual append,
valid abstention, unchanged Native on no-fit, short confirmation evaluated, and
zero-send thanks. If the critical cases fail, keep Adaptive off and close this
synchronous candidate without retries or further timeout tuning. A pass supports
preparing a single-workspace trial. The prior isolated Codex request probe is
delivery evidence for its exact host and configuration.
