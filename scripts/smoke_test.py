"""Headless smoke test of the project page (pip install playwright && playwright install chromium).

Usage: python scripts/smoke_test.py [URL] [SCREENSHOT_DIR]
with the page served locally by `python scripts/serve.py 8765` (byte ranges: the
timelapse video must be seekable).

Checks: all three carousels (ARCTIC, HOT3D, in the wild) load every slide, play,
hand the one shared WebGL renderer back and forth, fullscreen toggles, the
articulated cards draw joints and the re-rendered panel, and the mobile layout
keeps the image panel clear of the timeline."""
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/index.html"
OUT = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="projp-smoke-")
problems = []

CAROUSELS = {
    # ARCTIC and HOT3D are interpolated between the runs' keyframes (every
    # 10th capture frame) and play at the capture's 30 fps; pictures at the
    # keyframes only.
    "#examples-arctic": {
        "titles": ["Notebook", "Waffle iron", "Ketchup", "Box", "Phone"],
        "frames": 291,
        "keyframes": 30,
        "joints": True,                       # the hinge, as in the wild cards
    },
    "#examples-hot3d": {
        "titles": ["Coffee pot", "Vase", "Birdhouse", "Mug (patterned)",
                   "Mug (white)", "Dumbbell (5 lb)"],
        "frames": 141,
        "keyframes": 15,
        "joints": True,                       # the coffee pot's collar turns
    },
    "#examples-wild": {
        "titles": ["Garden shears", "Briefcase", "Grind", "Corkscrew", "Scissors",
                   "Butterfly knife", "Box", "Spoon"],
        "frames": [22, 31, 30, 22, 23, 21, 22, 22],   # keyframes per run
        "panel_width": None,                  # 720 px long side, portrait or landscape
        "articulated": True,
    },
}


def frames_of(spec, index):
    frames = spec["frames"]
    return frames[index] if isinstance(frames, list) else frames


def check(condition, message):
    print(("ok   " if condition else "FAIL ") + message)
    if not condition:
        problems.append(message)


def live_slide(page, carousel):
    return page.locator(f"{carousel} .viewer.is-live")


def wait_live(page, carousel, timeout=30000):
    page.wait_for_selector(f"{carousel} .viewer.is-live", timeout=timeout)
    # Null-safe: the live slide can be mid-swap for a tick.
    page.wait_for_function(
        f"(() => {{ const s = document.querySelector('{carousel} .viewer.is-live .viewer-status');"
        " return s && s.textContent === ''; })()", timeout=timeout)


