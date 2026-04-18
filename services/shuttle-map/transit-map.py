#!/usr/bin/env python3
"""
Yale Shuttle — Transit Map

High-quality schematic transit map rendered with Cairo + PangoCairo.
Clean retro transit aesthetic with modern crispness.

Usage:
    shuttle-map              # generate + open
    shuttle-map --serve      # live at localhost:8090 (auto-refresh)
    shuttle-map --once       # generate PNG only
"""

import math
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import cairo
import gi
gi.require_version("Pango", "1.0")
gi.require_version("PangoCairo", "1.0")
from gi.repository import Pango, PangoCairo

DB_PATH = os.environ.get(
    "SHUTTLE_DB",
    str(Path(__file__).resolve().parent.parent.parent / "store" / "shuttle.db"),
)
OUT_PNG = Path(__file__).resolve().parent / "map.png"

# ── Canvas ─────────────────────────────────────────────────────────────────

W, H = 1800, 2100
SCALE = 2            # draw at 2x, downsample for crispness
CW, CH = W * SCALE, H * SCALE

# ── Palette ────────────────────────────────────────────────────────────────

def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) / 255.0 for i in (0, 2, 4))

C = {
    "bg":       hex_rgb("#F7F6F3"),     # warm off-white
    "blue":     hex_rgb("#1565C0"),     # deep blue
    "red":      hex_rgb("#C62828"),     # deep red
    "orange":   hex_rgb("#E65100"),     # deep orange
    "cyan":     hex_rgb("#00838F"),     # deep teal
    "green":    hex_rgb("#2E7D32"),     # deep green
    "black":    hex_rgb("#1A1A2E"),     # near-black navy
    "label":    hex_rgb("#37474F"),     # blue-grey
    "sublabel": hex_rgb("#78909C"),     # lighter blue-grey
    "white":    hex_rgb("#FFFFFF"),
    "dot_ring": hex_rgb("#263238"),     # dark station ring
    "shadow":   (0, 0, 0),             # for alpha shadows
}

LINE_W = 12 * SCALE
STATION_R = 8 * SCALE
INTERCHANGE_R = 10 * SCALE
HOME_R = 12 * SCALE
BUS_R = 16 * SCALE

# ── Font helper ────────────────────────────────────────────────────────────

def make_layout(ctx, text, font_desc):
    layout = PangoCairo.create_layout(ctx)
    layout.set_text(text, -1)
    layout.set_font_description(font_desc)
    return layout

def font(family="Nunito Sans", size=13, weight="normal"):
    desc = Pango.FontDescription()
    desc.set_family(family)
    desc.set_size(int(size * SCALE * Pango.SCALE))
    if weight == "bold":
        desc.set_weight(Pango.Weight.BOLD)
    elif weight == "semibold":
        desc.set_weight(Pango.Weight.SEMIBOLD)
    elif weight == "light":
        desc.set_weight(Pango.Weight.LIGHT)
    return desc

FONT_TITLE = font("Nunito Sans", 32, "bold")
FONT_SUBTITLE = font("Nunito Sans", 13, "light")
FONT_STATION = font("Nunito Sans", 12, "normal")
FONT_STATION_B = font("Nunito Sans", 12, "semibold")
FONT_HOME = font("Nunito Sans", 13, "bold")
FONT_BUS = font("Nunito Sans", 9, "bold")
FONT_LEGEND = font("Nunito Sans", 11, "normal")
FONT_LEGEND_B = font("Nunito Sans", 11, "semibold")

# ── Schematic station positions ────────────────────────────────────────────
# (x, y, label, label_side, stop_ids)  — coordinates at 1x, scaled at draw time

