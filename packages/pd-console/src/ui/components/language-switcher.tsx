import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button.js";

const LANGUAGES = [
  { code: "zh-CN", label: "中文", englishLabel: "Chinese" },
  { code: "en", label: "English", englishLabel: "English" },
];

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const currentLang = LANGUAGES.find((lang) => lang.code === i18n.language);

  const toggleLanguage = () => {
    const nextLang =
      i18n.language === "zh-CN" ? "en" : "zh-CN";
    i18n.changeLanguage(nextLang);
    localStorage.setItem("pd-language", nextLang);
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggleLanguage}
      className="min-w-[70px]"
    >
      {currentLang?.label}
    </Button>
  );
}
