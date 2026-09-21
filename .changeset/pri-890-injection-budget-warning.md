---
'@principles/pd-console': patch
---

PRI-890: approve now recomputes the production prompt injection projection (same FIFO + 2000-char budget logic the prompt hook uses) and surfaces a non-fatal warning when the freshly approved prompt-channel activation lands outside the budget — previously the approval silently never reached agent behavior when the budget was saturated (PRI-768 v6-02). Non-budget exclusions (artifact resolution failures) are reported with their own reason code, and the Governance Focus approve flow shows the warning toast so the Owner sees it at decision time.