def walk_carousel(page, carousel, spec, tag):
    """Every slide reachable with the next arrow, in order, one live at a time."""
    n_frames = frames_of(spec, 0)
    slide = live_slide(page, carousel)
    check(slide.locator(".viewer-title").text_content() == spec["titles"][0],
          f"{tag}: first live slide is {spec['titles'][0]}")
    check(not slide.locator(".viewer-caption").is_visible(),
          f"{tag}: no caption strip under the card")
    # Navigation thumbnails: one decoded image per example; clicking one jumps.
    thumbs = page.locator(f"{carousel} .carousel-dots button.thumb img")
    check(thumbs.count() == len(spec["titles"])
          and all(thumbs.nth(i).evaluate("img => img.complete && img.naturalWidth > 0")
                  for i in range(thumbs.count())),
          f"{tag}: {len(spec['titles'])} navigation thumbnails, all decoded")
    page.locator(f"{carousel} .carousel-dots button.thumb").nth(1).click()
    time.sleep(1.0)
    wait_live(page, carousel)
    check(live_slide(page, carousel).locator(".viewer-title").text_content() == spec["titles"][1]
          and page.locator(f"{carousel} .carousel-dots button.thumb.active").count() == 1
          and page.locator(f"{carousel} .carousel-dots button.thumb").nth(1)
              .evaluate("b => b.classList.contains('active')"),
          f"{tag}: clicking the second thumbnail goes to {spec['titles'][1]} and marks it")
    page.locator(f"{carousel} .carousel-dots button.thumb").nth(0).click()
    time.sleep(1.0)
    wait_live(page, carousel)
    slide = live_slide(page, carousel)
    check(slide.locator(".viewer-title").text_content() == spec["titles"][0],
          f"{tag}: the first thumbnail brings the first example back")
    count0 = slide.locator(".viewer-count").inner_text()
    time.sleep(1.2)
    count1 = slide.locator(".viewer-count").inner_text()
    check(count0.endswith(f"/ {n_frames}") and count0 != count1,
          f"{tag}: playback advances ({count0!r} -> {count1!r})")
    if spec.get("keyframes"):
        # A smooth bake: 30 fps playback, a tick per keyframe, and the panel
        # holds the last keyframe's picture between keyframes.
        advanced = (int(count1.split("/")[0]) - int(count0.split("/")[0])) % n_frames
        check(advanced >= 20, f"{tag}: plays at ~30 fps ({advanced} frames in 1.2 s)")
        check(slide.locator("datalist option").count() == spec["keyframes"]
              and slide.locator(".viewer-slider").get_attribute("list"),
              f"{tag}: {spec['keyframes']} keyframe ticks under the slider")
        slide.locator(".viewer-play").click()
        for frame, between in ((0, False), (5, True), (10, False)):
            slide.locator(".viewer-slider").evaluate(
                f"s => {{ s.value = {frame}; s.dispatchEvent(new Event('input')); }}")
            time.sleep(0.2)
            check(slide.locator(".viewer-panel").evaluate(
                      "p => p.classList.contains('is-between')") is between,
                  f"{tag}: frame {frame} panel {'held' if between else 'live'}")
        count = slide.locator(".viewer-count").bounding_box()
        check(count["height"] < 30, f"{tag}: frame counter stays on one line")
        slide.locator(".viewer-play").click()
    observed = slide.locator(".viewer-observed")
    panel_width = spec.get("panel_width", 420)
    if panel_width:
        check(observed.evaluate("c => c.width") == panel_width,
              f"{tag}: observed canvas is {panel_width} wide")
    else:
        size = observed.evaluate("c => [c.width, c.height]")
        # 720 px long side, or the capture's own size when it is smaller
        check(380 <= max(size) <= 720, f"{tag}: panel frame long side is <= 720 ({size})")
    if spec.get("articulated"):
        check(observed.evaluate("c => getComputedStyle(c.parentElement).display") == "none",
              f"{tag}: observed-only figure is hidden in the split card")
        check(slide.locator(".viewer-joints").is_visible(), f"{tag}: joint toggle shown")
        check(slide.locator(".viewer-camera").evaluate("b => b.classList.contains('active')"),
              f"{tag}: opens as the capture camera view")
        visible = slide.locator(".viewer-joints").evaluate("b => b.classList.contains('active')")
        slide.locator(".viewer-joints").click()
        toggled = slide.locator(".viewer-joints").evaluate("b => b.classList.contains('active')")
        check(visible and not toggled, f"{tag}: joint toggle hides the axes")
        slide.locator(".viewer-joints").click()
        canvas3d = slide.locator(".viewer-3d").bounding_box()
        panel = slide.locator(".viewer-panel").bounding_box()
        check(canvas3d["x"] + canvas3d["width"] <= panel["x"] + 1
              and abs(canvas3d["width"] - panel["width"]) <= 2,
              f"{tag}: 3D and panel columns split 50/50 ({canvas3d['width']:.0f} | {panel['width']:.0f})")
    elif spec.get("joints"):
        check(slide.locator(".viewer-joints").is_visible(), f"{tag}: joint toggle shown")
    else:
        check(not slide.locator(".viewer-joints").is_visible(), f"{tag}: no joint toggle")
    nonblack = slide.locator(".viewer-overlay").evaluate(
        "c => { const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;"
        " let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i]+d[i+1]+d[i+2] > 30) n++;"
        " return n / (d.length / 4); }")
    check(nonblack > 0.5, f"{tag}: overlay canvas is painted ({nonblack:.2f} non-black)")
    gl = page.evaluate(
        f"() => {{ const c = document.querySelector('{carousel} .viewer-canvas');"
        " return c ? [c.width, c.height] : null; }")
    check(gl and gl[0] > 100, f"{tag}: WebGL canvas attached to live slide {gl}")

    titles = [spec["titles"][0]]
    for step in range(len(spec["titles"]) - 1):
        page.click(f"{carousel} .carousel-next")
        page.wait_for_function(
            f"document.querySelectorAll('.viewer.is-live').length === 1 && "
            f"!{titles!r}.includes(document.querySelector('{carousel} .viewer.is-live .viewer-title').textContent)",
            timeout=30000)
        titles.append(live_slide(page, carousel).locator(".viewer-title").text_content())
        page.wait_for_function(
            f"document.querySelector('{carousel} .viewer.is-live .viewer-count')"
            f".textContent.endsWith('/ {frames_of(spec, step + 1)}')", timeout=30000)
    check(titles == spec["titles"], f"{tag}: visited all slides in order: {titles}")
    check(page.evaluate("document.querySelectorAll('.viewer-canvas').length") == 1,
          f"{tag}: exactly one WebGL canvas exists")
    wait_live(page, carousel)


