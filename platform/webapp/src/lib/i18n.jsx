import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { store } from "./api.js";

/* en / hi / gu strings live in /i18n/<lang>.json (public/). */
export const LANGS = ["en", "hi", "gu"];
const current = { lang: "en", dict: {} };
/** Translate outside React (spoken alerts, toasts). */
export const tr = (k, fallback) => current.dict[k] || fallback || k;

const I18nCtx = createContext(null);

function initialLang() {
  const nav = navigator.language || "";
  return store.get("uvp-lang") || (nav.startsWith("hi") ? "hi" : nav.startsWith("gu") ? "gu" : "en");
}

export function I18nProvider({ children }) {
  const [state, setState] = useState({ lang: "en", dict: {} });

  const setLang = useCallback(async (lang) => {
    let next = { lang: "en", dict: {} };
    try { next = { lang, dict: await fetch(`/i18n/${lang}.json`).then((r) => r.json()) }; } catch (_) {}
    current.lang = next.lang; current.dict = next.dict;
    store.set("uvp-lang", next.lang);
    document.documentElement.lang = next.lang;
    setState(next);
  }, []);

  useEffect(() => { setLang(initialLang()); }, [setLang]);

  const t = useCallback((k, fallback) => state.dict[k] || fallback || k, [state.dict]);
  const cycleLang = () => setLang(LANGS[(LANGS.indexOf(state.lang) + 1) % LANGS.length]);
  return <I18nCtx.Provider value={{ lang: state.lang, t, setLang, cycleLang }}>{children}</I18nCtx.Provider>;
}

export const useI18n = () => useContext(I18nCtx);