S = {
    # Red north
    "winchester":  (240, 155, "Winchester",      "l", [11]),
    "division":    (560, 155, "Division",        "r", [48, 49]),
    "winch_sach":  (240, 340, "Winch / Sachem",  "l", [147]),

    # Blue north
    "huntington":  (700, 155, "Huntington",      "r", [105, 69]),
    "wh_hunt":     (860, 155, "Whitney / Hunt",  "r", [139]),
    "wh_canner":   (860, 340, "Canner",          "r", [129, 29]),
    "wh_cottage":  (860, 460, "Cottage",         "r", [133, 132]),
    "peabody":     (860, 580, "Peabody",         "r", [97]),

    # Orange east
    "or_canner":   (1010, 340, "Orange",         "r", [82]),
    "foster":      (1010, 460, "Foster",         "r", [57, 88]),
    "audubon":     (910, 630, "Audubon",         "r", [19]),

    # Prospect spine
    "pr_canner":   (560, 380, "Prospect / Canner", "r", [100]),
    "pr_sachem":   (560, 460, "Prospect / Sachem",  "r", [106, 107]),
    "pr_130":      (560, 535, "130 Prospect St",    "r", [3, 4]),
    "becton":      (560, 615, "Becton",              "r", [20]),

    # Central
    "wall":        (560, 700, "College / Wall",  "l", [41, 42]),
    "grove":       (800, 700, "Grove / Temple",  "r", [63, 64, 118]),
    "phelps":      (560, 790, "Phelps Gate",     "r", [98]),

    # Blue West
    "pauli":       (180, 535, "Pauli Murray",    "l", [164]),
    "howard":      (180, 1050, "Howard",         "l", [153, 154]),

    # South trunk
    "crown":       (560, 875, "Crown",           "l", [38]),
    "george":      (560, 950, "George",          "l", [39, 9]),
    "leph":        (560, 1030, "LEPH",           "l", [72]),

    # York leg
    "york_129":    (450, 1125, "129 York",       "l", [2]),
    "york_180":    (450, 1200, "180 York",       "l", [5]),
    "elm_york":    (450, 1270, "Elm / York",     "l", [52, 53]),

    # Cedar / south
    "cedar":       (680, 1125, "333 Cedar",      "r", [10, 43]),
    "amistad":     (680, 1200, "Amistad",        "r", [13, 14]),
    "union":       (560, 1310, "Union Station",  "r", [121]),
    "state_st":    (680, 1310, "State St",       "r", [115]),
    "chapel":      (810, 1200, "Chapel",         "r", [30, 31]),
}

HOME_KEY = "pr_canner"
INTERCHANGES = {"wall", "grove", "phelps", "crown", "george", "leph",
                "york_129", "elm_york", "cedar", "union", "pr_canner"}

# ── Route lines ────────────────────────────────────────────────────────────

ROUTES = [
    # Shared College trunk (parallel Red left, Orange right)
    ("red",    [(555, 700), (555, 1030)]),
    ("orange", [(565, 700), (565, 1030)]),
    # Shared York leg (parallel Blue left, Orange right)
    ("blue",   [(445, 1125), (445, 1270)]),
    ("orange", [(455, 1125), (455, 1270)]),

    # Red
    ("red", [(240, 155), (560, 155)]),           # Winchester → Division
    ("red", [(240, 155), (240, 340)]),           # Winchester ↓ Winch/Sachem
    ("red", [(240, 340), (560, 340)]),           # Winch/Sachem → across
    ("red", [(560, 155), (560, 700)]),           # Division ↓ Wall
    ("red", [(560, 1030), (680, 1125)]),         # LEPH ↘ Cedar
    ("red", [(680, 1125), (680, 1200)]),         # Cedar ↓ Amistad
    ("red", [(680, 1200), (560, 1310)]),         # Amistad ↙ Union
    ("red", [(560, 1310), (680, 1310)]),         # Union → State St
    ("red", [(680, 1200), (810, 1200)]),         # Amistad → Chapel

    # Blue
    ("blue", [(560, 155), (860, 155)]),          # Division → Whitney/Hunt
    ("blue", [(860, 155), (860, 580)]),          # Whitney ↓
    ("blue", [(860, 580), (800, 700)]),          # Peabody ↘ Grove
    ("blue", [(560, 700), (800, 700)]),          # Wall → Grove
    ("blue", [(560, 1030), (450, 1125)]),        # LEPH ↙ York

    # Orange
    ("orange", [(860, 340), (1010, 340)]),       # Canner → Orange branch
    ("orange", [(1010, 340), (1010, 460)]),      # Orange ↓ Foster
    ("orange", [(1010, 460), (910, 630)]),       # Foster ↘ Audubon
    ("orange", [(910, 630), (800, 700)]),        # Audubon ↘ Grove
    ("orange", [(560, 700), (800, 700)]),        # Wall → Grove
    ("orange", [(560, 1030), (450, 1125)]),      # LEPH ↙ York

    # Blue West
    ("cyan", [(180, 340), (180, 1050)]),         # Canal area ↓ Howard
    ("cyan", [(180, 790), (560, 790)]),          # across to Phelps
    ("cyan", [(180, 1050), (450, 1050), (450, 1125)]),  # Howard → York
    ("cyan", [(450, 1125), (680, 1125)]),        # York → Cedar
]

