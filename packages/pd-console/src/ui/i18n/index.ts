import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./zh-CN.json" with { type: "json" };
import en from "./en.json" with { type: "json" };

const getInitialLanguage = (): string => {
  if (typeof window === "undefined") return "zh-CN";
  return localStorage.getItem("pd-language") || "zh-CN";
};

// SPEC-PD-UIUX-001 R6: keep the document language in sync with the UI language
// on first load AND on every switch, so assistive tech reads English pages with
// an English voice. Persistence stays in localStorage via the existing switcher.
function applyDocumentLanguage(lng: string): void {
  if (typeof document === "undefined") return;
  // eslint-disable-next-line no-undef
  document.documentElement.lang = lng.toLowerCase();
}

i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { common: zhCN, pages: zhCN.pages, components: zhCN.components },
    en: { common: en, pages: en.pages, components: en.components },
  },
  lng: getInitialLanguage(),
  fallbackLng: "zh-CN",
  ns: ["common", "pages", "components"],
  defaultNS: "common",
  interpolation: { escapeValue: false },
});

applyDocumentLanguage(i18n.language ?? "zh-CN");
i18n.on("languageChanged", applyDocumentLanguage);

export default i18n;
