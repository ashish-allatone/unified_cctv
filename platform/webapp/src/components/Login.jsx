import { useEffect, useRef, useState } from "react";
import { post, saveSession } from "../lib/api.js";
import { useI18n } from "../lib/i18n.jsx";
import { useUI } from "../lib/ui.jsx";
import ThemeToggle from "./ThemeToggle.jsx";

/* Sign-in: password -> optional MFA step (or enrolment) -> session. First run shows the super-admin sign-up. */
export default function Login({ init, onSignedIn }) {
  const { t } = useI18n();
  const { toast, modal } = useUI();
  const [step, setStep] = useState(init.mfaToken ? "mfa" : "login");   // login | mfa | enrol | setup
  const [error, setError] = useState(init.error || "");
  const [providers, setProviders] = useState({});
  const [rules, setRules] = useState("");
  const [enrol, setEnrol] = useState(null);
  const mfaToken = useRef(init.mfaToken || null);
  const form = useRef(null);

  useEffect(() => {
    fetch("/api/auth/providers").then((r) => r.json()).then((p) => {
      setProviders(p);
      if (p.needs_setup) {
        setStep("setup");
        fetch("/api/auth/setup").then((r) => r.json()).then((st) => setRules(st.password_rules || "")).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  const done = (j, extra) => { saveSession(j); onSignedIn(extra); };

  const login = async (ev) => {
    ev.preventDefault(); setError("");
    const f = form.current;
    try {
      const j = await post("/api/auth/login", { username: f.username.value, password: f.password.value });
      if (j.mfa_required) {
        mfaToken.current = j.mfa_token;
        if (j.enrol) { setEnrol(await post("/api/auth/mfa/enrol", {}, j.mfa_token)); setStep("enrol"); }
        else setStep("mfa");
        return;
      }
      if (j.mfa_enrol_required) toast(`Two-factor sign-in is required for your role: ${j.grace_left} sign-ins left before it is enforced. Use the 2FA button.`, "warn");
      done(j);
    } catch (e) { setError(e.message); }
  };
  const verify = async () => {
    setError("");
    try { done(await post("/api/auth/mfa/verify", { mfa_token: mfaToken.current, code: form.current.code.value })); }
    catch (e) { setError(e.message); }
  };
  const confirm = async () => {
    setError("");
    try {
      const j = await post("/api/auth/mfa/confirm", { code: form.current.enrol_code.value }, mfaToken.current);
      modal(<><h3>Two-factor sign-in enabled</h3><p>Backup codes (each works once; keep them safe):</p><pre>{j.backup_codes.join("\n")}</pre></>);
      done(j);
    } catch (e) { setError(e.message); toast(e.message, "err"); }
  };
  const signup = async () => {
    const f = form.current; setError("");
    if (f.su_password.value !== f.su_password2.value) { setError("passwords do not match"); return; }
    try {
      const j = await post("/api/auth/signup", { username: f.su_username.value.trim(), password: f.su_password.value });
      toast("Super admin created. Sign-up is now closed; add users from the Admin tab.", "ok");
      done(j, { offerMfa: !!j.mfa_setup_recommended });
    } catch (e) { setError(e.message); }
  };

  return (
    <section id="login" className="login">
      <div className="theme-corner"><ThemeToggle /></div>
      <form ref={form} id="login-form" className="login-card" onSubmit={step === "login" ? login : (e) => e.preventDefault()}>
        <div className="brand-lg"><img className="login-logo" src="/brand/logo.svg" alt="Allatone" /></div>
        <div className="brand-lg" style={{ marginTop: 2, justifyContent: "center", textAlign: "center" }}>
          <span>Unified CCTV <span className="muted" style={{ fontWeight: 500, fontSize: 15 }}>by Allatone</span></span>
        </div>
        <p className="muted" style={{ margin: "-6px 0 0" }}>{t("login.tag", "Command centre access to departmental CCTV feeds")}</p>

        {step === "setup" && <div>
          <p className="muted"><b>First run.</b> Create the administrator account. This account becomes the <b>super admin</b>: it creates every other user, and sign-up closes after it.</p>
          <label>Username <input name="su_username" autoComplete="username" placeholder="e.g. naresh" aria-label="Username" autoFocus /></label>
          <label>Password <input name="su_password" type="password" autoComplete="new-password" aria-label="Password" /></label>
          <label>Confirm password <input name="su_password2" type="password" autoComplete="new-password" aria-label="Confirm password" /></label>
          <p className="small muted">Password: {rules || "at least 10 characters, one uppercase letter, one digit"}</p>
          <button className="btn primary" type="button" onClick={signup}>Create super admin</button>
        </div>}

        {step === "login" && <div>
          <label><span>{t("login.user", "Username")}</span> <input name="username" autoComplete="username" required aria-label="Username" /></label>
          <label><span>{t("login.pass", "Password")}</span> <input name="password" type="password" autoComplete="current-password" required aria-label="Password" /></label>
          <button className="btn primary" type="submit">{t("btn.signin", "Sign in")}</button>
          {providers.oidc?.enabled && <a className="btn ghost" href="/api/auth/oidc/start">Sign in with {providers.oidc.name || "SSO"}</a>}
        </div>}

        {step === "mfa" && <div>
          <p className="muted">Enter the 6-digit code from your authenticator app (or a backup code).</p>
          <label>Code <input name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); verify(); } }} /></label>
          <button className="btn primary" type="button" onClick={verify}>Verify</button>
        </div>}

        {step === "enrol" && enrol && <div>
          <p className="muted">Your role requires two-factor sign-in. Scan this with Google/Microsoft Authenticator, then enter the code.</p>
          <img src={enrol.qr} alt="TOTP QR code" style={{ width: 180, height: 180, background: "#fff", borderRadius: 8, justifySelf: "center" }} />
          <p className="small muted">Manual key: <code>{enrol.secret}</code></p>
          <label>Code <input name="enrol_code" inputMode="numeric" autoComplete="one-time-code" /></label>
          <button className="btn primary" type="button" onClick={confirm}>Activate</button>
        </div>}

        <p className="error">{error}</p>
        {step === "login" && providers.yaml_users && <p className="muted small">Demo users (users.yaml, disabled once the first account is created): admin, supervisor, police_op, muni_op, viewer — password = name + 123, admin = admin123</p>}
      </form>
    </section>
  );
}
