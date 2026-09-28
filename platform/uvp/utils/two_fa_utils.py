import base64
import io
import secrets
from datetime import datetime, timedelta, timezone
from fastapi import HTTPException
import jwt 
import pyotp
import qrcode

ISSUER = "Sentinel"
CHALLENGE_TTL_MINUTES = 5
BACKUP_CODE_COUNT = 8
JWT_SECRET_KEY =  "ASDFGHJKLLKJHGFDSA"
ALGORITHM = "HS256"




# --------------------------------------------------------------------------- #
# challenge token: proves the password step passed, nothing more
# --------------------------------------------------------------------------- #

def create_challenge_token(email) -> str:
    """Deliberately NOT an access token: it carries no role, is valid for a few
    minutes, and is only accepted by the 2FA verify endpoint."""
    payload = {
        "sub": email,
        "scope": "2fa_challenge",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=CHALLENGE_TTL_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=ALGORITHM)



def read_challenge_token(token: str):
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[ALGORITHM])
    except:
        raise HTTPException(status_code=401, detail="Challenge expired or invalid, please log in again")
    if payload.get("scope") != "2fa_challenge":
        # stops a normal access token being replayed here
        raise HTTPException(status_code=401, detail="Invalid challenge token")
    return payload["sub"]


def check_code(two_fa_secret, code: str) -> bool:
    """TOTP check with a one-step window and a replay guard."""
    code = (code or "").strip().replace(" ", "")
    if not two_fa_secret or not code.isdigit():
        return False

    totp = pyotp.TOTP(two_fa_secret)
    if not totp.verify(code, valid_window=1):
        return False
    return True

