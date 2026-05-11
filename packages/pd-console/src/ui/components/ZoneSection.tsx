import type { ReactNode } from "react";
import { ZONE_SECTION, ZONE_HEADER_BASE, COUNT_BADGE, EMPTY_STATE, ZONE_BODY } from "../styles/constants.js";

interface ZoneSectionProps {
  title: string;
  count: number;
  bgColor: string;
  borderColor: string;
  headerBgColor: string;
  children: ReactNode;
}

export function ZoneSection({ title, count, bgColor, borderColor, headerBgColor, children }: ZoneSectionProps) {
  return (
    <div style={{ ...ZONE_SECTION, border: `1px solid ${borderColor}`, backgroundColor: bgColor }}>
      <div style={{ ...ZONE_HEADER_BASE, backgroundColor: headerBgColor, borderBottom: `1px solid ${borderColor}` }}>
        <span>{title}</span>
        <span style={COUNT_BADGE}>{count}</span>
      </div>
      {count === 0 ? (
        <div style={EMPTY_STATE}>暂无事项</div>
      ) : (
        <div style={ZONE_BODY}>{children}</div>
      )}
    </div>
  );
}
