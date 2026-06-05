import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-sm)] text-[12.5px] font-medium transition-[border-color,background,color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-gov text-paper hover:bg-gov-2",
        destructive: "border border-danger/50 text-danger hover:bg-danger/10",
        outline: "border border-line bg-surface text-ink hover:border-line-2",
        secondary: "bg-surface text-ink-2 hover:bg-paper-2",
        ghost: "border border-gov/30 bg-transparent text-gov hover:bg-gov/5",
        quiet: "bg-transparent text-ink-3 hover:text-ink",
        link: "text-gov underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-[14px] py-1.5",
        sm: "h-7 px-3 text-[11px]",
        lg: "h-9 px-5",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
