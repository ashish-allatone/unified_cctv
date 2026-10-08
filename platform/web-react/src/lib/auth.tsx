import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, loadSession, saveSession, setUnauthorizedHandler, type Session, type User } from "./api";

type Auth = {
  session: Session | null; user: User | null;
  signIn: (s: Session) => void; signOut: () => void; refresh: () => Promise<void>;
  has: (feature: string) => boolean;
};
const Ctx = createContext<Auth>(null as any);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const signIn = useCallback((s: Session) => { saveSession(s); setSession(s); }, []);
  const signOut = useCallback(() => { saveSession(null); setSession(null); }, []);
  const refresh = useCallback(async () => {
    const s = loadSession(); if (!s) return;
    try { const me = await api<User>("/api/auth/me"); const next = { token: s.token, user: { ...s.user, ...me } }; saveSession(next); setSession(next); } catch { /* keep */ }
  }, []);
  useEffect(() => { setUnauthorizedHandler(signOut); }, [signOut]);
  useEffect(() => { if (session) { refresh(); const t = setInterval(refresh, 60000); return () => clearInterval(t); } }, [!!session]);   // eslint-disable-line react-hooks/exhaustive-deps
  const has = useCallback((f: string) => !!session?.user?.features?.includes(f), [session]);
  const value = useMemo(() => ({ session, user: session?.user || null, signIn, signOut, refresh, has }), [session, signIn, signOut, refresh, has]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);
