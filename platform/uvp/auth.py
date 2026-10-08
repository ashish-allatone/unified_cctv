"""Identity, sessions and MFA.

Providers (config/auth.yaml): local users.yaml, LDAP / Active Directory, OpenID Connect.
Sessions are JWTs (HS256, TOKEN_SECRET) carrying the user's *effective* access (role, features,
departments, camera grants, break-glass state) so that every service can authorise without a
database round trip; grants therefore take effect at the next login or token refresh.

MFA: TOTP (RFC 6238) with hashed one-time backup codes. Roles listed in mfa.required_roles
must enrol; an OIDC token whose `amr` claim contains "mfa" satisfies the requirement.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import json
import logging
import secrets
import time
from dataclasses import dataclass, field

import jwt

from . import rbac
from .config import load_yaml, settings

log = logging.getLogger("uvp.auth")
ROLE_RANK = rbac.ROLE_RANK


def auth_cfg() -> dict:
    return load_yaml(settings.auth_file) or {}


# ----------------------------------------------------------------------------- user model
@dataclass
class User:
    username: str
    role: str
    departments: list[str]                     # ["*"] = all
    features: list[str] = field(default_factory=list)
    cameras: list[str] = field(default_factory=list)   # explicit camera grants beyond departments
    mfa: bool = False                          # this session passed MFA
    break_glass: str | None = None             # grant id when elevated
    provider: str = "local"
    tenant: str = ""
    is_super: bool = False                     # super admin: may create / remove console accounts
    grant_features: list[str] = field(default_factory=list)   # features that came from time-bound grants (not the role)
    base_departments: list[str] | None = None  # departments / cameras from the account itself (before permission rows)
    base_cameras: list[str] | None = None
    camera_perms: dict = field(default_factory=dict)          # Admin -> Permissions rows in force: {camera|dept:X|*: [perms]}

    def can(self, role: str) -> bool:          # legacy role ladder (custom roles rank by what they may do)
        return rbac.role_rank(self.role) >= ROLE_RANK[role]

    def has(self, feature: str) -> bool:
        return feature in self.features or (not self.features and feature in rbac.role_features(self.role))

    def sees(self, department: str) -> bool:
        return "*" in self.departments or department in self.departments

    def sees_camera(self, camera_id: str, department: str) -> bool:
        return self.sees(department) or camera_id in self.cameras

    def allows(self, camera_id: str, department: str, perm: str) -> bool:
        """May this account do `perm` (live / playback / export / search / alerts / edit) on this camera?
        Cameras the account sees on its own (role departments, explicit camera list) allow everything the role
        allows, as before; cameras it sees only through Admin -> Permissions rows allow exactly those rows' perms."""
        if not self.sees_camera(camera_id, department):
            return False
        bd = self.base_departments if self.base_departments is not None else self.departments
        bc = self.base_cameras if self.base_cameras is not None else self.cameras
        if "*" in bd or department in bd or camera_id in bc:
            return True
        from . import camperms
        return camperms.allows(self.camera_perms, camera_id, department, perm)


# ----------------------------------------------------------------------------- password + local users
def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(8)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()
    return f"pbkdf2${salt}${dk}"


def _verify(password: str, stored: str) -> bool:
    try:
        _, salt, _dk = stored.split("$")
    except ValueError:
        return False
    return hmac.compare_digest(hash_password(password, salt), stored)


def _users() -> dict:
    return {u["username"]: u for u in load_yaml(settings.users_file).get("users", [])}


def _local(username: str, password: str) -> User | None:
    u = _users().get(username)
    if not u or not _verify(password, u.get("password_hash", "")):
        return None
    return User(username, u.get("role", "viewer"), u.get("departments", ["*"]), cameras=u.get("cameras", []),
                provider="local", tenant=u.get("tenant", ""))


# ----------------------------------------------------------------------------- database users (provider "db")
import re as _re

