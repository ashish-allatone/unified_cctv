import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useAuth } from "./auth";

type Msg = { type: string; [k: string]: any };
type Ws = { connected: boolean; subscribe: (fn: (m: Msg) => void) => () => void };
const Ctx = createContext<Ws>({ connected: false, subscribe: () => () => {} });

/** One WebSocket to /ws/alerts for the whole app; pages subscribe to the messages they care about. */
export function WsProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const [connected, setConnected] = useState(false);
  const subs = useRef(new Set<(m: Msg) => void>());
  useEffect(() => {
    if (!session) return;
    let ws: WebSocket | null = null, timer: any, closed = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/alerts?token=${encodeURIComponent(session.token)}`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => { try { const m = JSON.parse(e.data); subs.current.forEach((fn) => fn(m)); } catch { /* */ } };
      ws.onclose = () => { setConnected(false); if (!closed) timer = setTimeout(connect, 3000); };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => { closed = true; clearTimeout(timer); ws?.close(); };
  }, [session?.token]);   // eslint-disable-line react-hooks/exhaustive-deps
  const subscribe = (fn: (m: Msg) => void) => { subs.current.add(fn); return () => { subs.current.delete(fn); }; };
  return <Ctx.Provider value={{ connected, subscribe }}>{children}</Ctx.Provider>;
}
export const useWs = () => useContext(Ctx);
export function useWsMessage(type: string, fn: (m: Msg) => void) {
  const { subscribe } = useWs();
  useEffect(() => subscribe((m) => { if (m.type === type) fn(m); }), [type, fn, subscribe]);
}
