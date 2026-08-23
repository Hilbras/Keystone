import { useCallback, useEffect, useState } from "react";
import en from "./en.json";
import ar from "./ar.json";

export type Language = "en" | "ar";

const STORAGE_KEY = "keystone-lang";

const dictionaries: Record<Language, Record<string, string>> = { en, ar };

export const LANGUAGES: Array<{ code: Language; label: string }> = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
];

export function getLanguage(): Language {
  if (typeof window === "undefined") return "en";
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "ar" ? "ar" : "en";
}

export function setLanguage(lang: Language): void {
  localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
}

export function translate(lang: Language, key: string): string {
  return dictionaries[lang]?.[key] ?? dictionaries.en[key] ?? key;
}

/**
 * Dashboard i18n hook. `t("nav.users")` returns the string in the active
 * language, falling back to English and then to the key itself.
 */
export function useTranslation(): { lang: Language; t: (key: string) => string; changeLanguage: (lang: Language) => void } {
  const [lang, setLang] = useState<Language>(getLanguage);

  useEffect(() => {
    setLanguage(lang);
  }, [lang]);

  const t = useCallback((key: string) => translate(lang, key), [lang]);
  const changeLanguage = useCallback((next: Language) => setLang(next), []);

  return { lang, t, changeLanguage };
}
