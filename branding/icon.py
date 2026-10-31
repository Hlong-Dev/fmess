"""fMess icon: a flat speech-bubble ring with an f inside, on graphite,
drawn per size: a little light on the edges when large, plain and sharper
when small, as Apple's own icons are.

    python3 branding/icon.py OUT_DIR [STYLE]   # icon-16.svg ... icon-1024.svg

STYLE: groove (the ring a groove pressed into the icon, faintly tinted with the
gradient, white f), mono (ring and f in one gradient), white (white ring,
gradient f) or inverse (gradient ring, white f).

Render each SVG at its own size (Chrome headless keeps the transparency:
--headless=new --force-device-scale-factor=1 --default-background-color=00000000
--window-size=N,N --screenshot=icon-N.png), copy icon-1024.png to app-icon.png
and run `npx tauri icon app-icon.png` for the Windows and Linux icons, then
replace icon.icns (iconutil -c icns on an .iconset of the per-size PNGs) and
32x32, 64x64, 128x128 and 128x128@2x.png with the per-size renders."""
import math, pathlib, sys

def superellipse(cx, cy, w, h, n, steps=720):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        pts.append(f"{cx + (w/2) * math.copysign(abs(c) ** (2/n), c):.2f},{cy + (h/2) * math.copysign(abs(s) ** (2/n), s):.2f}")
    return "M" + " L".join(pts) + " Z"

SQUIRCLE = superellipse(512, 512, 824, 824, 5.0)
CX, CY, BW, BH, N = 512, 476, 640, 470, 2.7

def bubble(ring):
    outer = superellipse(CX, CY, BW, BH, N)
    inner = superellipse(CX, CY, BW - 2 * ring, BH - 2 * ring, N)
    bottom = CY + BH / 2
    tail = f"M{CX-44},{bottom-40} L{CX+66},{bottom-40} L{CX-40},{bottom+96} Z"
    return outer, inner, tail

F_STEM = "M-21,154 V-18 C-21,-74 9,-100 61,-100 H90"
F_BAR = "M-89,10 H51"
# One gradient across the whole drawing, top left to bottom right.
INK = [("0", "#FF5FAE"), ("0.5", "#A65BFF"), ("1", "#4C9CFF")]
INK_FROM, INK_TO = (250, 240), (780, 800)

def gradient(id_, a, b):
    stops = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in INK)
    return f'<linearGradient id="{id_}" gradientUnits="userSpaceOnUse" x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}">{stops}</linearGradient>'