def run_desktop(browser):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    errors = []
    page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
    page.on("console", lambda msg: errors.append(f"console.{msg.type}: {msg.text}")
            if msg.type in ("error", "warning") else None)
    page.goto(URL)
    # Slides are stamped once index.json arrives; scroll only after that so the
    # layout is final (as for a visitor reading the abstract first).
    page.wait_for_selector("#examples-hot3d .viewer", state="attached", timeout=30000)

    # ARCTIC first.
    page.evaluate("document.querySelector('#examples-arctic').scrollIntoView({block: 'center'})")
    wait_live(page, "#examples-arctic", timeout=90000)
    walk_carousel(page, "#examples-arctic", CAROUSELS["#examples-arctic"], "arctic")
    page.screenshot(path=f"{OUT}/desktop_arctic.png")

    # Scrolling down hands the renderer to the HOT3D carousel.
    page.evaluate("document.querySelector('#examples-hot3d').scrollIntoView({block: 'center'})")
    wait_live(page, "#examples-hot3d", timeout=90000)
    check(page.locator("#examples-arctic .viewer.is-live").count() == 0,
          "hot3d: taking the renderer detaches the ARCTIC slide")
    walk_carousel(page, "#examples-hot3d", CAROUSELS["#examples-hot3d"], "hot3d")
    hot3d = live_slide(page, "#examples-hot3d")
    check(hot3d.locator(".viewer-source").text_content().startswith("HOT3D clip-"),
          "hot3d: (hidden) caption names the clip")
    page.screenshot(path=f"{OUT}/desktop_hot3d.png")

    # Follow the capture camera: stays on across frames, reset releases it.
    hot3d.locator(".viewer-camera").click()
    time.sleep(0.6)
    check(hot3d.locator(".viewer-camera").evaluate("b => b.classList.contains('active')"),
          "camera follow engages and survives frame advance")
    page.screenshot(path=f"{OUT}/desktop_hot3d_camera.png")
    hot3d.locator(".viewer-reset").click()
    check(not hot3d.locator(".viewer-camera").evaluate("b => b.classList.contains('active')"),
          "reset releases camera follow")

    # Fullscreen (headless may deny the API; the CSS fallback must engage).
    hot3d.locator(".viewer-fullscreen").click()
    time.sleep(0.5)
    fs = page.evaluate(
        "() => { const v = document.querySelector('#examples-hot3d .viewer.is-live');"
        " return document.fullscreenElement === v || v.classList.contains('is-fullscreen'); }")
    check(fs, "fullscreen toggles on")
    box = hot3d.bounding_box()
    check(box and box["width"] >= 1190 and box["height"] >= 890,
          f"fullscreen card fills the viewport {box}")
    page.screenshot(path=f"{OUT}/desktop_fullscreen.png")
    hot3d.locator(".viewer-fullscreen").click()
    time.sleep(0.5)
    fs = page.evaluate(
        "() => { const v = document.querySelector('#examples-hot3d .viewer.is-live');"
        " return v && (document.fullscreenElement === v || v.classList.contains('is-fullscreen')); }")
    check(not fs, "fullscreen toggles off")

    # Keyboard: left arrow steps back and pauses.
    hot3d = live_slide(page, "#examples-hot3d")
    hot3d.focus()
    hot3d.press("ArrowLeft")
    check(not hot3d.evaluate("v => v.classList.contains('is-playing')"),
          "arrow key pauses playback")

    # Further down: the in-the-wild carousel (split cards, joints, renders).
    page.evaluate("document.querySelector('#examples-wild').scrollIntoView({block: 'center'})")
    wait_live(page, "#examples-wild")
    check(page.locator("#examples-hot3d .viewer.is-live").count() == 0,
          "wild: taking the renderer detaches the HOT3D slide")
    walk_carousel(page, "#examples-wild", CAROUSELS["#examples-wild"], "wild")
    wild = live_slide(page, "#examples-wild")
    check(not page.locator("#wild-section h2").count(), "wild: section has no headline")
    # A trackpad swipe (a wheel event) over the 3D view must not release the
    # camera: sideways it moves the carousel, vertically it scrolls the page.
    wild.locator(".viewer-3d").hover()
    counter_before = page.locator("#examples-wild .carousel-counter").inner_text()
    page.mouse.wheel(-900, 0)   # back: the walk left the carousel on its last slide
    time.sleep(1.2)
    check(wild.locator(".viewer-camera").evaluate("b => b.classList.contains('active')"),
          "wild: a sideways wheel swipe keeps the capture camera")
    check(page.locator("#examples-wild .carousel-counter").inner_text() != counter_before,
          f"wild: a sideways wheel swipe moves the carousel ({counter_before} -> "
          f"{page.locator('#examples-wild .carousel-counter').inner_text()})")
    wait_live(page, "#examples-wild")
    wild = live_slide(page, "#examples-wild")
    wild.locator(".viewer-3d").hover()
    scroll_before = page.evaluate("window.scrollY")
    page.mouse.wheel(0, 120)
    time.sleep(0.6)
    check(wild.locator(".viewer-camera").evaluate("b => b.classList.contains('active')"),
          "wild: a vertical wheel keeps the capture camera")
    check(page.evaluate("window.scrollY") != scroll_before,
          "wild: a vertical wheel over a follow card scrolls the page")
    page.evaluate("document.querySelector('#examples-wild').scrollIntoView({block: 'center'})")
    time.sleep(0.4)
    # Dragging away releases the camera, reset comes back to it.
    wild.locator(".viewer-3d").hover()
    page.mouse.down()
    page.mouse.move(400, 500, steps=5)
    page.mouse.up()
    time.sleep(0.3)
    check(not wild.locator(".viewer-camera").evaluate("b => b.classList.contains('active')"),
          "wild: orbiting releases the capture camera")
    wild.locator(".viewer-reset").click()
    check(wild.locator(".viewer-camera").evaluate("b => b.classList.contains('active')"),
          "wild: reset returns to the capture camera")
    page.screenshot(path=f"{OUT}/desktop_wild.png")
    # Fullscreen keeps the half-and-half split: no dead band between the 3D
    # view and the re-rendered frame.
    wild.locator(".viewer-fullscreen").click()
    time.sleep(0.6)
    view3d = wild.locator(".viewer-3d").bounding_box()
    panel = wild.locator(".viewer-panel").bounding_box()
    check(abs(view3d["x"] + view3d["width"] - panel["x"]) <= 1
          and abs(panel["width"] - view3d["width"]) <= 2,
          f"wild fullscreen: 3D view and panel meet, each half the width "
          f"({view3d['width']:.0f} | {panel['width']:.0f})")
    wild.locator(".viewer-fullscreen").click()
    time.sleep(0.5)

    # The agentic timelapse diagram: image decoded, video playing, side by side.
    page.evaluate("document.querySelector('#timelapse-section').scrollIntoView({block: 'center'})")
    page.wait_for_function(
        "document.querySelector('.timelapse-frames').naturalWidth > 0", timeout=30000)
    page.wait_for_function(
        "document.querySelector('.timelapse-video').readyState >= 2", timeout=30000)
    time.sleep(0.8)
    check(page.evaluate("document.querySelector('.timelapse-video').currentTime") > 0,
          "timelapse: video autoplays")
    frames = page.locator(".timelapse-frames").bounding_box()
    video = page.locator(".timelapse-video").bounding_box()
    check(frames["x"] + frames["width"] < video["x"] and abs(frames["width"] - video["width"]) <= 2,
          f"timelapse: frames left of the video, equal widths ({frames['width']:.0f} | {video['width']:.0f})")
    # Its timeline (js/timelapse.js): one slider step per video frame, along
    # the video's bottom edge; scrubbing pauses and seeks, play resumes.
    bar = page.locator(".timelapse-timeline").bounding_box()
    check(bar["x"] > video["x"] and bar["x"] + bar["width"] < video["x"] + video["width"]
          and bar["y"] > video["y"] + video["height"] / 2
          and bar["y"] + bar["height"] < video["y"] + video["height"],
          "timelapse: timeline sits inside the video's bottom edge")
    slider = page.locator(".timelapse-timeline .viewer-slider")
    check(slider.get_attribute("max") == "16", "timelapse: slider has one step per frame (17 frames)")
    check(page.evaluate("document.querySelector('.timelapse-clip').classList.contains('is-playing')"),
          "timelapse: timeline shows the playing state")
    slider.evaluate("s => { s.value = 9; s.dispatchEvent(new Event('input', {bubbles: true})); }")
    page.wait_for_function("document.querySelector('.timelapse-video').seeking === false", timeout=10000)
    time.sleep(0.3)
    clip_time = page.evaluate("document.querySelector('.timelapse-video').currentTime")
    check(page.evaluate("document.querySelector('.timelapse-video').paused") and abs(clip_time - 3.8) < 0.05
          and page.locator(".timelapse-timeline .viewer-count").text_content().strip() == "10 / 17",
          f"timelapse: scrubbing pauses and seeks to the frame (t={clip_time:.2f}, "
          f"'{page.locator('.timelapse-timeline .viewer-count').text_content().strip()}')")
    page.screenshot(path=f"{OUT}/desktop_timelapse.png")
    page.locator(".timelapse-timeline .viewer-play").click()
    time.sleep(0.5)
    check(not page.evaluate("document.querySelector('.timelapse-video').paused"),
          "timelapse: play resumes after a scrub")

    # Back up: ARCTIC takes the renderer again, on the slide it was left at.
    page.evaluate("document.querySelector('#examples-arctic').scrollIntoView({block: 'center'})")
    wait_live(page, "#examples-arctic")
    check(live_slide(page, "#examples-arctic").locator(".viewer-title").text_content() == "Phone",
          "arctic: resumes on the slide it was left at")
    check(page.locator("#examples-hot3d .viewer.is-live").count() == 0
          and page.locator("#examples-wild .viewer.is-live").count() == 0
          and page.evaluate("document.querySelectorAll('.viewer-canvas').length") == 1,
          "arctic: other slides detached, one canvas")

    benign = [e for e in errors if "favicon" not in e]
    check(not benign, f"no console/page errors: {benign[:5]}")
    page.close()


