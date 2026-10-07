---
"create-principles-disciple": patch
---

PRI-947: the Owner approval second step now appears where the Owner is looking. Clicking 批准 on a principle detail page expanded the confirmation panel as the last node of the whole page, below the fold and with no scroll/focus/toast, so the click looked dead; the panel now renders inside the decision region that owns the action buttons, and a Playwright regression test asserts the panel lands in that region and that the first click performs no write. Ships the pd-console fix inside the installer package (pd-console is private).