def svg(size, style, tint=0.18):
    small = size <= 32
    large = size >= 256
    ring = 70 if small else 62
    scale = 1.04 if small else 0.93
    stem, bar = (104, 92) if small else (92, 80)
    outer, inner, tail = bubble(ring)
    fy = CY - 2
    # The f is drawn scaled about its own origin, so its gradient is given in those units.
    local = lambda p: ((p[0] - CX) / scale, (p[1] - fy) / scale)
    ring_fill = {"groove": "#34343C", "mono": "url(#ink)", "white": "url(#white)", "inverse": "url(#ink)"}[style]
    f_stroke = {"groove": "#FFFFFF", "mono": "url(#inklocal)", "white": "url(#inklocal)", "inverse": "#FFFFFF"}[style]
    edge = "" if small else 'filter="url(#edge)"'
    if style == "groove":
        # Small icons can't show the shading, so their groove is a little lighter.
        ring_tint = f'<rect width="1024" height="1024" fill="url(#ink)" opacity="{tint + (0.12 if small else 0)}" mask="url(#bubble)"/>'
        ring_filter = "" if small else 'filter="url(#groove)"'
    else:
        ring_tint, ring_filter = "", edge
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 1024 1024">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B2B31"/><stop offset="1" stop-color="#141417"/></linearGradient>
  <radialGradient id="toplight" cx="0.5" cy="-0.1" r="0.8"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.09"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
  <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#9B5CFF" stop-opacity="0.22"/><stop offset="1" stop-color="#9B5CFF" stop-opacity="0"/></radialGradient>
  <linearGradient id="rim" gradientUnits="userSpaceOnUse" x1="0" y1="100" x2="0" y2="924"><stop offset="0" stop-color="#fff" stop-opacity="0.26"/><stop offset="0.3" stop-color="#fff" stop-opacity="0.05"/><stop offset="1" stop-color="#fff" stop-opacity="0.10"/></linearGradient>
  <linearGradient id="white" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FAFAFC"/><stop offset="1" stop-color="#DCDCE4"/></linearGradient>
  {gradient("ink", INK_FROM, INK_TO)}
  {gradient("inklocal", local(INK_FROM), local(INK_TO))}
  <clipPath id="body"><path d="{SQUIRCLE}"/></clipPath>
  <mask id="bubble" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
    <path d="{outer}" fill="#fff"/>
    <path d="{tail}" fill="#fff" stroke="#fff" stroke-width="26" stroke-linejoin="round"/>
    <path d="{inner}" fill="#000"/>
  </mask>
  <filter id="iconshadow" filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><feDropShadow dx="0" dy="8" stdDeviation="{8 if large else 5}" flood-color="#000" flood-opacity="0.35"/></filter>
  <!-- A thin band of light inside the top edges, Tahoe's only depth cue. -->
  <filter id="edge" filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
    <feOffset in="SourceAlpha" dy="5" result="o"/><feGaussianBlur in="o" stdDeviation="2.5" result="b"/>
    <feComposite in="SourceAlpha" in2="b" operator="out" result="band"/>
    <feFlood flood-color="#FFFFFF" flood-opacity="0.45"/><feComposite in2="band" operator="in" result="light"/>
    <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="light"/></feMerge></filter>
  <!-- Pressed in: shade under the top edges, a little light along the bottom ones. -->
  <filter id="groove" filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
    <feOffset in="SourceAlpha" dy="12" result="down"/><feGaussianBlur in="down" stdDeviation="7" result="downBlur"/>
    <feComposite in="SourceAlpha" in2="downBlur" operator="out" result="topBand"/>
    <feFlood flood-color="#000000" flood-opacity="0.62"/><feComposite in2="topBand" operator="in" result="shade"/>
    <feOffset in="SourceAlpha" dy="-6" result="up"/><feGaussianBlur in="up" stdDeviation="3" result="upBlur"/>
    <feComposite in="SourceAlpha" in2="upBlur" operator="out" result="bottomBand"/>
    <feFlood flood-color="#FFFFFF" flood-opacity="0.16"/><feComposite in2="bottomBand" operator="in" result="lip"/>
    <feMerge result="pressed"><feMergeNode in="SourceGraphic"/><feMergeNode in="shade"/><feMergeNode in="lip"/></feMerge>
    <feGaussianBlur in="pressed" stdDeviation="1.2"/></filter>
</defs>
<g filter="url(#iconshadow)"><path d="{SQUIRCLE}" fill="url(#bg)"/></g>
<g clip-path="url(#body)">
  <rect width="1024" height="1024" fill="url(#toplight)"/>
  {'' if small else f'<ellipse cx="{CX}" cy="{CY}" rx="300" ry="230" fill="url(#glow)"/>'}
  <path d="{SQUIRCLE}" fill="none" stroke="url(#rim)" stroke-width="{6 if large else 10}"/>
</g>
<g {ring_filter}><rect width="1024" height="1024" fill="{ring_fill}" mask="url(#bubble)"/>{ring_tint}</g>
<g {edge}><g transform="translate({CX},{fy}) scale({scale})" fill="none" stroke="{f_stroke}" stroke-linecap="butt" stroke-linejoin="round">
  <path d="{F_STEM}" stroke-width="{stem}"/><path d="{F_BAR}" stroke-width="{bar}"/>
</g></g>
</svg>'''

if __name__ == "__main__":
    out = pathlib.Path(sys.argv[1])
    style = sys.argv[2] if len(sys.argv) > 2 else "groove"
    for size in (16, 32, 64, 128, 256, 512, 1024):
        (out / f"icon-{size}.svg").write_text(svg(size, style))
