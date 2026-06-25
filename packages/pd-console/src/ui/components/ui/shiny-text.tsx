import { useEffect, useState, type ElementType, type ReactNode } from "react";

export interface ShinyTextProps {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  /** Animation duration in seconds (default: 4) */
  duration?: number;
  /** Brightness of the shine effect (0.0-1.0, default: 0.6) */
  brightness?: number;
  /**
   * Underlying element to render. Defaults to "span". Use "h1" (etc.) when
   * wrapping a page title so heading semantics are preserved for assistive
   * tech — the shimmer is a visual effect, not a structural change.
   */
  as?: ElementType;
}

/**
 * ShinyText - A subtle shimmer animation for page titles
 *
 * Uses CSS gradient mask to create a gentle light sweep effect across text.
 * Respects prefers-reduced-motion accessibility preference.
 *
 * @example
 * <ShinyText as="h1" duration={4} brightness={0.6}>
 *   现在，值得你判断的事
 * </ShinyText>
 */
export function ShinyText({
  children,
  className = "",
  disabled = false,
  duration = 4,
  brightness = 0.6,
  as: Component = "span",
}: ShinyTextProps) {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    // Check for reduced motion preference
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);

    // Listen for changes
    const handleChange = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Disable animation if user prefers reduced motion or explicitly disabled
  const isDisabled = disabled || prefersReducedMotion;

  if (isDisabled) {
    return <Component className={className}>{children}</Component>;
  }

  const style: React.CSSProperties = {
    background: `linear-gradient(
      110deg,
      currentColor 45%,
      rgba(255, 255, 255, ${brightness}) 50%,
      currentColor 55%
    )`,
    backgroundSize: "200% 100%",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    WebkitTextFillColor: "transparent",
    animation: `shimmer ${duration}s linear infinite`,
  };

  return (
    <Component className={className} style={style}>
      {children}
    </Component>
  );
}
