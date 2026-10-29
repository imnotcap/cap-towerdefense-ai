"""Generates per-area palette textures from the Kenney colormap.

The whole Tower Defense Kit samples one 512x512 palette, so re-colouring the
palette re-themes every model without touching geometry.

    python3 tools/gen-palettes.py
"""
import colorsys
from pathlib import Path

from PIL import Image

TEX = Path(__file__).resolve().parent.parent / "assets/models/kenney-td/Textures"


def remap(img, rules):
    """rules: list of (hue_lo, hue_hi, fn(h, l, s) -> (h, l, s)), hue in degrees."""
    out = img.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b = px[x, y][:3]
            h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            hd = h * 360
            for lo, hi, fn in rules:
                if s > 0.15 and lo <= hd < hi:
                    h2, l2, s2 = fn(hd, l, s)
                    rr, gg, bb = colorsys.hls_to_rgb((h2 % 360) / 360, min(1, max(0, l2)), min(1, max(0, s2)))
                    px[x, y] = (round(rr * 255), round(gg * 255), round(bb * 255), *px[x, y][3:])
                    break
    return out


def main():
    base = Image.open(TEX / "colormap.png").convert("RGBA")

    # Sunscar Dunes: grass becomes pale sand, so the brown road still stands out.
    desert = remap(base, [
        (80, 180, lambda h, l, s: (42, min(0.86, l * 1.35), s * 0.75)),
    ])
    desert.save(TEX / "theme-desert.png")

    # Emberforge: grass becomes scorched basalt, dirt smoulders a dark rust.
    lava = remap(base, [
        (80, 180, lambda h, l, s: (12, l * 0.42, s * 0.25)),
        (5, 45, lambda h, l, s: (h - 10, l * 0.62, s * 0.95)),
    ])
    lava.save(TEX / "theme-lava.png")

    # Umbral Spire: grass becomes violet moss, dirt cold slate.
    dark = remap(base, [
        (80, 180, lambda h, l, s: (272, l * 0.62, s * 0.55)),
        (5, 45, lambda h, l, s: (235, l * 0.7, s * 0.35)),
    ])
    dark.save(TEX / "theme-dark.png")

    # Locked areas on the world map: desaturated and slightly darkened.
    locked = Image.eval(base.convert("LA"), lambda v: int(v * 0.85)).convert("RGBA")
    locked.save(TEX / "theme-locked.png")


if __name__ == "__main__":
    main()