USERNAME_RE = _re.compile(r"^[a-z0-9][a-z0-9._@-]{2,63}$")
MIN_PASSWORD_LEN = 10


class AccountError(ValueError):
    """Validation error for account management (message is safe to show to the caller)."""


def db_users_exist(session) -> bool:
    """Is there at least one password account (provider 'db')? Directory / demo rows do not count."""
    from sqlalchemy import select
    from .db import Users
    return session.scalar(select(Users.username).where(Users.provider == "db").limit(1)) is not None


def db_user_row(session, username: str):
    from .db import Users
    row = session.get(Users, username.strip().lower())
    return row if row is not None and row.provider == "db" else None


def _db(username: str, password: str) -> User | None:
    from .db import SessionLocal, Users
    with SessionLocal() as s:
        row = s.get(Users, username.strip().lower())
        if row is None or row.provider != "db" or not row.password_hash or not row.is_active or not _verify(password, row.password_hash):
            return None
        return User(row.username, row.role, list(row.departments) if row.departments is not None else ["*"], cameras=list(row.cameras or []),
                    provider="db", tenant=row.tenant or "", is_super=bool(row.is_super))


def yaml_users_active(session) -> bool:
    """users.yaml accounts are honoured while no database account exists (first install), or when
    auth.yaml providers.local.keep_yaml_users is true."""
    local = (auth_cfg().get("providers") or {}).get("local") or {"enabled": True}
    if not local.get("enabled", True):
        return False
    return bool(local.get("keep_yaml_users")) or not db_users_exist(session)


def validate_password(password: str) -> None:
    if len(password or "") < MIN_PASSWORD_LEN:
        raise AccountError(f"password must be at least {MIN_PASSWORD_LEN} characters")
    if password.lower() == password or not any(ch.isdigit() for ch in password):
        raise AccountError("password needs at least one uppercase letter and one digit")


def create_account(session, username: str, password: str, role: str, departments: list[str] | None = None,
                   cameras: list[str] | None = None, is_super: bool = False, created_by: str = "", tenant: str = ""):
    """Create a database account. Raises AccountError with a user-facing message."""
    from .db import Users
    username = (username or "").strip().lower()
    if not USERNAME_RE.match(username):
        raise AccountError("username: 3-64 characters, lowercase letters, digits, . _ @ -")
    if not rbac.is_role(role):
        raise AccountError(f"role must be one of {', '.join(sorted(rbac.roles()))}")
    if is_super and role != "admin":
        raise AccountError("a super admin must have the admin role")
    validate_password(password)
    row = session.get(Users, username)
    if row is not None and row.provider == "db":
        raise AccountError("that username already exists")
    if row is None:
        row = Users(username=username)
        session.add(row)
    # (a password-less directory / demo row of this name is upgraded in place; its 2FA and lockout state is reset)
    row.provider, row.password_hash, row.role = "db", hash_password(password), role
    row.departments, row.cameras = (list(departments) if departments is not None else ["*"]), list(cameras or [])
    row.is_super, row.is_active, row.tenant, row.created_by = is_super, True, tenant, created_by
    row.created_at, row.password_changed_at = dt.datetime.now(dt.timezone.utc), dt.datetime.now(dt.timezone.utc)
    row.totp_secret_enc, row.mfa_enrolled_at, row.backup_codes, row.grace_logins_used = "", None, [], 0
    row.failed_logins, row.locked_until = 0, None
    session.flush()
    return row


