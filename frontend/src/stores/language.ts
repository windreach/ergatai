import { create } from "zustand";
import i18next from "i18next";
import type { LanguageCode } from "@/i18n";

interface LanguageState {
  lang: LanguageCode;
  setLanguage: (code: LanguageCode) => void;
}

const STORAGE_KEY = "ergatai-lang";

function detect(): LanguageCode {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "zh-CN" || saved === "en" || saved === "ja") return saved;
  const browser = navigator.language;
  if (browser.startsWith("ja")) return "ja";
  if (browser.startsWith("zh")) return "zh-CN";
  return "en";
}

export const useLanguageStore = create<LanguageState>((set) => {
  const initial = detect();
  i18next.changeLanguage(initial);
  return {
    lang: initial,
    setLanguage: (code) => {
      i18next.changeLanguage(code);
      localStorage.setItem(STORAGE_KEY, code);
      set({ lang: code });
    },
  };
});
