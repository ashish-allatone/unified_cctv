import { useEffect, useState } from "react";

type Toast = { id: number; msg: string; kind?: "ok" | "err" | "warn" };
const listeners = new Set<(t: Toast) => void>();
let seq = 0;

export function toast(msg: string, kind?: Toast["kind"]) { const t = { id: ++seq, msg, kind }; listeners.forEach((fn) => fn(t)); }

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const fn = (t: Toast) => { setItems((xs) => [t, ...xs].slice(0, 5)); setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 4000); };
    listeners.add(fn); return () => { listeners.delete(fn); };
  }, []);
  return <div className="toasts" id="toasts">{items.map((t) => <div key={t.id} className="toast" style={{ gridTemplateColumns: "1fr", borderColor: t.kind === "ok" ? "var(--ok)" : t.kind === "err" ? "var(--bad)" : undefined }}>{t.msg}</div>)}</div>;
}
