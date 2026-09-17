<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-071",
  "displayId": "ERR-071",
  "title": "Async cleanup not `await`ed in finally; test resources not wrapped in try-finally; `process.env` not restored — resource leaks and test pollution",
  "status": "active",
  "category": "Missing Tests & Verification",
  "ep": "EP-03",
  "createdAt": "2026-06-18",
  "source": "PRI-428 / PR #966 (CodeRabbit review)"
}
-->

**Recurrence**: 2026-09-04 PRI-655 / PR #1514 review — a daemon-loop test sent its stop signal only on the happy path, so assertion failures leaked a live background loop, timers and signal listeners into subsequent tests; fixed by moving SIGINT + handler await into try/finally. 2026-07-17 / 08-13 / 08-28 / 06-21 / 06-18 (compressed; full text → ERROR_ARCHIVE.md): `RuntimeStateManager.close()` awaited in an async `afterEach`; a registration-test timer mocked instead of mutating real home config; a process-wide `unhandledRejection` listener registered but never removed; timeout cleanup killed only the direct CLI process (terminate the whole detached process group); short-lived SQLite queues returned without their owning connection; cleanup failures discarded; `AudioContext` instances leaked on unmount.
