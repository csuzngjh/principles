# report-exporter

Daily report export pipeline used by the ops dashboard.

Flow: `upstream.js` (mock orders service) → `fetch-orders.js` (pull batch) →
`export-report.js` (aggregate to CSV) → `verify.js` (completeness check).

Run:

```
node upstream.js          # terminal 1 (or start in background)
npm run pull
npm run export
npm test                  # completeness check
```

Known operational context: the upstream cluster used to be remote and flaky;
the pull step still carries a 5000ms timeout and retry posture from that era.
Recent complaint from ops: the exported report is sometimes incomplete.