def update_account(session, username: str, *, role: str | None = None, departments: list[str] | None = None,
                   cameras: list[str] | None = None, is_active: bool | None = None, password: str | None = None,
                   is_super: bool | None = None, actor: str = ""):
    from .db import Users
    row = session.get(Users, username.strip().lower())
    if row is None or row.provider != "db":
        raise AccountError("no such account")
    if role is not None:
        if not rbac.is_role(role):
            raise AccountError(f"role must be one of {', '.join(sorted(rbac.roles()))}")
        if row.is_super and role != "admin" and is_super is not False:
            raise AccountError("a super admin keeps the admin role; remove super admin first")
        row.role = role
    if departments is not None:
        row.departments = list(departments)            # [] = no department: the account sees only its explicit cameras
    if cameras is not None:
        row.cameras = list(cameras)
    if is_super is not None:
        if row.is_super and not is_super and _super_count(session) <= 1:
            raise AccountError("cannot remove the last super admin")
        if is_super and row.role != "admin":
            row.role = "admin"
        row.is_super = is_super
    if is_active is not None:
        if row.username == actor and not is_active:
            raise AccountError("you cannot deactivate your own account")
        if not is_active and row.is_super and _active_super_count(session) <= 1:
            raise AccountError("cannot deactivate the last active super admin")
        row.is_active = is_active
    if password is not None:
        validate_password(password)
        row.password_hash = hash_password(password)
        row.password_changed_at = dt.datetime.now(dt.timezone.utc)
    return row


def delete_account(session, username: str, actor: str) -> None:
    from sqlalchemy import delete as _delete
    from .db import AccessGrant, Users
    username = username.strip().lower()
    row = session.get(Users, username)
    if row is None or row.provider != "db":
        raise AccountError("no such account")
    if username == actor:
        raise AccountError("you cannot delete your own account")
    if row.is_super and _super_count(session) <= 1:
        raise AccountError("cannot delete the last super admin")
    session.delete(row)                                 # the row IS the 2FA secret, backup codes and lockout state
    session.execute(_delete(AccessGrant).where(AccessGrant.username == username))
    session.flush()


def _super_count(session) -> int:
    from sqlalchemy import func, select
    from .db import Users
    return int(session.scalar(select(func.count()).select_from(Users).where(Users.provider == "db", Users.is_super.is_(True))) or 0)


def _active_super_count(session) -> int:
    from sqlalchemy import func, select
    from .db import Users
    return int(session.scalar(select(func.count()).select_from(Users).where(Users.provider == "db", Users.is_super.is_(True), Users.is_active.is_(True))) or 0)


# ----------------------------------------------------------------------------- LDAP / Active Directory
def _map_groups(groups: list[str], group_map: dict) -> tuple[str, list[str], str] | None:
    """First matching group (case-insensitive, DN or plain name) decides role + departments (+ tenant)."""
    norm = {g.lower() for g in groups}
    for key, spec in (group_map or {}).items():
        if key.lower() in norm or any(n.split(",")[0].lower() == f"cn={key.lower()}" for n in norm):
            return spec.get("role", "viewer"), list(spec.get("departments", [])), spec.get("tenant", "")
    return None


def _ldap(username: str, password: str, cfg: dict, connection_factory=None) -> User | None:
    import ldap3
    bind_dn = cfg["bind_template"].format(username=username)
    server = ldap3.Server(cfg["server"], get_info=ldap3.NONE, use_ssl=cfg["server"].startswith("ldaps"),
                          connect_timeout=8)
    try:
        conn = (connection_factory or ldap3.Connection)(server, user=bind_dn, password=password, auto_bind=True,
                                                          receive_timeout=8)
    except Exception as e:  # noqa: BLE001  bad password, unknown user, server down
        log.info("ldap bind failed for %s: %s", username, type(e).__name__)
        return None
    groups: list[str] = []
    try:
        conn.search(cfg["base_dn"], cfg.get("user_filter", "(sAMAccountName={username})").format(username=username),
                    attributes=[cfg.get("group_attr", "memberOf")])
        if conn.entries:
            val = conn.entries[0][cfg.get("group_attr", "memberOf")].values
            groups = [str(v) for v in (val if isinstance(val, list) else [val])]
    finally:
        try:
            conn.unbind()
        except Exception:  # noqa: BLE001
            pass
    m = _map_groups(groups, cfg.get("group_map", {}))
    if not m:
        log.warning("ldap user %s is in no mapped group (%d groups)", username, len(groups))
        return None
    return User(username, m[0], m[1], provider="ldap", tenant=m[2])