# Direction arrows
ARROWS = [
    (240, 250, 270, "red"), (400, 155, 0, "red"), (560, 280, 90, "red"),
    (560, 550, 90, "red"), (620, 1078, 45, "red"),
    (710, 155, 0, "blue"), (860, 280, 90, "blue"), (860, 490, 90, "blue"),
    (935, 340, 0, "orange"), (1010, 400, 90, "orange"),
    (180, 690, 90, "cyan"), (180, 920, 90, "cyan"), (370, 790, 0, "cyan"),
    (555, 850, 90, "red"), (565, 850, 90, "orange"),
    (555, 970, 90, "red"), (565, 970, 90, "orange"),
    (445, 1190, 90, "blue"), (455, 1190, 90, "orange"),
]

# ── Data ───────────────────────────────────────────────────────────────────

STOP_TO_STATION = {}
ROUTE_COLOR_MAP = {
    1: "blue", 3: "red", 4: "blue", 13: "blue", 14: "orange",
    16: "cyan", 17: "orange", 2: "orange",
}
ROUTE_LABEL_MAP = {
    1: "Blue", 3: "Red", 4: "Blue", 13: "Blue", 14: "Orange",
    16: "West", 17: "Org", 2: "Orange",
}

def _build_stop_map():
    if STOP_TO_STATION:
        return
    for key, (*_, stop_ids) in S.items():
        for sid in stop_ids:
            STOP_TO_STATION[sid] = key

def get_buses():
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception:
        return []
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute("""
            WITH latest AS (
                SELECT bus_id, bus_name, route_id, last_stop_id,
                       ROW_NUMBER() OVER (PARTITION BY bus_id ORDER BY collected_at DESC) as rn
                FROM bus_positions WHERE collected_at > datetime('now', '-2 minutes')
            )
            SELECT bus_id, bus_name, route_id, last_stop_id FROM latest WHERE rn = 1
        """).fetchall()
    except Exception:
        rows = []
    db.close()
    return rows

# ── Cairo drawing helpers ──────────────────────────────────────────────────

def sc(v):
    """Scale a coordinate for the supersampled canvas."""
    return v * SCALE

def scp(xy):
    """Scale a point tuple."""
    return (xy[0] * SCALE, xy[1] * SCALE)

def set_color(ctx, key, alpha=1.0):
    r, g, b = C[key]
    ctx.set_source_rgba(r, g, b, alpha)

def draw_route(ctx, points, color_key):
    ctx.set_line_width(LINE_W)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    set_color(ctx, color_key)
    ctx.move_to(*scp(points[0]))
    for p in points[1:]:
        ctx.line_to(*scp(p))
    ctx.stroke()

def draw_arrow(ctx, x, y, angle_deg, color_key, size=10):
    a = math.radians(angle_deg)
    sz = size * SCALE
    ctx.save()
    ctx.translate(sc(x), sc(y))
    ctx.rotate(a)
    set_color(ctx, color_key)
    ctx.move_to(sz, 0)
    ctx.line_to(-sz * 0.6, -sz * 0.55)
    ctx.line_to(-sz * 0.6, sz * 0.55)
    ctx.close_path()
    ctx.fill()
    ctx.restore()

