import * as React from "react";

/**
 * Splash screen — 1-2s loading transition (C.0).
 * Shows threshold mark + "PD" + "GOVERNANCE WORKSPACE" + progress bar.
 * Auto-redirects after animation completes.
 */
export function SplashScreen({ onComplete }: { onComplete: () => void }) {
  React.useEffect(() => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timeout = prefersReducedMotion ? 100 : 2200;
    const timer = setTimeout(onComplete, timeout);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center bg-paper"
      style={{
        backgroundImage: `linear-gradient(color-mix(in srgb, var(--color-gov) 3.5%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--color-gov) 3.5%, transparent) 1px, transparent 1px)`,
        backgroundSize: "32px 32px",
      }}
    >
      <svg
        viewBox="0 0 28 28"
        className="w-16 h-16 text-gov animate-[fadeIn_200ms_ease-out]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M6 4V24M22 4V24M2 14H26" strokeLinecap="square" />
        <circle cx="14" cy="14" r="2.5" fill="currentColor" stroke="none" />
      </svg>
      <div className="mt-6 font-mono text-[14px] tracking-[0.16em] font-bold text-ink animate-[fadeIn_500ms_ease-out_200ms_both]">
        PD
      </div>
      <div className="mt-2 font-mono text-[11px] tracking-[0.14em] text-ink-3 animate-[fadeIn_500ms_ease-out_400ms_both]">
        GOVERNANCE WORKSPACE
      </div>
      <div className="mt-8 w-48 h-1 bg-line rounded-full overflow-hidden animate-[fadeIn_500ms_ease-out_600ms_both]">
        <div className="h-full bg-gov rounded-full animate-[progressFill_600ms_ease-out_1.2s_both]" />
      </div>
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes progressFill { from { width: 0; } to { width: 100%; } }
      `}</style>
    </div>
  );
}
