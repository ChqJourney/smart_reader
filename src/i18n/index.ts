import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "../locales/zh-CN.json";
import en from "../locales/en.json";

export const resources = {
  "zh-CN": { translation: zhCN },
  en: { translation: en },
} as const;

i18n.use(initReactI18next).init({
  resources,
  lng: "zh-CN",
  fallbackLng: "zh-CN",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
