"""Seed demo watchlist entries through the public API (as a supervisor).

Usage: python scripts/seed_demo.py [--api http://localhost:8000]
"""
import argparse

import requests

WATCH = [
    ("MH12AB1234", "Stolen vehicle, FIR 482/2026 (demo)", "high"),
    ("DL3CAF0921", "Wanted in hit-and-run case (demo)", "high"),
    ("KA05MN7788", "Unpaid e-challans above threshold (demo)", "medium"),
]

ap = argparse.ArgumentParser()
ap.add_argument("--api", default="http://localhost:8000")
ap.add_argument("--user", default="supervisor")
ap.add_argument("--password", default="super123")
a = ap.parse_args()
tok = requests.post(f"{a.api}/api/auth/login", json={"username": a.user, "password": a.password}, timeout=10).json()["token"]
for plate, reason, prio in WATCH:
    r = requests.post(f"{a.api}/api/watchlist", json={"plate": plate, "reason": reason, "priority": prio, "days": 30},
                      headers={"Authorization": f"Bearer {tok}"}, timeout=10)
    print(plate, r.status_code)
