"""Browser check of phase-4 UI: SLA panel, API key + webhook admin, tenant branding, field-officer PWA.
Usage: python tests/e2e_ops.py --url http://localhost:8000"""
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
    pg.click("#tabs button[data-view='sources']"); pg.wait_for_selector("#sla-table tbody tr td"); time.sleep(1)
    print("sla rows:", pg.locator("#sla-table tbody tr").count(), pg.text_content("#sla-sub"))
    pg.screenshot(path=f"{a.shots}/14_sla.png")
    pg.click("#tabs button[data-view='admin']"); pg.wait_for_selector("#keys-table tbody tr"); time.sleep(1)
    if pg.locator("#keys-table tbody tr td:nth-child(7) button").count() == 0:
      pass
    pg.fill("#key-form input[name=name]", "traffic-erp"); pg.click("#key-form button.primary"); pg.wait_for_selector("#modal pre"); print("key modal:", pg.text_content("#modal pre")[:8]); pg.click("#modal-x")
    pg.fill("#hook-form input[name=name]", "cad"); pg.fill("#hook-form input[name=url]", "http://localhost:18095/echallan"); pg.click("#hook-form button.primary"); pg.wait_for_selector("#modal pre"); pg.click("#modal-x"); time.sleep(0.8)
    print("keys:", pg.locator("#keys-table tbody tr").count(), "hooks:", pg.locator("#hooks-table tbody tr").count())
    pg.click("#hooks-table [data-hook-test]"); time.sleep(2); print("hook last:", pg.evaluate("(() => document.querySelector('#hooks-table tbody tr td:nth-child(5)').textContent.trim().slice(0, 12))()"))
    print("tenants:", pg.text_content("#tenants-list")[:60])
    # field app
    pg2 = b.new_page(viewport={"width": 390, "height": 800}); pg2.goto(a.url + "/m/"); pg2.fill("input[name=username]", "police_op"); pg2.fill("input[name=password]", "police123"); pg2.click("#login-form button.primary"); pg2.wait_for_selector("#app:not(.hidden)"); time.sleep(1)
    print("field who:", pg2.text_content("#who"), "alerts:", pg2.locator("#alerts .card").count(), "title:", pg2.text_content("#title"))
    pg2.click("#nav button[data-v='lookup']"); pg2.fill("#lookup-form input[name=plate]", "MH12AB1234"); pg2.click("#lookup-form button.primary"); time.sleep(1.5); print("lookup cards:", pg2.locator("#lookup .card").count())
    pg2.screenshot(path=f"{a.shots}/15_field_app.png")
    print("errors:", errs)
    b.close()
    assert not errs, errs
