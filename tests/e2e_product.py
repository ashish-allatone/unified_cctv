"""Browser check of phase-6 UI: licence banner/card, Hindi toggle, Alt+N shortcuts, plate review flow, weekly report.
Usage: python tests/e2e_product.py --url http://localhost:8000"""
import argparse
import time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument("--url", default="http://localhost:8000"); ap.add_argument("--shots", default="docs/screenshots")
a = ap.parse_args()
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1500, "height": 900})
    errs = []; pg.on("console", lambda m: m.type == "error" and errs.append(m.text[:200])); pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto(a.url); pg.fill("input[name=username]", "admin"); pg.fill("input[name=password]", "admin123")
    pg.click("button[type=submit]"); pg.wait_for_selector("#app:not(.hidden)"); time.sleep(1)
    print("licence banner hidden:", pg.evaluate("document.querySelector('#lic-banner')?.classList.contains('hidden')"))
    pg.click("#lang-toggle"); time.sleep(0.8); print("hindi nav:", pg.evaluate("[...document.querySelectorAll('#tabs button')].slice(0,3).map(b=>b.textContent.trim())"), "lang:", pg.evaluate("document.documentElement.lang"))
    pg.click("#lang-toggle"); time.sleep(0.5)
    pg.keyboard.press("Alt+2"); time.sleep(0.8); print("alt+2 view:", pg.evaluate("[...document.querySelectorAll('.view')].find(v=>!v.classList.contains('hidden')).id"))
    pg.wait_for_selector("#results tbody tr td"); pg.click("#results [data-fix]"); pg.wait_for_selector("#rv-form"); pg.select_option("#rv-form select[name=verdict]", "confirmed"); pg.click("#rv-form button.primary"); time.sleep(1)
    print("toasts:", pg.evaluate("[...document.querySelectorAll('.toast')].map(t=>t.textContent)")[:1])
    pg.click("#tabs button[data-view='violations']"); pg.wait_for_selector("#review-table tbody tr"); time.sleep(1)
    print("review queue rows:", pg.locator("#review-table tbody tr").count(), "report:", pg.text_content("#rep-sub")[:90])
    pg.click("#review-table [data-rv-fix]"); pg.wait_for_selector("#rv-form"); pg.select_option("#rv-form select[name=verdict]", "corrected"); pg.fill("#rv-form input[name=true_plate]", "MP04ZR7493"); pg.select_option("#rv-form select[name=reason]", "two_line"); pg.click("#rv-form button.primary"); time.sleep(1.2)
    print("report after:", pg.text_content("#rep-sub")[:80])
    pg.screenshot(path=f"{a.shots}/16_review_report.png")
    pg.click("#tabs button[data-view='admin']"); pg.wait_for_selector("#compliance-cards .card"); time.sleep(1)
    print("licence card:", pg.evaluate("document.querySelector('#compliance-cards .card').textContent.slice(0,80)"))
    print("errors:", errs)
    b.close()
    assert not errs, errs
