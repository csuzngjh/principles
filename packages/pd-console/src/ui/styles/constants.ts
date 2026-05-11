import type { CSSProperties } from "react";

export const COLORS = {
  zoneRed: "#fff2f0",
  zoneRedBorder: "#ffccc7",
  zoneRedHeaderBg: "#fff1f0",
  zoneYellow: "#fffbe6",
  zoneYellowBorder: "#ffe58f",
  zoneYellowHeaderBg: "#fffbe6",
  zoneWhite: "#ffffff",
  zoneWhiteBorder: "#f0f0f0",
  zoneWhiteHeaderBg: "#fafafa",
  primary: "#1677ff",
  danger: "#ff4d4f",
  success: "#52c41a",
  warning: "#faad14",
  textPrimary: "#333333",
  textSecondary: "#666666",
  textMuted: "#999999",
} as const;

export const SHADOW_CARD: CSSProperties = {
  border: "1px solid #f0f0f0",
  borderRadius: "8px",
  padding: "16px",
  marginBottom: "12px",
  backgroundColor: "#ffffff",
  transition: "box-shadow 0.2s ease",
};

export const ZONE_SECTION: CSSProperties = {
  borderRadius: "8px",
  marginBottom: "24px",
  overflow: "hidden",
};

export const ZONE_HEADER_BASE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "12px 16px",
  fontWeight: 600,
  fontSize: "15px",
};

export const COUNT_BADGE: CSSProperties = {
  backgroundColor: "rgba(0,0,0,0.06)",
  borderRadius: "10px",
  padding: "2px 10px",
  fontSize: "13px",
  fontWeight: 500,
  color: "#666",
};

export const EMPTY_STATE: CSSProperties = {
  padding: "24px 16px",
  textAlign: "center",
  color: "#999",
  fontSize: "14px",
};

export const CARD_HEADER: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  cursor: "pointer",
  userSelect: "none",
};

export const EXPAND_ARROW: CSSProperties = {
  fontSize: "12px",
  color: "#999",
  transition: "transform 0.3s ease",
};

export const COLLAPSED_WRAPPER: CSSProperties = {
  display: "grid",
  gridTemplateRows: "0fr",
  transition: "grid-template-rows 0.3s ease",
};

export const EXPANDED_WRAPPER: CSSProperties = {
  display: "grid",
  gridTemplateRows: "1fr",
  transition: "grid-template-rows 0.3s ease",
};

export const OVERFLOW_HIDDEN: CSSProperties = {
  overflow: "hidden",
};

const BUTTON_BASE: CSSProperties = {
  border: "none",
  borderRadius: "6px",
  padding: "6px 16px",
  fontSize: "13px",
  cursor: "pointer",
  fontWeight: 500,
  transition: "opacity 0.2s ease",
};

export const BUTTON_APPROVE: CSSProperties = {
  ...BUTTON_BASE,
  backgroundColor: "#1677ff",
  color: "#ffffff",
};

export const BUTTON_REJECT: CSSProperties = {
  ...BUTTON_BASE,
  backgroundColor: "#ffffff",
  color: "#ff4d4f",
  border: "1px solid #ffccc7",
};

export const BUTTON_CLEANUP: CSSProperties = {
  ...BUTTON_BASE,
  backgroundColor: "#ffffff",
  color: "#faad14",
  border: "1px solid #ffe58f",
};

export const ZONE_BODY: CSSProperties = {
  padding: "12px 16px",
};

export const LOADING_STYLE: CSSProperties = {
  padding: "40px",
  textAlign: "center",
  color: "#999",
};

export const ERROR_STYLE: CSSProperties = {
  padding: "24px",
  textAlign: "center",
  color: "#ff4d4f",
  backgroundColor: "#fff2f0",
  borderRadius: "8px",
};

export const REFRESH_BAR: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "20px",
};
