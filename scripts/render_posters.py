"""Render a poster for every carousel slide: a screenshot of its live 3D view.

Usage: python scripts/render_posters.py [URL] [ASSET_DIR ...]
  URL         the page served locally (default http://127.0.0.1:8765/index.html)
  ASSET_DIR   baked asset dirs to update (default: assets/arctic assets/hot3d assets/wild)

For each example the script brings the slide live in headless Chromium, pauses
on frame 0, hides the control chrome and screenshots the viewport (the image
panel included, so the poster looks exactly like the view that replaces it).
The result is written to <asset dir>/<id>/poster.webp and index.json's
"poster" field is pointed at it. Run after the bake (pip install playwright
&& playwright install chromium; opencv for the WebP encode)."""
import json
import os
import sys
import time

import cv2
import numpy as np
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/index.html"
ASSET_DIRS = sys.argv[2:] or ["assets/arctic", "assets/hot3d", "assets/wild"]
POSTER_WIDTH = 832        # card is 1040 px wide at the 1200 px viewport; 0.8x
WEBP_QUALITY = 82

# The page's own selectors: assets/<name>/ -> #examples-<name>
def carousel_for(asset_dir):
    # assets/some_name -> #examples-some-name
    return "#examples-" + os.path.basename(os.path.normpath(asset_dir)).replace("_", "-")


def wait_live(page, carousel, index):
    page.wait_for_function(
        f"(() => {{ const v = document.querySelector('{carousel} .viewer.is-live');"
        f" return v && v.dataset.index === '{index}'; }})()", timeout=60000)
    # Null-safe: the live slide can be mid-swap for a tick.
    page.wait_for_function(
        f"(() => {{ const s = document.querySelector('{carousel} .viewer.is-live .viewer-status');"
        " return s && s.textContent === ''; })()", timeout=60000)


def render(page, carousel, index):
    dots = page.locator(f"{carousel} .carousel-dots button")
    dots.nth(index).click()
    wait_live(page, carousel, index)
    live = page.locator(f"{carousel} .viewer.is-live")
    # Pause on frame 0 and let the frame + tint land.
    live.evaluate("""v => {
      const play = v.querySelector('.viewer-play');
      if (v.classList.contains('is-playing')) play.click();
      const slider = v.querySelector('.viewer-slider');
      slider.value = 0;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      v.classList.add('is-capturing');
    }""")
    time.sleep(0.6)
    png = live.locator(".viewer-viewport").screenshot(type="png")
    live.evaluate("v => v.classList.remove('is-capturing')")
    image = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
    height = int(round(image.shape[0] * POSTER_WIDTH / image.shape[1]))
    small = cv2.resize(image, (POSTER_WIDTH, height), interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".webp", small, [cv2.IMWRITE_WEBP_QUALITY, WEBP_QUALITY])
    if not ok:
        raise RuntimeError("WebP encode failed")
    return encoded.tobytes()


with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist"])
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.on("pageerror", lambda exc: print("pageerror:", exc))
    page.goto(URL)
    page.wait_for_selector(".carousel .viewer", state="attached", timeout=30000)
    total = 0
    for asset_dir in ASSET_DIRS:
        carousel = carousel_for(asset_dir)
        index_path = os.path.join(asset_dir, "index.json")
        with open(index_path) as fh:
            index = json.load(fh)
        page.evaluate(
            f"document.querySelector('{carousel}').scrollIntoView({{block: 'center'}})")
        for i, example in enumerate(index["examples"]):
            data = render(page, carousel, i)
            out = os.path.join(asset_dir, example["id"], "poster.webp")
            with open(out, "wb") as fh:
                fh.write(data)
            example["poster"] = "poster.webp"
            total += len(data)
            print(f"{out}: {len(data) / 1e3:.0f} KB")
        with open(index_path, "w") as fh:
            json.dump(index, fh, separators=(",", ":"))
    browser.close()
print(f"posters total {total / 1e6:.2f} MB")
