import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Lang = "en" | "hi" | "gu";
type Dict = Record<string, string>;
const Ctx = createContext<{ lang: Lang; t: (k: string, fb?: string) => string; setLang: (l: Lang) => void }>({ lang: "en", t: (_k, fb) => fb || _k, setLang: () => {} });
const cache: Partial<Record<Lang, Dict>> = {};

async function load(l: Lang): Promise<Dict> {
  if (cache[l]) return cache[l]!;
  try { const d = await (await fetch(`/legacy/i18n/${l}.json`)).json(); cache[l] = d; return d; } catch { return {}; }
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => { try { return (localStorage.getItem("uvp-lang") as Lang) || "en"; } catch { return "en"; } });
  const [dict, setDict] = useState<Dict>({});
  useEffect(() => { load(lang).then(setDict); }, [lang]);
  const setLang = useCallback((l: Lang) => { setLangState(l); try { localStorage.setItem("uvp-lang", l); } catch { /* */ } }, []);
  const t = useCallback((k: string, fb?: string) => dict[k] || fb || k, [dict]);
  const value = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);
export const NEXT_LANG: Record<Lang, Lang> = { en: "hi", hi: "gu", gu: "en" };
export const LANG_LABEL: Record<Lang, string> = { en: "हिंदी", hi: "ગુજરાતી", gu: "EN" };
