import { createContext, useCallback, useContext, useEffect, useState } from "react";
import en from "../locales/en.json";
import es from "../locales/es.json";

const translations = { en, es };
const STORAGE_KEY = "seanboost_lang";

const LanguageContext = createContext({
  lang: "en",
  setLang: () => {},
  t: (key) => key
});

function getNestedValue(obj, path) {
  const keys = path.split(".");
  let current = obj;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

function interpolate(template, vars) {
  if (!template || typeof template !== "string" || !vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? String(vars[key]) : match;
  });
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || "en";
    } catch {
      return "en";
    }
  });

  const setLang = useCallback((newLang) => {
    const validLang = newLang === "es" ? "es" : "en";
    setLangState(validLang);
    try {
      localStorage.setItem(STORAGE_KEY, validLang);
    } catch {
      // localStorage unavailable
    }
  }, []);

  // Load saved language from backend on mount
  useEffect(() => {
    const loadLang = async () => {
      try {
        const response = await fetch("/api/settings/language", {
          credentials: "include"
        });
        if (response.ok) {
          const data = await response.json();
          if (data?.language === "es" || data?.language === "en") {
            setLang(data.language);
          }
        }
      } catch {
        // use localStorage fallback
      }
    };
    loadLang();
  }, [setLang]);

  // Save to backend when language changes (after initial load)
  const saveLangToBackend = useCallback(async (newLang) => {
    try {
      await fetch("/api/settings/language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ language: newLang })
      });
    } catch {
      // silent fail — localStorage is the backup
    }
  }, []);

  const t = useCallback((key, vars) => {
    const value = getNestedValue(translations[lang], key);
    if (value !== undefined && typeof value === "string") {
      return vars ? interpolate(value, vars) : value;
    }
    // Fallback to English
    const fallback = getNestedValue(translations.en, key);
    if (fallback !== undefined && typeof fallback === "string") {
      return vars ? interpolate(fallback, vars) : fallback;
    }
    return key;
  }, [lang]);

  const handleSetLang = useCallback((newLang) => {
    setLang(newLang);
    saveLangToBackend(newLang);
  }, [setLang, saveLangToBackend]);

  return (
    <LanguageContext.Provider value={{ lang, setLang: handleSetLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
