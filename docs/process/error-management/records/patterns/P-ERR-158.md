<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-158",
  "displayId": "ERR-158",
  "title": "Stored object truthiness used as semantic status — producer upgraded a persisted contentRef existence to resolved without its digest, and the pre-dedup validator rejection made replay rejection masquerade as idempotency",
  "status": "active",
  "category": "Schema & Type Mistakes",
  "ep": "EP-01",
  "createdAt": "2026-10-12",
  "source": "Phase 1 closeout execution review P2-2, replay probe failure 2026-10-11, fixed in PR 1992"
}
-->

A producer rebuilding an observation for a replayed source event read a persisted structured reference (contentRef) and used the OBJECT's truthiness as a semantic status flag — upgrading `resolution` to `'resolved'` whenever the reference object existed, while the payloadDigest it was required to carry stayed absent. The downstream normalizer then rejected the whole batch (`resolved`-without-digest) BEFORE the store's idempotent dedup branch could run, so a same-event replay failed with a validation reason while "record count unchanged" masqueraded as idempotency. The defect class: **a stored object's truthiness is not a semantic predicate — a status enum that implies an invariant (resolved ⟹ digest present) must be derived from the invariant's own witness field, not from reference existence**; and when a validator sits between producer and dedup, a validation rejection and an idempotent no-op are observationally indistinguishable at the row-count level. The same truthy-upgrade shape existed at FOUR producer sites across two packages (Codex prompt delivery + deny chain, OpenClaw prompt delivery + gate enforcement) because the pattern was copied, not because it was designed. Fix discipline: derive `resolved` only from the digest field actually being present; keep a real-boundary regression whose negative control drives recorder→ingress→store on BOTH hosts and asserts the duplicate branch (`duplicateCount: 1`), not merely unchanged row counts; when adding such a fix, rg the exact assignment shape across every package that duplicates the producer.