def draw_station(ctx, x, y, style="normal"):
    sx, sy = sc(x), sc(y)
    if style == "home":
        r = HOME_R
        # Soft shadow
        set_color(ctx, "shadow", 0.15)
        ctx.arc(sx + 3, sy + 3, r + 2, 0, 2 * math.pi)
        ctx.fill()
        # Green fill
        set_color(ctx, "green")
        ctx.arc(sx, sy, r, 0, 2 * math.pi)
        ctx.fill()
        # White ring
        ctx.set_line_width(3 * SCALE)
        set_color(ctx, "white")
        ctx.arc(sx, sy, r, 0, 2 * math.pi)
        ctx.stroke()
    elif style == "interchange":
        r = INTERCHANGE_R
        set_color(ctx, "white")
        ctx.arc(sx, sy, r, 0, 2 * math.pi)
        ctx.fill()
        ctx.set_line_width(2.5 * SCALE)
        set_color(ctx, "dot_ring")
        ctx.arc(sx, sy, r, 0, 2 * math.pi)
        ctx.stroke()
    else:
        r = STATION_R
        set_color(ctx, "white")
        ctx.arc(sx, sy, r, 0, 2 * math.pi)
        ctx.fill()
        ctx.set_line_width(2 * SCALE)
        set_color(ctx, "dot_ring")
        ctx.arc(sx, sy, r, 0, 2 * math.pi)
        ctx.stroke()

def draw_label(ctx, x, y, text, side, font_desc, color_key="label"):
    layout = make_layout(ctx, text, font_desc)
    ink, logical = layout.get_pixel_extents()
    tw = logical.width
    th = logical.height
    set_color(ctx, color_key)
    if side == "r":
        ctx.move_to(sc(x) + 18 * SCALE, sc(y) - th / 2)
    else:
        ctx.move_to(sc(x) - tw - 18 * SCALE, sc(y) - th / 2)
    PangoCairo.show_layout(ctx, layout)

def draw_bus(ctx, x, y, name, color_key):
    sx, sy = sc(x), sc(y)
    r = BUS_R
    # Shadow
    set_color(ctx, "shadow", 0.2)
    ctx.arc(sx + 2, sy + 2, r, 0, 2 * math.pi)
    ctx.fill()
    # Colored circle
    set_color(ctx, color_key)
    ctx.arc(sx, sy, r, 0, 2 * math.pi)
    ctx.fill()
    # White border
    ctx.set_line_width(2.5 * SCALE)
    set_color(ctx, "white")
    ctx.arc(sx, sy, r, 0, 2 * math.pi)
    ctx.stroke()
    # Bus number
    layout = make_layout(ctx, name, FONT_BUS)
    ink, logical = layout.get_pixel_extents()
    tw, th = logical.width, logical.height
    set_color(ctx, "white")
    ctx.move_to(sx - tw / 2, sy - th / 2)
    PangoCairo.show_layout(ctx, layout)

# ── Render ─────────────────────────────────────────────────────────────────

