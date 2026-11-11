"""Traces the app icons (512 px PNG artwork) into the SVG masters in branding/.

    python -m venv .venv && .venv/Scripts/pip install vtracer pillow
    .venv/Scripts/python tools/trace-logo.py

Tracing the artwork as it is gives jagged, haloed edges: the tracer turns
every anti-aliased in-between colour into a sliver of its own. So each icon
is first upscaled to 2048 px, smoothed, and snapped to its few real colours
(the palettes below, measured from the artwork's flat fills), then traced.
The result is about 17 shapes per icon, within about 3/255 per pixel of the
original. Writes branding/<edition>-icon.svg.
"""

import os
import re

import vtracer
from PIL import Image, ImageFilter

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ICONS = {
    "connect": ("PeerPayload Connect", "connect/desktop/resources/icon.png",
                ["#fc9636", "#fcae36", "#1e1e1e", "#6c6c72"]),
    "enterprise": ("PeerPayload Enterprise", "desktop/resources/icon.png",
                   ["#1a1919", "#f1eee5", "#d0ccc6", "#fd6614"]),
}

SIZE = 2048


def flatten(src, colours):
    """Upscaled, smoothed, every pixel one of `colours`; corners fully in or out."""
    img = Image.open(src).convert("RGBA")
    alpha = img.getchannel("A").resize((SIZE, SIZE), Image.LANCZOS).point(lambda a: 255 if a >= 128 else 0)
    rgb = img.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS).filter(ImageFilter.MedianFilter(5))

    rgb_values = sum((list(bytes.fromhex(c[1:])) for c in colours), [])
    palette = Image.new("P", (1, 1))
    palette.putpalette(rgb_values + rgb_values[:3] * (256 - len(colours)))

    flat = rgb.quantize(palette=palette, dither=Image.Dither.NONE).convert("RGBA")
    flat.putalpha(alpha)
    return flat


def main():
    for edition, (title, png, colours) in ICONS.items():
        flat_path = os.path.join(REPO, "branding", f".{edition}-flat.png")
        out = os.path.join(REPO, "branding", f"{edition}-icon.svg")

        flatten(os.path.join(REPO, png), colours).save(flat_path)
        vtracer.convert_image_to_svg_py(
            flat_path, out, colormode="color", hierarchical="stacked", mode="spline",
            filter_speckle=16, color_precision=8, layer_difference=4, corner_threshold=90,
            length_threshold=6.0, splice_threshold=45, path_precision=2,
        )
        os.remove(flat_path)

        # A viewBox (so it scales), a title, and where it came from.
        svg = open(out, encoding="utf-8").read()
        svg = re.sub(r"<!-- Generator: [^>]*-->\n",
                     f"<!-- {title} app icon. Traced from the original 512 px artwork by tools/trace-logo.py (VTracer); see branding/README.md. -->\n", svg)
        svg = svg.replace(f'width="{SIZE}" height="{SIZE}">',
                          f'viewBox="0 0 {SIZE} {SIZE}" role="img" aria-label="{title}">\n<title>{title}</title>', 1)
        open(out, "w", encoding="utf-8", newline="\n").write(svg)
        print(f"wrote {os.path.relpath(out, REPO)}: {svg.count('<path')} paths, {len(svg) // 1024} KB")


if __name__ == "__main__":
    main()
