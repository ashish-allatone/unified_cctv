"""Browser end-to-end check of the operator console (headless Chromium via Playwright).

Verifies: login, WebRTC playback of feeds from BOTH departments on one wall,
search dashboard, vehicle movement, alerts, sources, and department-scoped
access (police_op cannot see municipal cameras). Saves screenshots to --shots.

Usage: python tests/e2e_ui.py --url http://localhost:8000 --shots data/screens
"""
import argparse
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://localhost:8000")
ap.add_argument("--shots", default="data/screens")
a = ap.parse_args()
shots = Path(a.shots)
shots.mkdir(parents=True, exist_ok=True)
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page(viewport={"width": 1600, "height": 900})
    pg.on("console", lambda m: m.type == "error" and print("  console:", m.text[:160]))
    pg.goto(a.url)
    pg.fill("input[name=username]", "admin")
    pg.fill("input[name=password]", "admin123")
    pg.click("button[type=submit]")
    pg.wait_for_selector("#app:not(.hidden)")
    pg.click("#grid-select button[data-grid='3x3']")
    for cid in ["police-cam3", "muni-cam3", "police-cam4", "muni-cam4", "police-cam1", "muni-cam1"]:
        pg.click(f".cam[data-cam='{cid}']")
    t0 = time.time()
    playing = 0
    while time.time() - t0 < 75:
        playing = pg.evaluate("[...document.querySelectorAll('#wall video')].filter(v => v.readyState >= 2 && v.videoWidth > 0).length")
        if playing >= 8:
            break
        time.sleep(1)
    states = pg.evaluate("[...document.querySelectorAll('#wall .state')].map(s => s.textContent)")
    check(playing >= 8, f"video wall: {playing} tiles playing ({states})")
    depts = pg.evaluate("[...new Set([...document.querySelectorAll('#wall .ov .tagchip:not(.anpr)')].map(x => x.textContent))]")
    check(set(depts) >= {"Police", "Municipal"}, f"wall mixes departments: {depts}")
    time.sleep(3)
    pg.screenshot(path=str(shots / "1_video_wall.png"))

    pg.click("#tabs button[data-view='search']")
    pg.wait_for_selector("#results tbody tr td")
    time.sleep(1.5)
    rows = pg.locator("#results tbody tr").count()
    check(rows > 5, f"search dashboard lists {rows} records")
    pg.screenshot(path=str(shots / "2_search_dashboard.png"))
    pg.fill("#search-form input[name=plate]", "MH12*")
    pg.click("#search-form button.primary")
    time.sleep(1.5)
    plates = pg.evaluate("[...document.querySelectorAll('#results .platebox')].map(x => x.textContent)")
    check(plates and all(x.startswith("MH12") for x in plates), f"wildcard MH12* -> {sorted(set(plates))}")

    pg.click("#tabs button[data-view='movement']")
    pg.fill("#move-form input[name=plate]", "MH12AB1234")
    pg.click("#move-form button.primary")
    pg.wait_for_selector("#move-list li")
    time.sleep(1.5)
    sub = pg.text_content("#move-sub")
    check("Municipal" in sub and "Police" in sub, f"vehicle movement across departments: {sub}")
    pg.screenshot(path=str(shots / "3_vehicle_movement.png"))

    pg.click("#tabs button[data-view='alerts']")
    pg.wait_for_selector("#alerts-table tbody tr")
    time.sleep(1)
    n_alerts = pg.locator("#alerts-table tbody tr").count()
    check(n_alerts >= 1, f"alerts table shows {n_alerts} watchlist hits")
    pg.screenshot(path=str(shots / "4_alerts.png"))

    # video archive: Playback tab lists archived segments; Clip endpoint answers for a search row
    pg.click("#tabs button[data-view='playback']")
    time.sleep(0.5)
    pg.select_option("#pb-camera", "police-cam1")
    pg.click("#pb-form button.primary")
    pg.wait_for_selector("#pb-table tbody tr td")
    n_seg = pg.evaluate("document.querySelectorAll('#pb-table tbody tr [data-url]').length")
    check(n_seg >= 1, f"playback lists {n_seg} archived segments for police-cam1")
    pg.screenshot(path=str(shots / "7_playback.png"))
    clip = pg.evaluate("""async () => { const id = document.querySelector('#results [data-clip]').dataset.clip;
        const tok = JSON.parse(sessionStorage.getItem('uvp')).token;
        const r = await fetch('/api/events/' + id + '/clip', {headers: {Authorization: 'Bearer ' + tok}}); const j = await r.json(); return [r.status, j.status]; }""")
    check(clip[0] == 200 and clip[1] in ("ready", "pending", "none"), f"event clip endpoint responds {clip}")

    pg.click("#tabs button[data-view='sources']")
    pg.wait_for_selector("#source-cards .card")
    time.sleep(1)
    cards = pg.locator("#source-cards .card").count()
    check(cards == 2, f"sources page shows {cards} departmental systems")
    pg.screenshot(path=str(shots / "5_sources.png"))

    # department scoping
    pg2 = b.new_page(viewport={"width": 1400, "height": 800})
    pg2.goto(a.url)
    pg2.evaluate("sessionStorage.clear(); localStorage.clear()")
    pg2.reload()
    pg2.fill("input[name=username]", "police_op")
    pg2.fill("input[name=password]", "police123")
    pg2.click("button[type=submit]")
    pg2.wait_for_selector(".cam")
    cams = pg2.evaluate("[...document.querySelectorAll('.cam')].map(c => c.dataset.cam)")
    check(cams and all(c.startswith("police") for c in cams), f"police_op sees only police cameras: {cams}")
    b.close()

print(f"\n{len(failures)} failures")
sys.exit(1 if failures else 0)
