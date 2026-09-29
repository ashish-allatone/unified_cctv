import { useCallback, useEffect, useState } from "react";
import { api, clearSession, loadSession, saveSession, session } from "./lib/api.js";
import { UIHosts } from "./lib/ui.jsx";
import Login from "./components/Login.jsx";
import Console from "./components/Console.jsx";
import { AppProvider } from "./context/AppContext.jsx";

export default function App() {
  // "boot" until we know whether a session exists; then "login" or "app"
  const [phase, setPhase] = useState("boot");
  const [loginInit, setLoginInit] = useState({});
  const [offerMfa, setOfferMfa] = useState(false);

  useEffect(() => {
    // SSO return: /#sso=<token> (session) or /#mfa=<step token>; errors as /#sso_error=<code>
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("sso")) {
      history.replaceState(null, "", "/");
      session.token = h.get("sso");
      api("/api/me").then((u) => { saveSession({ token: session.token, user: u }); setPhase("app"); }).catch(() => setPhase("login"));
      return;
    }
    if (h.get("mfa")) { history.replaceState(null, "", "/"); setLoginInit({ mfaToken: h.get("mfa") }); setPhase("login"); return; }
    if (h.get("sso_error")) { history.replaceState(null, "", "/"); setLoginInit({ error: `SSO sign-in failed (${h.get("sso_error")})` }); }
    setPhase(loadSession() ? "app" : "login");
  }, []);

  const logout = useCallback(() => { clearSession(); location.reload(); }, []);

  if (phase === "boot") return null;
  return <>
    <a href="#main-content" className="skip-link">Skip to content</a>
    {phase === "login"
      ? <><Login init={loginInit} onSignedIn={(extra) => { setOfferMfa(!!extra?.offerMfa); setPhase("app"); }} /><UIHosts /></>
      : <AppProvider onLogout={logout}><Console offerMfa={offerMfa} /><UIHosts /></AppProvider>}
  </>;
}