def render():
    _build_stop_map()

    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, CW, CH)
    ctx = cairo.Context(surface)

    # Anti-aliasing
    ctx.set_antialias(cairo.ANTIALIAS_BEST)

    # Background
    set_color(ctx, "bg")
    ctx.rectangle(0, 0, CW, CH)
    ctx.fill()

    # Subtle top accent bar
    set_color(ctx, "black")
    ctx.rectangle(0, 0, CW, 8 * SCALE)
    ctx.fill()

    # Title
    ctx.move_to(sc(55), sc(45))
    set_color(ctx, "black")
    layout = make_layout(ctx, "YALE SHUTTLE", FONT_TITLE)
    PangoCairo.show_layout(ctx, layout)

    # Timestamp
    t = time.strftime("%-I:%M %p")
    layout_t = make_layout(ctx, t, FONT_SUBTITLE)
    ink, logical = layout_t.get_pixel_extents()
    set_color(ctx, "sublabel")
    ctx.move_to(CW - logical.width - sc(55), sc(55))
    PangoCairo.show_layout(ctx, layout_t)

    # Thin separator line
    ctx.set_line_width(1 * SCALE)
    set_color(ctx, "sublabel", 0.3)
    ctx.move_to(sc(55), sc(90))
    ctx.line_to(CW - sc(55), sc(90))
    ctx.stroke()

    # Draw route lines
    for color_key, points in ROUTES:
        draw_route(ctx, points, color_key)

    # Direction arrows
    for x, y, angle, ck in ARROWS:
        draw_arrow(ctx, x, y, angle, ck, size=9)

    # Draw stations
    for key, (x, y, label, side, _) in S.items():
        if key == HOME_KEY:
            style = "home"
        elif key in INTERCHANGES:
            style = "interchange"
        else:
            style = "normal"
        draw_station(ctx, x, y, style)

        if label:
            if key == HOME_KEY:
                draw_label(ctx, x, y, label, side, FONT_HOME, "green")
            else:
                draw_label(ctx, x, y, label, side, FONT_STATION)

    # Overlay live buses
    buses = get_buses()
    for bus in buses:
        stn_key = STOP_TO_STATION.get(bus["last_stop_id"])
        if not stn_key or stn_key not in S:
            continue
        sx, sy = S[stn_key][0], S[stn_key][1]
        ck = ROUTE_COLOR_MAP.get(bus["route_id"], "black")
        name = bus["bus_name"].replace("#", "")
        draw_bus(ctx, sx + 25, sy - 22, name, ck)

    # Legend bar at bottom
    ly = H - 60
    ctx.set_line_width(1 * SCALE)
    set_color(ctx, "sublabel", 0.3)
    ctx.move_to(sc(55), sc(ly - 20))
    ctx.line_to(CW - sc(55), sc(ly - 20))
    ctx.stroke()

    lx = 55
    for label, ck in [("Blue", "blue"), ("Red", "red"), ("Orange", "orange"), ("Blue West", "cyan")]:
        # Route line sample
        ctx.set_line_width(6 * SCALE)
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        set_color(ctx, ck)
        ctx.move_to(sc(lx), sc(ly + 8))
        ctx.line_to(sc(lx + 30), sc(ly + 8))
        ctx.stroke()
        # Label
        layout = make_layout(ctx, label, FONT_LEGEND)
        set_color(ctx, "label")
        ctx.move_to(sc(lx + 38), sc(ly))
        PangoCairo.show_layout(ctx, layout)
        ink, logical = layout.get_pixel_extents()
        lx += logical.width / SCALE + 70

    # Home marker
    draw_station(ctx, lx, ly + 8, "home")
    draw_label(ctx, lx, ly + 8, "Home", "r", FONT_LEGEND_B, "green")

    # Downsample for crispness
    final = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    fctx = cairo.Context(final)
    fctx.scale(1 / SCALE, 1 / SCALE)
    fctx.set_source_surface(surface, 0, 0)
    fctx.get_source().set_filter(cairo.FILTER_BILINEAR)
    fctx.paint()

    final.write_to_png(str(OUT_PNG))
    return str(OUT_PNG)

# ── Serve mode ─────────────────────────────────────────────────────────────

def serve(png_path):
    import http.server
    import socket

    HTML = """<!DOCTYPE html>
<html><head>
<title>Yale Shuttle</title>
<meta http-equiv="refresh" content="5">
<style>
body{margin:0;display:flex;justify-content:center;align-items:center;
min-height:100vh;background:#E8E5E0;font-family:'Nunito Sans',sans-serif;}
img{max-height:98vh;width:auto;border-radius:8px;
box-shadow:0 4px 24px rgba(0,0,0,0.12);}
</style>
</head><body><img src="/map.png?t=TIMESTAMP" /></body></html>"""

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/map.png"):
                render()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                with open(png_path, "rb") as f:
                    self.wfile.write(f.read())
            else:
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(HTML.replace("TIMESTAMP", str(int(time.time()))).encode())
        def log_message(self, *a): pass

    port = 8090
    server = http.server.HTTPServer(("0.0.0.0", port), Handler)
    server.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    print(f"Shuttle map → http://localhost:{port}")
    print("Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()

# ── Main ───────────────────────────────────────────────────────────────────

def main():
    out = render()
    print(f"Map → {out}")
    if "--once" in sys.argv:
        return
    if "--serve" in sys.argv:
        serve(out)
        return
    try:
        subprocess.Popen(["xdg-open", out], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        print("Open manually:", out)

if __name__ == "__main__":
    main()
