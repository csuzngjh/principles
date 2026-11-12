import * as React from "react";
import { cn } from "../../../lib/utils.js";

/**
 * Static placeholder block. Deliberately NOT pulsing: an infinite animation on a
 * loading surface reads as "the machine is busy", which is exactly the pressure
 * the console is trying to remove (DESIGN_BRIEF D7). PageLoading explains the
 * wait in words instead.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
