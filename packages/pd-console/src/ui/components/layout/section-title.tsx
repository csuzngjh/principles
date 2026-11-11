import * as React from "react";
import { cn } from "../../../lib/utils.js";

interface SectionTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  children: React.ReactNode;
}

/**
 * Page-level 11px uppercase monospace eyebrow (B.4.6, §3.1 `text-eyebrow`).
 * Used for governance page section headings.
 */
export function SectionTitle({ children, className, ...props }: SectionTitleProps) {
  return (
    <h2
      className={cn(
        "font-mono text-eyebrow uppercase tracking-[var(--tracking-wide)] text-ink-3",
        "border-b border-line pb-2 mb-4",
        className
      )}
      {...props}
    >
      {children}
    </h2>
  );
}
