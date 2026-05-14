import * as React from "react";
import { cn } from "../../../lib/utils.js";

const Separator = React.forwardRef<
  HTMLHRElement,
  React.HTMLAttributes<HTMLHRElement>
>(({ className, ...props }, ref) => (
  <hr
    ref={ref}
    className={cn("border-border bg-border", className)}
    {...props}
  />
));
Separator.displayName = "Separator";

export { Separator };
