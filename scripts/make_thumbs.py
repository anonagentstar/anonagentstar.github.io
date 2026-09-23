"""Square thumbnails for the carousel navigation, one per example.

Usage: python scripts/make_thumbs.py [ASSET_DIR ...]
  ASSET_DIR   baked asset dirs to update (default: assets/arctic assets/hot3d assets/wild)

The thumbnail is the example's FIRST observed frame. For examples whose panel
is our re-rendered parts (the in-the-wild bakes: meta.panel == "render") the
render is composited over the frame with the same alpha the page uses, and the
square crop is centred on the parts; otherwise the crop is the frame's centre.
Writes <asset dir>/<id>/thumb.webp and points index.json's "thumb" at it.
Needs opencv."""
import json
import os
import sys

import cv2
import numpy as np

SIDE = 112            # px, shown at 56 css px (2x)
RENDER_ALPHA = 0.82   # js/viewer.js RENDER_ALPHA
ASSET_DIRS = sys.argv[1:] or ["assets/arctic", "assets/hot3d", "assets/wild"]


def composite(frame, render):
    """frame BGR uint8 + render BGRA uint8 -> BGR, the render at RENDER_ALPHA."""
    alpha = render[:, :, 3:4].astype(np.float32) / 255.0 * RENDER_ALPHA
    out = frame.astype(np.float32) * (1 - alpha) + render[:, :, :3].astype(np.float32) * alpha
    return np.clip(out, 0, 255).astype(np.uint8)


def square_crop(image, centre):
    h, w = image.shape[:2]
    side = min(h, w)
    cx, cy = centre
    x0 = int(round(min(max(cx - side / 2, 0), w - side)))
    y0 = int(round(min(max(cy - side / 2, 0), h - side)))
    return image[y0:y0 + side, x0:x0 + side]


def thumbnail(example_dir, meta):
    frame = cv2.imread(os.path.join(example_dir, meta["files"]["frame"].format(index=0)))
    if frame is None:
        raise FileNotFoundError(example_dir)
    h, w = frame.shape[:2]
    centre = (w / 2, h / 2)
    if meta.get("panel") == "render" and "render" in meta["files"]:
        render = cv2.imread(os.path.join(example_dir, meta["files"]["render"].format(index=0)),
                            cv2.IMREAD_UNCHANGED)
        if render is not None and render.shape[2] == 4:
            if render.shape[:2] != frame.shape[:2]:
                render = cv2.resize(render, (w, h), interpolation=cv2.INTER_AREA)
            frame = composite(frame, render)
            ys, xs = np.nonzero(render[:, :, 3] > 0)
            if len(xs):
                centre = (xs.mean(), ys.mean())
    crop = square_crop(frame, centre)
    return cv2.resize(crop, (SIDE, SIDE), interpolation=cv2.INTER_AREA)


def main():
    total = 0
    for asset_dir in ASSET_DIRS:
        index_path = os.path.join(asset_dir, "index.json")
        with open(index_path) as fh:
            index = json.load(fh)
        for example in index["examples"]:
            example_dir = os.path.join(asset_dir, example["id"])
            with open(os.path.join(example_dir, "meta.json")) as fh:
                meta = json.load(fh)
            out = os.path.join(example_dir, "thumb.webp")
            ok = cv2.imwrite(out, thumbnail(example_dir, meta), [cv2.IMWRITE_WEBP_QUALITY, 82])
            if not ok:
                raise RuntimeError(f"failed to write {out}")
            example["thumb"] = "thumb.webp"
            size = os.path.getsize(out)
            total += size
            print(f"{out}: {size / 1024:.0f} KB")
        with open(index_path, "w") as fh:
            json.dump(index, fh, separators=(",", ":"))
    print(f"thumbs total {total / 1024:.0f} KB")


if __name__ == "__main__":
    main()
