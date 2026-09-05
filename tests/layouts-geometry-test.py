#!/usr/bin/env python3
"""Geometry bench for designed layouts.

Drives the real `apply_omarchy_spacing` against synthetic screens so every
resolution, scale, offset and reserved-area combination can be checked without
plugging in hardware. Each case asserts the placement Hyprland's own tiling
would produce: gaps_out+border at a screen edge, gaps_in+border at a boundary
with another window, nothing overlapping, nothing outside the usable area.

    python3 tests/layouts-geometry-test.py
"""

import importlib.machinery
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_loader(
    "layouts", importlib.machinery.SourceFileLoader("layouts", os.path.join(HERE, "..", "extensions", "layouts", "layouts")))
layouts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layouts)

GAPS_IN, GAPS_OUT, BORDER = 5, 10, 2

SCREENS = [
    # name,             px_w, px_h, scale, x,    y, reserved [l,t,r,b]
    ("1080p bare",       1920, 1080, 1.0,     0, 0, [0, 0, 0, 0]),
    ("1080p + bar",      1920, 1080, 1.0,     0, 0, [0, 26, 0, 0]),
    ("1440p@1.25 bar+dock", 2560, 1440, 1.25,  0, 0, [0, 26, 0, 55]),
    ("4K@2 hidpi",       3840, 2160, 2.0,     0, 0, [0, 26, 0, 0]),
    ("second screen",    1920, 1080, 1.0,  2048, 0, [0, 26, 0, 55]),
    ("right of second",  2560, 1440, 1.25, 3968, 0, [0, 26, 0, 55]),
    ("ultrawide",        3440, 1440, 1.0,     0, 0, [0, 26, 0, 0]),
    ("portrait",         1080, 1920, 1.0,     0, 0, [0, 26, 0, 0]),
    ("left bar",         1920, 1080, 1.0,     0, 0, [40, 0, 0, 0]),
    ("small laptop",     1366,  768, 1.0,     0, 0, [0, 26, 0, 0]),
]


def leaf(): return {"leaf": True}
def split(v, a, b, r=0.5): return {"leaf": False, "vertical": v, "ratio": r, "a": a, "b": b}

PRESETS = {
    "full": leaf(),
    "halves": split(True, leaf(), leaf()),
    "thirds": split(True, leaf(), split(True, leaf(), leaf()), 1 / 3),
    "quarters": split(True, split(False, leaf(), leaf()), split(False, leaf(), leaf())),
    "main-stack": split(True, leaf(), split(False, leaf(), leaf()), 0.62),
    "deep": split(True, split(False, leaf(), split(True, leaf(), leaf())),
                  split(False, split(True, leaf(), leaf()), leaf()), 0.45),
}


def rects(node, x, y, w, h, out):
    if node["leaf"]:
        out.append({"x": x, "y": y, "w": w, "h": h})
        return
    if node["vertical"]:
        aw = w * node["ratio"]
        rects(node["a"], x, y, aw, h, out)
        rects(node["b"], x + aw, y, w - aw, h, out)
    else:
        ah = h * node["ratio"]
        rects(node["a"], x, y, w, ah, out)
        rects(node["b"], x, y + ah, w, h - ah, out)


def build_case(screen, tree):
    name, px_w, px_h, scale, mx, my, reserved = screen
    lw, lh = int(round(px_w / scale)), int(round(px_h / scale))
    res = list(reserved)
    if layouts.IGNORE_BOTTOM_RESERVED:
        res[3] = 0
    usable = {"x": res[0] / lw, "y": res[1] / lh,
              "w": 1 - (res[0] + res[2]) / lw, "h": 1 - (res[1] + res[3]) / lh}
    slots = []
    rects(tree, usable["x"], usable["y"], usable["w"], usable["h"], slots)
    layout = {
        "designed": True,
        "designerUsable": usable,
        "monitors": [{"name": name}],
        "windows": [{"class": "x", "frac": [s["x"], s["y"], s["w"], s["h"]],
                     "at": [0, 0], "size": [0, 0]} for s in slots],
    }
    return layout, lw, lh, mx, my, res


