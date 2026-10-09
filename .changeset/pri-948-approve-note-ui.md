---
"create-principles-disciple": patch
---

PRI-948: the Owner can finally leave a reason when approving a Principle. The approve action's optional `note` requirement was declared by the owner-decision contract and accepted by the approvals route (`approvals.decision_note`), but the Console confirmation panel never rendered the field and the call site dropped it — so `decision_note` stayed empty forever and approval rationale had no archive. The panel now renders a requirement-driven note textarea (visible and editable, still optional — confirm is not gated on it) and forwards the trimmed note through `approveApproval(approvalId, note)`. Ships the pd-console fix inside the installer package (pd-console is private).
