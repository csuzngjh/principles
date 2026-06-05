import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../../lib/utils.js";

const badgeVariants = cva(
  "inline-flex items-center rounded-[2px] px-2 py-0.5 font-mono text-[11px] tracking-[0.02em] font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "bg-gov/10 text-gov",
        secondary: "bg-surface text-ink-3 border border-line",
        destructive: "bg-danger/10 text-danger",
        outline: "border border-line text-ink-3",
        amber: "bg-amber/10 text-amber",
        green: "bg-green/10 text-green",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
