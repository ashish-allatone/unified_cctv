"""Indian number-plate normalisation, validation and OCR correction.

Formats handled
  Standard: SS RR X[XX] NNNN   e.g. MH12AB1234, DL3CAF0921, KA05M1234, DL1C1234
  Bharat (BH) series: YY BH NNNN X[X]   e.g. 22BH1234AA
OCR engines confuse look-alike glyphs (0/O/D, 1/I, 5/S, 8/B, 2/Z, 6/G). Because
each position in an Indian plate is known to be a letter or a digit, the
corrector fixes those confusions by position and keeps only valid results.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

STATE_CODES = {
    "AN", "AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "DN", "GA", "GJ", "HP", "HR", "JH", "JK", "KA", "KL",
    "LA", "LD", "MH", "ML", "MN", "MP", "MZ", "NL", "OD", "OR", "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "UK",
    "UP", "WB",
}
TO_LETTER = {"0": "O", "1": "I", "2": "Z", "4": "A", "5": "S", "6": "G", "7": "Z", "8": "B"}  # 7 in a letter slot: a Z whose bottom bar is hidden
TO_DIGIT = {"O": "0", "D": "0", "Q": "0", "U": "0", "I": "1", "L": "1", "J": "1", "T": "7", "Z": "2", "S": "5",
            "B": "8", "G": "6", "A": "4"}
STANDARD_RE = re.compile(r"^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$")
BH_RE = re.compile(r"^(\d{2})BH(\d{4})([A-Z]{1,2})$")


def normalise(text: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


SINGLE_DIGIT_RTO_STATES = {"DL"}  # only Delhi issues one-digit RTO codes (DL3CAF0921); others are two digits

# Letters an OCR model commonly confuses with each state-code letter (used with the home-state prior).
LOOKALIKE = {"M": "HNWK", "H": "MNK", "N": "MHW", "W": "MN", "P": "RFB", "R": "PB", "B": "RP8", "K": "XHM",
             "J": "IL", "G": "C6", "D": "O0", "O": "D0Q", "U": "V", "V": "U", "T": "I", "S": "5", "L": "IJ"}


def is_valid(plate: str) -> bool:
    m = STANDARD_RE.match(plate)
    if m:
        if len(m.group(2)) == 1 and m.group(1) not in SINGLE_DIGIT_RTO_STATES:
            return False
        if "O" in m.group(3) or "I" in m.group(3):  # RTO series never use O or I (confusable with 0 / 1)
            return False
        return m.group(1) in STATE_CODES
    return bool(BH_RE.match(plate))


JUNK_ROUND = "OQ0CD"  # what a round sticker / emoji / screw head is usually read as


def _rotate_to_state(t: str) -> str:
    """'OSHTEERMP04' (bottom row read first) -> 'MP04OSHTEER': start the read at a state code."""
    if len(t) >= 2 and t[:2] in STATE_CODES:
        return t
    for i in range(1, len(t) - 3):
        if t[i:i + 2] in STATE_CODES and (t[i + 2].isdigit() or t[i + 2] in "OIZSB"):
            return t[i:] + t[:i]
    return t


def trim_to_plate(raw: str, max_trim: int = 2) -> str:
    """Clean an OCR read into a plate: fix row order, drop stray characters.

    Options tried: the read as-is and rotated to start at a state code; with up to 2 characters
    trimmed at the ends; with one round junk character (sticker/emoji read as O, Q, 0, C, D)
    removed from anywhere. Each is scored as characters removed + characters the format
    corrector had to change; the cheapest valid plate wins.
    """
    t0 = normalise(raw)
    best = None

    def consider(cut: str, removed: int) -> None:
        nonlocal best
        if len(cut) < 6:
            return
        fix = correct(cut)
        if fix.valid:
            score = (removed + fix.corrections, removed)
            if best is None or score < best[0]:
                best = (score, cut)

    for t in {t0, _rotate_to_state(t0)}:
        for total in range(0, max_trim + 1):
            for lead in range(total + 1):
                cut = t[lead:len(t) - (total - lead)]
                consider(cut, total)
                if total == 0:
                    for j, ch in enumerate(cut):
                        if ch in JUNK_ROUND and j >= 2:  # never inside the state code itself
                            consider(cut[:j] + cut[j + 1:], 1)
    return best[1] if best else best_effort_clean(t0)


def best_effort_clean(t: str) -> str:
    """For reads that never become a valid plate (fancy fonts, damaged plates): still start at the
    state code, make the RTO digits digits, and drop a sticker 'O' where the second row begins."""
    t = _rotate_to_state(normalise(t))
    if len(t) >= 4 and t[:2] in STATE_CODES:
        rto = "".join(TO_DIGIT.get(c, c) for c in t[2:4])
        rest = t[4:]
        while len(rest) > 4 and rest[0] in "OQ":
            rest = rest[1:]
        t = t[:2] + rto + rest
    return t


def home_state_prefix(raw: str, home_states: list[str]) -> str:
    """Raw-text version of home_state_fix: 'WPOZZR7493' -> 'MPOZZR7493' (look-alike state letter)."""
    if not home_states or len(raw) < 2 or raw[:2] in home_states:
        return raw
    for hs in home_states:
        diffs = [i for i in (0, 1) if raw[i] != hs[i]]
        if len(diffs) == 1 and raw[diffs[0]] in LOOKALIKE.get(hs[diffs[0]], ""):
            return hs + raw[2:]
    return raw


def home_state_fix(plate: str, char_conf: list[float] | None, home_states: list[str],
                   max_conf: float = 1.01) -> str:
    """Prefer the deployment's own state when the read state code is one look-alike letter away.

    Example with home state MP: 'HP04ZR7493' -> 'MP04ZR7493' when the model was not sure of the 'H'.
    max_conf (ANPR_HOME_STATE_MAX_CONF): only switch when the model's confidence in that letter is below
    this; the default 1.01 always switches, since OCR is often confidently wrong on small plates.
    """
    if not home_states or len(plate) < 2 or plate[:2] in home_states:
        return plate
    for hs in home_states:
        diffs = [i for i in (0, 1) if plate[i] != hs[i]]
        if len(diffs) != 1:
            continue
        i = diffs[0]
        conf = char_conf[i] if char_conf and i < len(char_conf) else 0.0
        if plate[i] in LOOKALIKE.get(hs[i], "") and conf < max_conf:
            cand = hs + plate[2:]
            if is_valid(cand) or correct(cand).valid:
                return correct(cand).plate
    return plate


@dataclass
class PlateFix:
    plate: str
    valid: bool
    corrections: int


def _coerce(ch: str, want: str) -> tuple[str, int]:
    if want == "L":
        if ch.isalpha():
            return ch, 0
        return (TO_LETTER[ch], 1) if ch in TO_LETTER else (ch, 99)
    if ch.isdigit():
        return ch, 0
    return (TO_DIGIT[ch], 1) if ch in TO_DIGIT else (ch, 99)


def _apply(text: str, pattern: str) -> tuple[str, int]:
    out, cost = [], 0
    for ch, want in zip(text, pattern):
        c, k = _coerce(ch, want)
        out.append(c)
        cost += k
    return "".join(out), cost


def correct(raw: str) -> PlateFix:
    """Return the most plausible valid plate for an OCR string."""
    t = normalise(raw)
    if is_valid(t):
        return PlateFix(t, True, 0)
    best: PlateFix | None = None
    n = len(t)
    patterns = []
    # standard: 2 letters, 1-2 digits, 0-3 letters, 4 digits
    for rto in (2, 1):
        series = n - 2 - rto - 4
        if 0 <= series <= 3:
            patterns.append("LL" + "D" * rto + "L" * series + "DDDD")
    if n in (9, 10):  # BH series
        patterns.append("DDLLDDDD" + "L" * (n - 8))
    for p in patterns:
        cand, cost = _apply(t, p)
        if cost >= 99:
            continue
        if is_valid(cand) and (best is None or cost < best.corrections):
            best = PlateFix(cand, True, cost)
    return best or PlateFix(t, False, 0)


def levenshtein(a: str, b: str, max_d: int = 2) -> int:
    if abs(len(a) - len(b)) > max_d:
        return max_d + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]