def install_stub(screen):
    name, px_w, px_h, scale, mx, my, reserved = screen

    def fake_hypr(*args):
        if args and args[0] == "monitors":
            return [{"name": name, "width": px_w, "height": px_h, "scale": scale,
                     "x": mx, "y": my, "reserved": list(reserved)}]
        if args and args[0] == "getoption":
            option = args[1]
            if "border_size" in option:
                return {"int": BORDER}
            value = GAPS_IN if "gaps_in" in option else GAPS_OUT
            return {"css": "%d %d %d %d" % (value, value, value, value)}
        return None

    layouts.hypr = fake_hypr


failures = []
checked = 0


def check(case, condition, detail):
    global checked
    checked += 1
    if not condition:
        failures.append("%s: %s" % (case, detail))


for screen in SCREENS:
    install_stub(screen)
    for preset_name, tree in PRESETS.items():
        case = "%-22s %-11s" % (screen[0], preset_name)
        layout, lw, lh, mx, my, res = build_case(screen, tree)
        layouts.apply_omarchy_spacing(layout)
        wins = layout["windows"]

        boxes = [(w["at"][0], w["at"][1], w["size"][0], w["size"][1]) for w in wins]

        # 1. positive sizes
        check(case, all(w > 0 and h > 0 for _, _, w, h in boxes),
              "non-positive size %s" % boxes)

        # 2. inside the monitor's usable area, in global coordinates
        left_edge = mx + res[0]
        top_edge = my + res[1]
        right_edge = mx + lw - res[2]
        bottom_edge = my + lh - res[3]
        for x, y, w, h in boxes:
            check(case, x >= left_edge and y >= top_edge
                  and x + w <= right_edge and y + h <= bottom_edge,
                  "window (%d,%d %dx%d) outside usable [%d,%d..%d,%d]"
                  % (x, y, w, h, left_edge, top_edge, right_edge, bottom_edge))

        # 3. no overlap
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                ax, ay, aw, ah = boxes[i]
                bx, by, bw, bh = boxes[j]
                overlap = (min(ax + aw, bx + bw) - max(ax, bx) > 0
                           and min(ay + ah, by + bh) - max(ay, by) > 0)
                check(case, not overlap, "overlap between %s and %s" % (boxes[i], boxes[j]))

        # 4. outer edges use gaps_out+border, exactly
        outer = GAPS_OUT + BORDER
        check(case, min(x for x, _, _, _ in boxes) == left_edge + outer,
              "left inset %d != %d" % (min(x for x, _, _, _ in boxes) - left_edge, outer))
        check(case, min(y for _, y, _, _ in boxes) == top_edge + outer,
              "top inset %d != %d" % (min(y for _, y, _, _ in boxes) - top_edge, outer))
        check(case, max(x + w for x, _, w, _ in boxes) == right_edge - outer,
              "right inset %d != %d" % (right_edge - max(x + w for x, _, w, _ in boxes), outer))
        check(case, max(y + h for _, y, _, h in boxes) == bottom_edge - outer,
              "bottom inset %d != %d" % (bottom_edge - max(y + h for _, y, _, h in boxes), outer))

        # 5. interior boundaries are 2*(gaps_in+border), within rounding
        interior = 2 * (GAPS_IN + BORDER)
        for i in range(len(boxes)):
            for j in range(len(boxes)):
                if i == j:
                    continue
                ax, ay, aw, ah = boxes[i]
                bx, by, bw, bh = boxes[j]
                if min(ay + ah, by + bh) - max(ay, by) > 0 and bx > ax:
                    gap = bx - (ax + aw)
                    if 0 < gap < interior * 3:
                        check(case, abs(gap - interior) <= 1,
                              "horizontal gutter %d != %d" % (gap, interior))
                if min(ax + aw, bx + bw) - max(ax, bx) > 0 and by > ay:
                    gap = by - (ay + ah)
                    if 0 < gap < interior * 3:
                        check(case, abs(gap - interior) <= 1,
                              "vertical gutter %d != %d" % (gap, interior))

print("screens: %d   presets: %d   assertions: %d" % (len(SCREENS), len(PRESETS), checked))
if failures:
    print("\nFAILURES (%d):" % len(failures))
    seen = set()
    for f in failures:
        head = f.split(":")[0]
        if head in seen:
            continue
        seen.add(head)
        print("  " + f)
    sys.exit(1)
print("all cases pass")