# ----------------------------------------------------------------------------- OIDC
def oidc_cfg() -> dict | None:
    c = (auth_cfg().get("providers") or {}).get("oidc") or {}
    return c if c.get("enabled") else None


def oidc_login_url(state: str, nonce: str) -> str:
    c = oidc_cfg()
    disc = _oidc_discovery(c["issuer"])
    from urllib.parse import urlencode
    q = {"response_type": "code", "client_id": c["client_id"], "redirect_uri": c["redirect_uri"],
         "scope": " ".join(c.get("scopes", ["openid", "profile", "email"])), "state": state, "nonce": nonce}
    return f"{disc['authorization_endpoint']}?{urlencode(q)}"


_disc_cache: dict = {}


def _oidc_discovery(issuer: str) -> dict:
    if issuer not in _disc_cache:
        import requests
        r = requests.get(issuer.rstrip("/") + "/.well-known/openid-configuration", timeout=10)
        r.raise_for_status()
        _disc_cache[issuer] = r.json()
    return _disc_cache[issuer]


def oidc_exchange(code: str, nonce: str) -> User | None:
    """Authorization-code exchange, ID-token verification against the IdP's JWKS, group mapping."""
    import requests
    c = oidc_cfg()
    disc = _oidc_discovery(c["issuer"])
    r = requests.post(disc["token_endpoint"], data={"grant_type": "authorization_code", "code": code,
                                                    "redirect_uri": c["redirect_uri"], "client_id": c["client_id"],
                                                    "client_secret": c.get("client_secret", "")}, timeout=15)
    r.raise_for_status()
    id_token = r.json()["id_token"]
    jwk_client = jwt.PyJWKClient(disc["jwks_uri"])
    key = jwk_client.get_signing_key_from_jwt(id_token).key
    claims = jwt.decode(id_token, key, algorithms=["RS256", "ES256"], audience=c["client_id"], issuer=c["issuer"])
    if nonce and claims.get("nonce") != nonce:
        return None
    username = claims.get(c.get("username_claim", "preferred_username")) or claims.get("email") or claims["sub"]
    groups = claims.get(c.get("groups_claim", "groups")) or []
    m = _map_groups([str(g) for g in groups], c.get("group_map", {}))
    if not m:
        log.warning("oidc user %s is in no mapped group", username)
        return None
    u = User(username, m[0], m[1], provider="oidc", tenant=m[2])
    u.mfa = bool(c.get("trust_idp_mfa", True)) and "mfa" in [str(x).lower() for x in claims.get("amr", [])]
    return u


# ----------------------------------------------------------------------------- lockout + MFA state
def _sec(session, username: str, provider: str = "users.yaml"):
    """The users row that carries 2FA + lockout state. Directory / demo accounts (and names that fail to log in)
    get a password-less row here on first contact so lockout and 2FA work for every provider."""
    from .db import Users
    username = (username or "").strip().lower()
    row = session.get(Users, username)
    if row is None:
        row = Users(username=username, provider=provider, password_hash="", role="viewer", departments=["*"],
                    created_by="login")
        session.add(row)
        session.flush()
    return row


def _fernet():
    from cryptography.fernet import Fernet
    key = base64.urlsafe_b64encode(hashlib.sha256(("totp:" + settings.token_secret).encode()).digest())
    return Fernet(key)


def is_locked(session, username: str) -> bool:
    row = _sec(session, username)
    return bool(row.locked_until and row.locked_until > dt.datetime.now(dt.timezone.utc))


def note_login(session, username: str, ok: bool, provider: str | None = None) -> None:
    row = _sec(session, username)
    if ok:
        row.failed_logins = 0
        row.locked_until = None
        row.last_login = dt.datetime.now(dt.timezone.utc)
        if provider and row.provider != "db":
            row.provider = provider
    else:
        row.failed_logins += 1
        if row.failed_logins >= settings.login_max_failures:
            row.locked_until = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=settings.login_lockout_s)
            row.failed_logins = 0