def run_mobile(browser):
    page = browser.new_page(
        viewport={"width": 390, "height": 844}, device_scale_factor=2,
        is_mobile=True, has_touch=True)
    errors = []
    page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
    page.goto(URL)
    page.wait_for_selector("#examples-hot3d .viewer", state="attached", timeout=30000)
    slide = None
    for carousel, tag in (("#examples-arctic", "arctic"),
                          ("#examples-hot3d", "hot3d"), ("#examples-wild", "wild")):
        page.evaluate(f"document.querySelector('{carousel}').scrollIntoView({{block: 'center'}})")
        wait_live(page, carousel, timeout=90000)
        slide = live_slide(page, carousel)
        panel = slide.locator(".viewer-panel").bounding_box()
        timeline = slide.locator(".viewer-timeline").bounding_box()
        buttons = slide.locator(".viewer-topleft").bounding_box()
        if tag == "wild":
            # Split card stacks: the timeline sits above the full-width panel.
            check(timeline["y"] + timeline["height"] <= panel["y"] + 1,
                  f"mobile {tag}: timeline ends ({timeline['y'] + timeline['height']:.0f}) "
                  f"above the stacked panel ({panel['y']:.0f})")
            check(buttons["y"] + buttons["height"] < timeline["y"],
                  f"mobile {tag}: control buttons clear of the timeline")
        else:
            check(panel["y"] + panel["height"] < timeline["y"],
                  f"mobile {tag}: image panel ends ({panel['y'] + panel['height']:.0f}) "
                  f"above timeline ({timeline['y']:.0f})")
            check(buttons["x"] + buttons["width"] < panel["x"],
                  f"mobile {tag}: control buttons clear of the image panel")
        page.screenshot(path=f"{OUT}/mobile_{tag}.png", full_page=False)
    page.evaluate("document.querySelector('#timelapse-section').scrollIntoView({block: 'center'})")
    frames = page.locator(".timelapse-frames").bounding_box()
    video = page.locator(".timelapse-video").bounding_box()
    check(frames["y"] + frames["height"] < video["y"], "mobile timelapse: frames stack above the video")
    page.screenshot(path=f"{OUT}/mobile_timelapse.png", full_page=False)
    check(page.evaluate("document.documentElement.scrollWidth <= 390"),
          "mobile: no horizontal page overflow")
    slide.locator(".viewer-fullscreen").click()
    time.sleep(0.5)
    page.screenshot(path=f"{OUT}/mobile_fullscreen.png")
    check(not errors, f"mobile: no page errors {errors[:3]}")
    page.close()


with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist"])
    run_desktop(browser)
    run_mobile(browser)
    browser.close()

print("\nPROBLEMS:" if problems else "\nALL CHECKS PASSED")
print(f"screenshots in {OUT}")
for item in problems:
    print(" -", item)
sys.exit(1 if problems else 0)
