import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

export const languages = [
  { code: "zh-CN", label: "中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
] as const;

export type LanguageCode = (typeof languages)[number]["code"];

i18next.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    en: { translation: en },
    ja: { translation: ja },
  },
  lng: "zh-CN",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18next;