def mfa_enrolled(session, username: str) -> bool:
    """True only for a CONFIRMED enrolment. A 'pending:' secret (QR shown, first code never entered) must not
    count, or the account would be asked for a code no authenticator can produce and be locked out."""
    enc = _sec(session, username).totp_secret_enc
    return bool(enc) and not enc.startswith("pending:")


def mfa_required_for(role: str) -> bool:
    return role in ((auth_cfg().get("mfa") or {}).get("required_roles") or [])


def mfa_begin_enrol(session, username: str) -> dict:
    """New TOTP secret (not yet active): returns otpauth URI + QR (data URL) + backup codes."""
    import pyotp
    secret = pyotp.random_base32()
    row = _sec(session, username)
    row.totp_secret_enc = "pending:" + _fernet().encrypt(secret.encode()).decode()
    issuer = (auth_cfg().get("mfa") or {}).get("issuer_name", "Unified CCTV")
    uri = pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=issuer)
    qr = ""
    try:
        import io
        import qrcode
        buf = io.BytesIO()
        qrcode.make(uri).save(buf, format="PNG")
        qr = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:  # noqa: BLE001
        pass
    return {"secret": secret, "uri": uri, "qr": qr}


def mfa_confirm_enrol(session, username: str, code: str) -> list[str] | None:
    """Activate the pending secret if `code` is right; returns backup codes (shown once)."""
    import pyotp
    row = _sec(session, username)
    if not row.totp_secret_enc.startswith("pending:"):
        return None
    secret = _fernet().decrypt(row.totp_secret_enc[8:].encode()).decode()
    if not pyotp.TOTP(secret).verify(code, valid_window=1):
        return None
    row.totp_secret_enc = row.totp_secret_enc[8:]
    row.mfa_enrolled_at = dt.datetime.now(dt.timezone.utc)
    codes = [secrets.token_hex(4) for _ in range(8)]
    row.backup_codes = [hashlib.sha256(c.encode()).hexdigest() for c in codes]
    return codes


def mfa_verify(session, username: str, code: str) -> bool:
    import pyotp
    row = _sec(session, username)
    if not row.totp_secret_enc or row.totp_secret_enc.startswith("pending:"):
        return False
    secret = _fernet().decrypt(row.totp_secret_enc.encode()).decode()
    code = code.strip().replace(" ", "")
    if pyotp.TOTP(secret).verify(code, valid_window=1):
        return True
    h = hashlib.sha256(code.encode()).hexdigest()
    if h in (row.backup_codes or []):
        row.backup_codes = [c for c in row.backup_codes if c != h]
        return True
    return False


def mfa_reset(session, username: str) -> None:
    row = _sec(session, username)
    row.totp_secret_enc, row.mfa_enrolled_at, row.backup_codes = "", None, []


# ----------------------------------------------------------------------------- login orchestration
def authenticate(username: str, password: str) -> User | None:
    """Password login through the providers, in order: database accounts, users.yaml (only while no database
    account exists, or keep_yaml_users is set), then LDAP."""
    prov = auth_cfg().get("providers") or {}
    u = _db(username, password)
    if u:
        return u
    from .db import SessionLocal
    with SessionLocal() as s:
        yaml_ok = yaml_users_active(s)
    if yaml_ok:
        u = _local(username, password)
        if u:
            return u
    ldap = prov.get("ldap") or {}
    if ldap.get("enabled"):
        try:
            return _ldap(username, password, ldap)
        except Exception:  # noqa: BLE001
            log.exception("ldap error")
    return None


