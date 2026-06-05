import * as React from "react";
import { cn } from "../../../lib/utils.js";

interface SectionTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  children: React.ReactNode;
}

/**
 * 11px uppercase monospace section title with bottom border (B.4.6).
 * Used for governance page section headings.
 */
export function SectionTitle({ children, className, ...props }: SectionTitleProps) {
  return (
    <h2
      className={cn(
        "font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3",
        "border-b border-line pb-2 mb-4",
        className
      )}
      {...props}
    >
      {children}
    </h2>
  );
}
