import { useEffect, useState } from "react";
import { post, type Session } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { getTheme, toggleTheme } from "../lib/theme";

type Step = "password" | "mfa" | "enrol" | "setup";

/** Sign-in card: password -> optional 2FA code (or first-time 2FA enrolment) -> session; first run shows the super-admin sign-up. */
export default function Login() {
  const { signIn } = useAuth();
  const { t } = useI18n();
  const [step, setStep] = useState<Step>("password");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState("");
  const [enrol, setEnrol] = useState<{ qr: string; secret: string } | null>(null);
  const [providers, setProviders] = useState<any>({});
  const [rules, setRules] = useState("at least 10 characters, one uppercase letter, one digit");
  const [theme, setTheme] = useState(getTheme());

  useEffect(() => {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("sso")) { history.replaceState(null, "", "/"); const tok = h.get("sso")!; fetch("/api/auth/me", { headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.json()).then((u) => signIn({ token: tok, user: u })); return; }
    if (h.get("mfa")) { history.replaceState(null, "", "/"); setMfaToken(h.get("mfa")!); setStep("mfa"); }
    if (h.get("sso_error")) { history.replaceState(null, "", "/"); setErr(`SSO sign-in failed (${h.get("sso_error")})`); }
    fetch("/api/auth/providers").then((r) => r.json()).then(async (p) => {
      setProviders(p);
      if (p.needs_setup) { setStep("setup"); try { const st = await (await fetch("/api/auth/setup")).json(); if (st.password_rules) setRules(st.password_rules); } catch { /* */ } }
    }).catch(() => {});
  }, [signIn]);

  const run = async (fn: () => Promise<void>) => { setErr(""); setBusy(true); try { await fn(); } catch (e: any) { setErr(e.message || "failed"); } finally { setBusy(false); } };

  const login = (f: HTMLFormElement) => run(async () => {
    const fd = new FormData(f);
    const j = await post("/api/auth/login", { username: fd.get("username"), password: fd.get("password") });
    if (j.mfa_required) { setMfaToken(j.mfa_token); if (j.enrol) { setEnrol(await post("/api/auth/mfa/enrol", {}, j.mfa_token)); setStep("enrol"); } else setStep("mfa"); return; }
    signIn(j as Session);
  });
  const verify = (code: string) => run(async () => { signIn(await post("/api/auth/mfa/verify", { mfa_token: mfaToken, code })); });
  const confirmEnrol = (code: string) => run(async () => { signIn(await post("/api/auth/mfa/confirm", { code }, mfaToken)); });
  const signup = (f: HTMLFormElement) => run(async () => {
    const fd = new FormData(f);
    const j = await post("/api/auth/signup", { username: String(fd.get("su_username") || "").trim(), password: fd.get("su_password") });
    signIn(j as Session);
  });

  return (
    <section id="login" className="login">
      <div className="theme-corner"><button className="btn ghost icon" type="button" title="Switch theme" onClick={() => setTheme(toggleTheme())}>{theme === "dark" ? "☀" : "☾"}</button></div>
      <form id="login-form" className="login-card" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget; if (step === "password") login(f); else if (step === "setup") signup(f); else if (step === "mfa") verify((f.elements.namedItem("code") as HTMLInputElement).value); else confirmEnrol((f.elements.namedItem("enrol_code") as HTMLInputElement).value); }}>
        <div className="brand-lg"><img className="login-logo" src="/legacy/brand/logo.svg" alt="Allatone" /></div>
        <div className="brand-lg" style={{ marginTop: 2, justifyContent: "center", textAlign: "center" }}><span>Unified CCTV <span className="muted" style={{ fontWeight: 500, fontSize: 15 }}>by Allatone</span></span></div>
        <p className="muted" style={{ margin: "-6px 0 0" }}>{t("login.tag", "Command centre access to departmental CCTV feeds")}</p>

        {step === "setup" && (
          <div>
            <p className="muted"><b>First run.</b> Create the administrator account. This account becomes the <b>super admin</b>: it creates every other user, and sign-up closes after it.</p>
            <label>Username <input name="su_username" autoComplete="username" placeholder="e.g. naresh" autoFocus /></label>
            <label>Password <input name="su_password" type="password" autoComplete="new-password" /></label>
            <p className="small muted">Password: {rules}</p>
            <button className="btn primary" disabled={busy}>Create super admin</button>
          </div>
        )}
        {step === "password" && (
          <div>
            <label>{t("login.user", "Username")} <input name="username" autoComplete="username" required autoFocus /></label>
            <label>{t("login.pass", "Password")} <input name="password" type="password" autoComplete="current-password" required /></label>
            <button className="btn primary" disabled={busy}>{busy ? "…" : t("login.btn", "Sign in")}</button>
            {providers?.oidc?.enabled && <a className="btn ghost" href="/api/auth/oidc/start">Sign in with {providers.oidc.name}</a>}
            {providers?.yaml_users && <p className="small muted">Demo accounts: admin / admin123 · supervisor / super123 · viewer / viewer123</p>}
          </div>
        )}
        {step === "mfa" && (
          <div>
            <p className="muted">Enter the 6-digit code from your authenticator app.</p>
            <label>Code <input name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus /></label>
            <button className="btn primary" disabled={busy}>Verify</button>
            <button className="btn ghost" type="button" onClick={() => setStep("password")}>Back</button>
          </div>
        )}
        {step === "enrol" && enrol && (
          <div>
            <p className="muted">Two-factor sign-in is required for your role. Scan this code with Google Authenticator / Microsoft Authenticator, then enter the 6-digit code.</p>
            <img src={enrol.qr} alt="QR" style={{ width: 180, margin: "0 auto", background: "#fff", padding: 6, borderRadius: 8 }} />
            <p className="small muted">Secret: <code>{enrol.secret}</code></p>
            <label>Code <input name="enrol_code" inputMode="numeric" required autoFocus /></label>
            <button className="btn primary" disabled={busy}>Activate</button>
          </div>
        )}
        {err && <div className="inline-err" role="alert">{err}</div>}
      </form>
    </section>
  );
}