def with_effective_access(session, u: User) -> User:
    from .tenancy import clip_departments, tenant_for
    eff = rbac.effective(session, u.username, u.role, u.departments, u.cameras)
    u.features, u.departments, u.cameras = eff["features"], eff["departments"], eff["cameras"]
    u.grant_features = eff["grant_features"]
    u.base_departments, u.base_cameras, u.camera_perms = eff["base_departments"], eff["base_cameras"], eff["camera_perms"]
    u.break_glass = eff["break_glass"]
    u.tenant = tenant_for(u.departments, u.tenant)
    u.departments = clip_departments(u.departments, u.tenant)
    return u


# ----------------------------------------------------------------------------- tokens
def issue_token(user: User, ttl_s: int | None = None, purpose: str = "session") -> str:
    now = int(time.time())
    ttl = ttl_s or int((auth_cfg().get("session") or {}).get("ttl_hours", settings.token_ttl_s / 3600) * 3600)
    payload = {"sub": user.username, "r": user.role, "d": user.departments, "f": user.features, "c": user.cameras,
               "mfa": user.mfa, "bg": user.break_glass, "p": user.provider, "tn": user.tenant, "su": user.is_super,
               "g": user.grant_features, "rv": rbac.roles_version(), "t": purpose, "iat": now, "exp": now + ttl,
               "bd": user.base_departments if user.base_departments is not None else user.departments,
               "bc": user.base_cameras if user.base_cameras is not None else user.cameras,
               "cp": user.camera_perms, "pv": _camperms_version()}
    return jwt.encode(payload, settings.token_secret, algorithm="HS256")


def _camperms_version() -> int:
    from . import camperms
    return camperms.version()


_EFF_CACHE: dict = {}


def verify_token(token: str, purpose: str = "session") -> User | None:
    try:
        p = jwt.decode(token, settings.token_secret, algorithms=["HS256"])
        if p.get("t", "session") != purpose:
            return None
        feats = p.get("f", [])
        if p.get("p") != "apikey" and "rv" in p and p["rv"] != rbac.roles_version():
            # a role was edited after this token was issued: follow the role's current permissions (+ granted extras)
            feats = sorted(rbac.role_features(p["r"]) | set(p.get("g", [])))
        u = User(p["sub"], p["r"], p["d"], feats, p.get("c", []), p.get("mfa", False), p.get("bg"),
                 p.get("p", "local"), p.get("tn", ""), bool(p.get("su", False)), list(p.get("g", [])),
                 p.get("bd"), p.get("bc"), dict(p.get("cp") or {}))
        pv = _camperms_version()
        if p.get("p") != "apikey" and p.get("pv") != pv:
            # Admin -> Permissions changed after this token was issued: re-read the account's camera access
            # (once per user and permissions version; cached so a stale token costs no database round trip per request)
            key = (u.username, u.role, pv, tuple(p.get("bd") or p["d"]), tuple(p.get("bc") or p.get("c", [])))
            eff = _EFF_CACHE.get(key)
            if eff is None or time.time() - eff[0] > 15:
                try:
                    from .db import SessionLocal
                    with SessionLocal() as s:
                        eff = (time.time(), rbac.effective(s, u.username, u.role, list(key[3]), list(key[4])))
                    if len(_EFF_CACHE) > 2000:
                        _EFF_CACHE.clear()
                    _EFF_CACHE[key] = eff
                except Exception:  # noqa: BLE001
                    log.exception("could not refresh camera permissions for %s", u.username)
                    eff = None
            if eff:
                e = eff[1]
                u.departments, u.cameras, u.camera_perms = e["departments"], e["cameras"], e["camera_perms"]
                u.base_departments, u.base_cameras = e["base_departments"], e["base_cameras"]
                u.features = sorted(set(u.features) | set(e["grant_features"]))
                u.grant_features = e["grant_features"]
        return u
    except Exception:  # noqa: BLE001
        return None


def token_info(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.token_secret, algorithms=["HS256"])
    except Exception:  # noqa: BLE001
        return None


if __name__ == "__main__":  # helper: python -m uvp.auth <password>
    import sys
    print(hash_password(sys.argv[1]))
