---
'create-principles-disciple': patch
---

PRI-889: Governance Focus now renders the existing PendingReviewCard (Wave 7 component with approve/reject/revise actions) for pending approval groups, giving Owners their first clickable activation-approval path in the browser. When grouped approvals data is available, activation_approval entries skip the legacy OwnerDecisionCard (its only affordance was a dead CTA); when unavailable, all entries keep rendering so decisions never silently disappear. The card honors the PRI-787 governance-readiness lock with a visible reason.
