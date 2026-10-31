<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-175",
  "displayId": "ERR-175",
  "title": "Owner-visible text truncated by UTF-16 code units splits surrogate pairs and renders U+FFFD",
  "status": "active",
  "category": "Missing Tests & Verification",
  "ep": "EP-11",
  "createdAt": "2026-10-31",
  "source": "PR #2238 review (SPEC-PD-CONSOLE-READABILITY-002 slice 1 follow-up)"
}
-->

**[ERR-175]** | Owner-visible text truncated by UTF-16 code units splits surrogate pairs and renders U+FFFD

- **What happened**: The console showed a replacement character (`�`) in the Owner workbench because preview strings were shortened with `String.prototype.slice(0, N)`. `slice` counts UTF-16 code units, so cutting a supplementary character (emoji, CJK Ext-B) at the boundary leaves a lone surrogate, which the browser renders as U+FFFD. An earlier readability fix (SPEC-PD-CONSOLE-READABILITY-002 slice 1, PR #2042) introduced a code-point-safe helper, but kept it private and wired it into a single title preview. Three more user-visible sites still truncated by code units: `ApprovalSubjectReading` (`bodyText.slice(0, 240)`), `PrincipleDetailPage` (`learnedText.slice(0, 240)`), and the `PrinciplesPage` list fallback title (`p.text.slice(0, 80)`). PR #2238 finally replaced all three with the exported `truncateByCodePoints`.
- **Why it's wrong**: The Owner's own governance surface is where text is read most carefully. A corrupted character is not cosmetic noise: it makes the displayed rule look damaged, undermines trust in what was approved, and is sticky — it reappears on every new preview surface that reaches for `slice`. The slice-1 guard did not stop the recurrence because it asserted the absence of the literal U+FFFD inside a few source strings (and explicitly excluded comments), not the runtime behavior of the truncation helper; and because the helper was private, each new surface re-implemented truncation instead of reusing it.
- **Generalized failure mode**: Owner-visible text is shortened with a UTF-16 code-unit API (`slice` / `substring` / `substr`) instead of by code points, so a supplementary character at the cut boundary becomes a lone surrogate and renders as U+FFFD.
- **Correct approach**: Truncate Owner-visible text by code points (`Array.from(text)`), through the single shared helper `truncateByCodePoints(text, max)` in `packages/pd-console/src/ui/utils/reading-layout.ts`. Never use `slice` / `substring` / `substr` on text for display bounds; keep `slice` for arrays.
- **How to prevent**: `check:runtime-contract` enforces ERR-175 on the console UI surface (`packages/pd-console/src/ui/**`, `.ts`/`.tsx`) for added/modified PR lines: `.substring(0, …)` / `.substr(0, …)` are flagged unconditionally, and `.slice(0, …)` is flagged when the receiver's trailing camelCase segment names text (`text`, `body`, `title`, `preview`, `reason`, `message`, …) so array slicing such as `items.slice(0, 10)` stays clean. Line-scoped exemptions accept `//`, block, and JSX comment forms for the cases where a text-shaped identifier provably contains only ASCII. The rule ships with its negative control: the three pre-fix expressions from PR #2238 must be flagged, and the fixed helper call must not be.
- **Regression guard**: `scripts/check-runtime-contract.js` (rule ERR-175, path-scoped) + `scripts/__tests__/check-runtime-contract.test.ts` (pre-fix negative controls, array/`Array.from` positive controls, path scope, JSX exemption).
- **Source**: PR #2238 review (SPEC-PD-CONSOLE-READABILITY-002 slice 1 follow-up); first report after PR #2042.
- **Date**: 2026-10-31
- **Recurrence**: The symptom was reported twice (slice 1 fix in PR #2042, then again on PR #2238) because the first fix covered one surface and the guard asserted literals rather than the behavior.
