import * as React from "react";

/**
 * Narrow-viewport field label for tables that collapse into stacked blocks.
 *
 * Desktop tables get their labels from a single header row; the stacked layout
 * has to repeat them per row, so the label is only rendered below `md` and is
 * hidden again as soon as the real column header appears.
 */
export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 font-mono text-caption uppercase tracking-[0.08em] text-ink-4 md:hidden">
      {children}
    </span>
  );
}
