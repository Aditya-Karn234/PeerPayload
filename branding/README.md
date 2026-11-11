# Branding

Vector masters of the two app icons:

| File | Edition | Colours |
|---|---|---|
| `connect-icon.svg` | PeerPayload Connect | `#fc9636` `#fcae36` `#1e1e1e` `#6c6c72` |
| `enterprise-icon.svg` | PeerPayload Enterprise | `#1a1919` `#f1eee5` `#d0ccc6` `#fd6614` |

They scale to any size: use them for the website, README badges, store
listings, print, and as the source for new icon sizes.

## Where they come from

The original artwork exists only as 512 × 512 px PNGs (the apps'
`resources/icon.png`). `tools/trace-logo.py` traces those into these SVGs:
it upscales each to 2048 px, snaps every pixel to the icon's four real
colours (tracing the anti-aliased edges as they are gave jagged, haloed
outlines), then traces the result with VTracer. Each icon becomes about 17
shapes, within about 3/255 per pixel of the original.

Two details simplify in the trace: the tiny orange glint in the Connect
raven's eye, and a faint grey edge along some of Enterprise's white strokes.
Neither shows at icon sizes. If a hand-drawn vector of either logo is ever
made, it replaces the traced one here.

## Elsewhere in the repository

- `packages/ui/src/Brand.jsx` has `RavenMark`, a simpler raven drawn
  directly in SVG for small in-app use. It's a different drawing from these
  icons.
- The app icons themselves (Windows `.ico`, tray icons, Android launcher
  icons) are still the original bitmaps; they aren't generated from these
  files yet.
