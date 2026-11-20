import * as React from "react";
import { cn } from "../../../lib/utils.js";

/**
 * PageShell — the centered content column.
 *
 * Width is a property of the content's JOB, not of the window (DESIGN_BRIEF D20,
 * §5.4). Prose stays at a reading width; only tables/status grids are allowed to
 * spend horizontal space on more information.
 *
 * | width     | used by                                   | 1366 | 1440–1920 | 2560 | 3840 |
 * |-----------|-------------------------------------------|------|-----------|------|------|
 * | reading   | review card, settings prose               | 712  | 712       | 712  | 712  |
 * | standard  | lists that read line-by-line              | 960  | 960       | 1120 | 1120 |
 * | wide      | workbench / dashboards                    | 1120 | 1120      | 1360 | 1360 |
 * | table     | failed tasks, activation, evidence tables | 1200 | 1200/1440 | 1440 | 1760 |
 * | dashboard | status dashboards (ingestion, control)    | 1120 | 1120      | 1360 | 1456 |
 *
 * `dashboard` adds one SHARED CSS step beyond `wide`: on a large viewport with a
 * tall window (`.page-shell-dashboard` in globals.css, the same 91rem step the
 * principle library takes) the shell grows to 1456px, so a 4K screen spends the
 * extra room on the page's internal multi-column grids — never on longer lines.
 * New data/dashboard pages opt in with `width="dashboard"` alone; do NOT add a
 * page-scoped width class (that mechanism is retired here — page classes like
 * `.principle-library` remain page-LAYOUT systems, not width overrides).
 *
 * 4K rule: the column caps grow in steps and the extra room becomes more
 * columns or more whitespace — never a longer line of text. Font size never
 * scales with resolution, so the reading measure stays 640–760px at every
 * width.
 */
export type PageShellWidth = "reading" | "standard" | "wide" | "table" | "dashboard";

const WIDTH_CLASS: Record<PageShellWidth, string> = {
  reading: "max-w-[744px]",
  standard: "max-w-[960px] 4xl:max-w-[1120px]",
  wide: "max-w-[1120px] 4xl:max-w-[1360px]",
  table: "max-w-[1200px] 3xl:max-w-[1440px] 4xl:max-w-[1760px]",
  dashboard: "max-w-[1120px] 4xl:max-w-[1360px] page-shell-dashboard",
};

interface PageShellProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  /** Content measure. Defaults to the reading column. */
  width?: PageShellWidth;
}

export function PageShell({ children, className, width = "reading", ...props }: PageShellProps) {
  return (
    <div
      className={cn("mx-auto px-6 py-8 3xl:px-10 3xl:py-12", WIDTH_CLASS[width], className)}
      {...props}
    >
      {children}
    </div>
  );
}
