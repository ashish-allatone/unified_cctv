"""Browser check of phase-2 investigation UI: wall bookmark, case creation, filing a sighting, notes,
custody chain, bookmark clip, GIS map with coverage + nearest-camera search.
Usage: python tests/e2e_investigation.py --url http://localhost:8000 --shots docs/screenshots"""
import argparse
import time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument("--url", default=a.url); ap.add_argument("--shots", default="docs/screenshots")
a = ap.parse_args()
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1500, "height": 900})
    errs = []; pg.on("console", lambda m: m.type == "error" and errs.append(m.text[:200])); pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto(a.url); pg.fill("input[name=username]", "admin"); pg.fill("input[name=password]", "admin123")
    pg.click("button[type=submit]"); pg.wait_for_selector("#app:not(.hidden)")
    # bookmark from the wall
    pg.click("#grid-select button[data-grid='2x2']"); pg.click(".cam[data-cam='police-cam1']"); time.sleep(2)
    pg.hover("#wall .tile"); pg.click("#wall .tile [data-a='bookmark']"); time.sleep(1)
    print("toast:", pg.evaluate("[...document.querySelectorAll('.toast')].map(t=>t.textContent)"))
    # cases
    pg.click("#tabs button[data-view='cases']"); time.sleep(0.5)
    pg.fill("#case-form input[name=title]", "Hit and run, Ring Road"); pg.fill("#case-form input[name=reference]", "FIR 88/2026"); pg.click("#case-form button.primary")
    pg.wait_for_selector("#case-detail h3"); print("case:", pg.text_content("#case-detail h3"))
    # add an event from search
    pg.click("#tabs button[data-view='search']"); pg.wait_for_selector("#results tbody tr td"); time.sleep(0.5)
    pg.click("#results [data-case-add]"); pg.wait_for_selector("#atc-form"); pg.fill("#atc-form input[name=note]", "vehicle of interest"); pg.click("#atc-form button.primary"); time.sleep(1)
    # movement with stitch (just check button visible) and case select populated
    pg.click("#tabs button[data-view='movement']"); time.sleep(0.8)
    print("case options:", pg.locator("#move-case option").count(), "stitch visible:", pg.is_visible("#stitch-btn"))
    # back to cases: item present, note, custody
    pg.click("#tabs button[data-view='cases']"); time.sleep(0.8); pg.click("#cases-table tbody tr[data-case]"); time.sleep(0.8)
    pg.fill("#case-note input[name=note]", "Witness statement collected."); pg.click("#case-note button"); time.sleep(0.8)
    print("items:", pg.locator("#case-detail .case-items li").count(), "custody ok:", pg.text_content("#case-detail h4 span"))
    pg.screenshot(path=f"{a.shots}/11_cases.png")
    # bookmarks table after ~20s cut
    time.sleep(21); pg.click("#tabs button[data-view='playback']"); time.sleep(1)
    print("bookmarks:", pg.evaluate("[...document.querySelectorAll('#bm-table tbody tr')].map(r=>r.children[5].textContent.trim())"))
    # map
    pg.click("#tabs button[data-view='map']"); time.sleep(2)
    print("map polygons:", pg.evaluate("document.querySelectorAll('#gis-map path').length"), "pins:", pg.evaluate("document.querySelectorAll('#gis-map .cam-pin').length"))
    pg.click("#gis-map", position={"x": 700, "y": 400}); time.sleep(1)
    print("nearest:", pg.text_content("#map-nearest")[:120])
    pg.screenshot(path=f"{a.shots}/12_map.png")
    errs = [e for e in errs if "ERR_TUNNEL" not in e and "tile.openstreetmap" not in e]   # tiles need internet
    print("errors:", errs)
    b.close()
    assert not errs, errs
