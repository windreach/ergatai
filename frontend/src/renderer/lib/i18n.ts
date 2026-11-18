import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "../../locales/en.json"
import zhCN from "../../locales/zh-CN.json"
import { getStoredLanguagePreference, resolveLanguage } from "./language"

const initialLng = resolveLanguage(getStoredLanguagePreference())

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
    zh: { translation: zhCN },
  },
  lng: initialLng,
  fallbackLng: "en",
  supportedLngs: ["en", "zh", "zh-CN"],
  interpolation: {
    escapeValue: false,
  },
})

export default i18n
