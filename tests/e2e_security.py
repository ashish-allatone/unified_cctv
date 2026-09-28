"""Browser check of the phase-1 security UI: feature-gated tabs, admin panel (grants, legal holds,
compliance cards), audit chain verification, break-glass banner, plate masking for a viewer.
Usage: python tests/e2e_security.py --url http://localhost:8000 --shots docs/screenshots"""
import argparse
import time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument("--url", default=a.url); ap.add_argument("--shots", default="docs/screenshots")
a = ap.parse_args()
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1500, "height": 900})
    errs = []
    pg.on("console", lambda m: m.type == "error" and errs.append(m.text[:200]))
    pg.goto(a.url); pg.fill("input[name=username]", "admin"); pg.fill("input[name=password]", "admin123")
    pg.click("button[type=submit]"); pg.wait_for_selector("#app:not(.hidden)")
    print("tabs:", pg.evaluate("[...document.querySelectorAll('#tabs button:not(.hidden)')].map(b=>b.dataset.view)"))
    print("break-glass visible:", pg.evaluate("!document.querySelector('#break-glass').classList.contains('hidden')"))
    # admin tab
    pg.click("#tabs button[data-view='admin']"); pg.wait_for_selector("#users-table tbody tr"); time.sleep(0.8)
    print("compliance cards:", pg.locator("#compliance-cards .card").count(), "users:", pg.locator("#users-table tbody tr").count())
    # grant viewer search
    pg.fill("#grant-form input[name=username]", "viewer"); pg.select_option("#grant-form select[name=kind]", "feature")
    pg.fill("#grant-form input[name=value]", "search"); pg.fill("#grant-form input[name=reason]", "shift cover"); pg.click("#grant-form button.primary")
    time.sleep(1); print("grants rows:", pg.locator("#grants-table tbody tr").count())
    # legal hold
    pg.fill("#hold-form input[name=value]", "MH12AB1234"); pg.fill("#hold-form input[name=reference]", "FIR 1/2026"); pg.click("#hold-form button.primary")
    time.sleep(1); print("holds rows:", pg.locator("#holds-table tbody tr").count())
    pg.screenshot(path=f"{a.shots}/8_admin.png", full_page=True)
    # audit verify
    pg.click("#tabs button[data-view='audit']"); pg.wait_for_selector("#audit-table tbody tr"); pg.click("#audit-verify"); time.sleep(1)
    print("audit chain:", pg.text_content("#audit-chain"))
    # break glass
    pg.click("#break-glass"); pg.wait_for_selector("#bg-form"); pg.fill("#bg-form input[name=reason]", "hit-and-run pursuit FIR 55/2026"); pg.click("#bg-form button")
    pg.wait_for_selector("#bg-banner:not(.hidden)", timeout=10000); time.sleep(0.5)
    print("banner:", pg.text_content("#bg-banner")[:80])
    pg.screenshot(path=f"{a.shots}/9_break_glass.png")
    pg.click("#bg-end"); time.sleep(1.5); print("banner after end hidden:", pg.evaluate("document.querySelector('#bg-banner').classList.contains('hidden')"))
    # viewer sees masked plates after the grant
    pg2 = b.new_page(viewport={"width": 1400, "height": 800}); pg2.goto(a.url)
    pg2.fill("input[name=username]", "viewer"); pg2.fill("input[name=password]", "viewer123"); pg2.click("button[type=submit]"); pg2.wait_for_selector("#app:not(.hidden)")
    print("viewer tabs:", pg2.evaluate("[...document.querySelectorAll('#tabs button:not(.hidden)')].map(b=>b.dataset.view)"))
    pg2.click("#tabs button[data-view='search']"); pg2.wait_for_selector("#results tbody tr td"); time.sleep(0.5)
    print("viewer plates:", pg2.evaluate("[...document.querySelectorAll('#results .platebox')].slice(0,3).map(x=>x.textContent)"))
    pg2.screenshot(path=f"{a.shots}/10_masked_plates.png")
    # 2FA setup from app for viewer
    pg2.click("#mfa-setup"); pg2.wait_for_selector("#mfa-app-form"); print("2FA modal shown")
    print("console errors:", errs)
    b.close()
    assert not errs, errs
