import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./zh-CN.json" with { type: "json" };
import en from "./en.json" with { type: "json" };

i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { common: zhCN.common, pages: zhCN.pages, components: zhCN.components },
    en: { common: en.common, pages: en.pages, components: en.components },
  },
  lng: typeof localStorage !== "undefined" ? (localStorage.getItem("pd-language") || "zh-CN") : "zh-CN",
  fallbackLng: "zh-CN",
  ns: ["common", "pages", "components"],
  defaultNS: "common",
  interpolation: { escapeValue: false },
});

export default i18n;
