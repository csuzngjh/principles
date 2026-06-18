import * as React from "react";
import { cn } from "../../../lib/utils.js";

interface PageShellProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

/**
 * 712px centered container — the "slow thinking" physical layout.
 * Blueprint grid background is on body (globals.css), this adds
 * the centered content column with generous whitespace.
 * Includes a subtle fade-in on mount for page transitions.
 */
export function PageShell({ children, className, ...props }: PageShellProps) {
  return (
    <div
      className={cn(
        "mx-auto max-w-[712px] px-6 py-8 animate-[pdFadeIn_200ms_ease-out]",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
