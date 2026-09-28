"""Browser check of phase-3 UI: vehicle attribute column + colour filter, Violations tab (cards, challans),
hotlist status in Watchlist. Usage: python tests/e2e_analytics.py --url http://localhost:8000"""
import argparse
import time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument("--url", default="http://localhost:8000"); ap.add_argument("--shots", default="docs/screenshots")
a = ap.parse_args()
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1500, "height": 900})
    errs = []; pg.on("console", lambda m: m.type == "error" and errs.append(m.text[:200])); pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto(a.url); pg.fill("input[name=username]", "admin"); pg.fill("input[name=password]", "admin123")
    pg.click("button[type=submit]"); pg.wait_for_selector("#app:not(.hidden)")
    pg.click("#tabs button[data-view='search']"); pg.wait_for_selector("#results tbody tr td"); time.sleep(0.5)
    print("vehicle col sample:", pg.evaluate("[...document.querySelectorAll('#results tbody tr')].slice(0,3).map(r=>r.children[8].textContent)"))
    pg.select_option("#search-form select[name=colour]", "red"); pg.click("#search-form button.primary"); time.sleep(1)
    print("red rows:", pg.locator("#results tbody tr").count(), pg.text_content("#result-title"))
    pg.click("#tabs button[data-view='violations']"); pg.wait_for_selector("#viol-cards .card"); time.sleep(1)
    print("cards:", pg.locator("#viol-cards .card").count(), "challans:", pg.locator("#ch-table tbody tr").count())
    pg.screenshot(path=f"{a.shots}/13_violations.png")
    pg.click("#tabs button[data-view='watchlist']"); time.sleep(1)
    print("hotlists:", pg.text_content("#hl-list")[:120])
    print("errors:", errs)
    b.close()
    assert not errs, errs
