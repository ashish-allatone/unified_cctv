import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ALL_ITEMS } from "../nav";

/** A page that has not been rebuilt in React yet: the legacy console runs inside an iframe (same origin, same session).
 * One iframe is kept for every legacy route; route changes are sent to it with postMessage so it never reloads. */
export default function LegacyView() {
  const { view = "overview" } = useParams();
  const nav = useNavigate();
  const { signOut } = useAuth();
  const frame = useRef<HTMLIFrameElement>(null);
  const initial = useRef(view);
  useEffect(() => {
    const w = frame.current?.contentWindow;
    if (w && view !== initial.current) w.postMessage({ type: "uvp:show", view }, location.origin);
  }, [view]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin || !e.data) return;
      if (e.data.type === "uvp:view" && e.data.view && e.data.view !== view) {
        const item = ALL_ITEMS.find((i) => i.view === e.data.view);
        if (item) nav(`/${e.data.view}`, { replace: true });
      }
      if (e.data.type === "uvp:logout") signOut();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [view, nav, signOut]);
  return <main className="view" style={{ padding: 0 }}><iframe ref={frame} className="legacy-frame" title={view} src={`/legacy/?embed=1#view=${initial.current}`} allow="autoplay; fullscreen; geolocation" /></main>;
}
