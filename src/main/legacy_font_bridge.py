import argparse
import calendar
import fnmatch
import json
import math
import os
import re
import sys
import time
import traceback
import xml.etree.ElementTree as ET

# 强制 stdout 使用 UTF-8，避免 Windows GBK 编码报错
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
else:
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1)

from PIL import Image, ImageChops, ImageDraw
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates
from fontTools.ttLib.tables import ttProgram
from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables._n_a_m_e import NameRecord


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))


def char_code_from_stem(stem):
    if len(stem) == 1:
        return ord(stem)
    match = re.fullmatch(r"(?:uni|u)([0-9A-Fa-f]{4,6})", stem)
    if match:
        return int(match.group(1), 16)
    return None


def next_new_ttf_path(base_path):
    folder = os.path.dirname(base_path)
    stem = os.path.splitext(os.path.basename(base_path))[0]
    newest = os.path.join(folder, f"{stem}_new.ttf")
    if os.path.exists(newest):
        idx = 1
        while os.path.exists(os.path.join(folder, f"{stem}_new{idx}.ttf")):
            idx += 1
        os.rename(newest, os.path.join(folder, f"{stem}_new{idx}.ttf"))
    return newest


def font_metrics(font):
    upm = font["head"].unitsPerEm
    try:
        asc = font["OS/2"].sTypoAscender
        desc = font["OS/2"].sTypoDescender
        if asc <= 0:
            raise ValueError()
    except Exception:
        asc = font["hhea"].ascent
        desc = font["hhea"].descent
    return upm, asc, desc


def glyph_bounds(font, glyph_name):
    try:
        glyph_set = font.getGlyphSet()
        pen = BoundsPen(glyph_set)
        glyph_set[glyph_name].draw(pen)
        if pen.bounds:
            x_min, y_min, x_max, y_max = pen.bounds
            return {
                "xMin": int(round(x_min)),
                "yMin": int(round(y_min)),
                "xMax": int(round(x_max)),
                "yMax": int(round(y_max)),
            }
    except Exception:
        pass
    try:
        glyph = font["glyf"][glyph_name]
        glyph.recalcBounds(font["glyf"])
        if getattr(glyph, "numberOfContours", 0) != 0:
            return {
                "xMin": int(getattr(glyph, "xMin", 0)),
                "yMin": int(getattr(glyph, "yMin", 0)),
                "xMax": int(getattr(glyph, "xMax", 0)),
                "yMax": int(getattr(glyph, "yMax", 0)),
            }
    except Exception:
        pass
    return None


def font_position_profile(font, codes=None):
    cmap = font.getBestCmap() or {}
    hmtx = font["hmtx"]
    sample_codes = [int(code) for code in (codes if codes is not None else cmap.keys()) if int(code) in cmap]
    glyphs = {}
    y_mins, y_maxs, centers = [], [], []
    for code in sample_codes:
        name = cmap.get(int(code))
        if not name:
            continue
        advance, lsb = hmtx[name]
        bounds = glyph_bounds(font, name)
        item = {
            "advance": int(advance),
            "lsb": int(lsb),
        }
        if bounds:
            item.update(bounds)
            y_mins.append(bounds["yMin"])
            y_maxs.append(bounds["yMax"])
            centers.append((bounds["yMin"] + bounds["yMax"]) / 2)
        glyphs[str(int(code))] = item
    upm, asc, desc = font_metrics(font)
    visual_min = min(y_mins) if y_mins else int(desc)
    visual_max = max(y_maxs) if y_maxs else int(asc)
    visual_center = int(round((visual_min + visual_max) / 2))
    median_center = int(round(sorted(centers)[len(centers) // 2])) if centers else int(round((asc + desc) / 2))
    return {
        "schema": 1,
        "unitsPerEm": int(upm),
        "ascender": int(asc),
        "descender": int(desc),
        "verticalCenter": int(visual_center),
        "medianGlyphCenter": int(median_center),
        "visualYMin": int(visual_min),
        "visualYMax": int(visual_max),
        "glyphs": glyphs,
    }


def load_binary_mask(path):
    image = Image.open(path).convert("L")
    width, height = image.size
    pixels = list(image.getdata())
    hist = [0] * 256
    for value in pixels:
        hist[value] += 1
    total = width * height
    sum_all = sum(i * hist[i] for i in range(256))
    sum_b = 0.0
    weight_b = 0
    max_var = -1.0
    threshold = 127
    for t in range(256):
        weight_b += hist[t]
        if weight_b == 0:
            continue
        weight_f = total - weight_b
        if weight_f == 0:
            break
        sum_b += t * hist[t]
        var_between = weight_b * weight_f * (sum_b / weight_b - (sum_all - sum_b) / weight_f) ** 2
        if var_between > max_var:
            max_var = var_between
            threshold = t
    foreground = bytearray(1 if value <= threshold else 0 for value in pixels)
    return width, height, foreground


def rdp(points, eps):
    if len(points) < 3:
        return points
    pts = points + [points[0]]
    keep = [False] * len(pts)
    keep[0] = True
    keep[-1] = True
    eps2 = eps * eps
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        ax, ay = pts[i]
        bx, by = pts[j]
        dx, dy = bx - ax, by - ay
        d2 = dx * dx + dy * dy
        max_idx, max_dist = -1, -1.0
        for k in range(i + 1, j):
            cx, cy = pts[k]
            if d2 == 0:
                dist = (cx - ax) ** 2 + (cy - ay) ** 2
            else:
                t = ((cx - ax) * dx + (cy - ay) * dy) / d2
                dist = (cx - (ax + t * dx)) ** 2 + (cy - (ay + t * dy)) ** 2
            if dist > max_dist:
                max_dist = dist
                max_idx = k
        if max_idx != -1 and max_dist > eps2:
            keep[max_idx] = True
            stack.append((i, max_idx))
            stack.append((max_idx, j))
    out = [pts[k] for k in range(len(pts)) if keep[k]]
    if len(out) > 1 and out[0] == out[-1]:
        out = out[:-1]
    return out


def poly_area(poly):
    area = 0.0
    for idx in range(len(poly)):
        x1, y1 = poly[idx]
        x2, y2 = poly[(idx + 1) % len(poly)]
        area += x1 * y2 - x2 * y1
    return area / 2.0


def point_in_poly(poly, x, y):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def trace_contours(width, height, foreground):
    def sample(gx, gy):
        ix, iy = gx - 1, gy - 1
        if 0 <= ix < width and 0 <= iy < height:
            return foreground[iy * width + ix]
        return 0

    links = {}

    def add(a, b):
        links.setdefault(a, []).append(b)
        links.setdefault(b, []).append(a)

    for cy in range(height + 1):
        for cx in range(width + 1):
            case = (sample(cx, cy) << 3) | (sample(cx + 1, cy) << 2) | (sample(cx + 1, cy + 1) << 1) | sample(cx, cy + 1)
            if case in (0, 15):
                continue
            top = ("h", cx, cy)
            bottom = ("h", cx, cy + 1)
            left = ("v", cx, cy)
            right = ("v", cx + 1, cy)
            if case in (1, 14):
                add(left, bottom)
            elif case in (2, 13):
                add(bottom, right)
            elif case in (3, 12):
                add(left, right)
            elif case in (4, 11):
                add(top, right)
            elif case in (6, 9):
                add(top, bottom)
            elif case in (7, 8):
                add(top, left)
            elif case == 5:
                add(top, right)
                add(left, bottom)
            elif case == 10:
                add(top, left)
                add(bottom, right)

    def edge_point(key):
        kind, ex, ey = key
        if kind == "h":
            return ex - 0.5, ey - 1.0
        return ex - 1.0, ey - 0.5

    used = set()
    loops = []
    for start in links:
        if start in used:
            continue
        loop = []
        current, previous = start, None
        while current is not None and current not in used:
            used.add(current)
            loop.append(current)
            next_key = None
            for candidate in links[current]:
                if candidate != previous and candidate not in used:
                    next_key = candidate
                    break
            previous, current = current, next_key
        if len(loop) >= 3:
            poly = rdp([edge_point(k) for k in loop], 1.2)
            if len(poly) >= 3 and abs(poly_area(poly)) >= 2.0:
                loops.append(poly)

    depth = []
    for i, loop in enumerate(loops):
        x0, y0 = loop[0]
        depth.append(sum(1 for j, other in enumerate(loops) if i != j and point_in_poly(other, x0, y0)))

    shapes = []
    outer_index = {}
    for i, loop in enumerate(loops):
        if depth[i] % 2 == 0:
            outer_index[i] = len(shapes)
            shapes.append((loop, []))
    for i, loop in enumerate(loops):
        if depth[i] % 2 == 1:
            x0, y0 = loop[0]
            best, best_area = -1, None
            for j, outer in enumerate(loops):
                if depth[j] == depth[i] - 1 and j in outer_index and point_in_poly(outer, x0, y0):
                    area = abs(poly_area(outer))
                    if best_area is None or area < best_area:
                        best, best_area = j, area
            if best != -1:
                shapes[outer_index[best]][1].append(loop)
    return shapes


def trace_image_to_glyph(img_path, upm, ascent, descent, advance):
    width, height, foreground = load_binary_mask(img_path)
    cx = advance / 2
    pen = TTGlyphPen(None)
    x_min = 0
    if sum(foreground) >= 10:
        shapes = trace_contours(width, height, foreground)
        scale = upm / (0.8 * height)
        em_center = (ascent + descent) / 2

        def to_font(points):
            return [(round((x - width / 2) * scale + cx), round((height / 2 - y) * scale + em_center)) for x, y in points]

        def emit_contour(points, clockwise):
            area = sum(points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1] for i in range(len(points)))
            if (area > 0) == clockwise:
                points = points[::-1]
            pen.moveTo(points[0])
            for point in points[1:]:
                pen.lineTo(point)
            pen.closePath()
            return points

        xs = []
        for outer, holes in shapes:
            outer_points = to_font(outer)
            if len(outer_points) >= 3:
                emitted = emit_contour(outer_points, True)
                xs.extend(point[0] for point in emitted)
            for hole in holes:
                hole_points = to_font(hole)
                if len(hole_points) >= 3:
                    emit_contour(hole_points, False)
        if xs:
            x_min = min(xs)
    return pen.glyph(), x_min


def normalize_import_contours(contours, upm, ascent, descent, advance):
    clean = [[{"x": int(round(p["x"])), "y": int(round(p["y"])), "on": True} for p in contour] for contour in contours if len(contour) >= 3]
    if not clean:
        return []
    xs = [p["x"] for contour in clean for p in contour]
    ys = [p["y"] for contour in clean for p in contour]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    w = max(1, max_x - min_x)
    h = max(1, max_y - min_y)
    target_w = advance * 0.82
    target_h = (ascent - descent) * 0.82
    scale = min(target_w / w, target_h / h)
    cx = advance / 2
    cy = (ascent + descent) / 2
    source_cx = (min_x + max_x) / 2
    source_cy = (min_y + max_y) / 2
    return [[{"x": int(round((p["x"] - source_cx) * scale + cx)), "y": int(round((p["y"] - source_cy) * scale + cy)), "on": True} for p in contour] for contour in clean]


def pil_image_to_contours(image, upm, ascent, descent, advance):
    """将 PIL Image 转为字形轮廓——先二值化再追踪边缘。"""
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        bg.alpha_composite(rgba)
        img = bg.convert("L")
    else:
        img = image.convert("L")
    width, height = img.size
    pixels = list(img.getdata())
    # Otsu 阈值
    hist = [0] * 256
    for value in pixels:
        hist[value] += 1
    total = width * height
    sum_all = sum(i * hist[i] for i in range(256))
    sum_b = 0.0
    weight_b = 0
    max_var = -1.0
    threshold = 127
    for t in range(256):
        weight_b += hist[t]
        if weight_b == 0:
            continue
        weight_f = total - weight_b
        if weight_f == 0:
            break
        sum_b += t * hist[t]
        var_between = weight_b * weight_f * (sum_b / weight_b - (sum_all - sum_b) / weight_f) ** 2
        if var_between > max_var:
            max_var = var_between
            threshold = t
    foreground = bytearray(1 if value <= threshold else 0 for value in pixels)
    if sum(foreground) < 10:
        return []
    shapes = trace_contours(width, height, foreground)
    contours = []
    for outer, holes in shapes:
        if len(outer) >= 3:
            contours.append([{"x": x, "y": height - y, "on": True} for x, y in outer])
        for hole in holes:
            if len(hole) >= 3:
                contours.append([{"x": x, "y": height - y, "on": True} for x, y in hole[::-1]])
    return normalize_import_contours(contours, upm, ascent, descent, advance)


def image_file_to_contours(path, upm, ascent, descent, advance):
    return pil_image_to_contours(Image.open(path), upm, ascent, descent, advance)


def parse_svg_points(text):
    nums = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", text or "")]
    return [{"x": nums[i], "y": -nums[i + 1], "on": True} for i in range(0, len(nums) - 1, 2)]


def parse_transform_matrix(text):
    matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]

    def multiply(left, right):
        a, b, c, d, e, f = left
        g, h, i, j, k, l = right
        return [
            a * g + c * h,
            b * g + d * h,
            a * i + c * j,
            b * i + d * j,
            a * k + c * l + e,
            b * k + d * l + f,
        ]

    for name, args in re.findall(r"([a-zA-Z]+)\s*\(([^)]*)\)", text or ""):
        values = [float(v) for v in re.findall(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?", args)]
        lname = name.lower()
        next_matrix = None
        if lname == "matrix" and len(values) >= 6:
            next_matrix = values[:6]
        elif lname == "translate":
            tx = values[0] if values else 0.0
            ty = values[1] if len(values) > 1 else 0.0
            next_matrix = [1.0, 0.0, 0.0, 1.0, tx, ty]
        elif lname == "scale":
            sx = values[0] if values else 1.0
            sy = values[1] if len(values) > 1 else sx
            next_matrix = [sx, 0.0, 0.0, sy, 0.0, 0.0]
        elif lname == "rotate" and values:
            angle = math.radians(values[0])
            cos_v, sin_v = math.cos(angle), math.sin(angle)
            rot = [cos_v, sin_v, -sin_v, cos_v, 0.0, 0.0]
            if len(values) >= 3:
                cx, cy = values[1], values[2]
                next_matrix = multiply(multiply([1.0, 0.0, 0.0, 1.0, cx, cy], rot), [1.0, 0.0, 0.0, 1.0, -cx, -cy])
            else:
                next_matrix = rot
        elif lname == "skewx" and values:
            next_matrix = [1.0, 0.0, math.tan(math.radians(values[0])), 1.0, 0.0, 0.0]
        elif lname == "skewy" and values:
            next_matrix = [1.0, math.tan(math.radians(values[0])), 0.0, 1.0, 0.0, 0.0]
        if next_matrix:
            matrix = multiply(matrix, next_matrix)
    return matrix


def combine_transform(parent, child):
    a, b, c, d, e, f = parent
    g, h, i, j, k, l = child
    return [
        a * g + c * h,
        b * g + d * h,
        a * i + c * j,
        b * i + d * j,
        a * k + c * l + e,
        b * k + d * l + f,
    ]


def transform_point(matrix, x, y):
    a, b, c, d, e, f = matrix
    return {"x": a * x + c * y + e, "y": -(b * x + d * y + f), "on": True}


def svg_element_visible(elem):
    style = elem.get("style", "") or ""
    if re.search(r"display\s*:\s*none|visibility\s*:\s*hidden", style, re.I):
        return False
    if (elem.get("display") or "").lower() == "none":
        return False
    if (elem.get("visibility") or "").lower() == "hidden":
        return False
    fill = (elem.get("fill") or "").strip().lower()
    stroke = (elem.get("stroke") or "").strip().lower()
    style_fill = re.search(r"(?:^|;)\s*fill\s*:\s*([^;]+)", style, re.I)
    style_stroke = re.search(r"(?:^|;)\s*stroke\s*:\s*([^;]+)", style, re.I)
    if style_fill:
        fill = style_fill.group(1).strip().lower()
    if style_stroke:
        stroke = style_stroke.group(1).strip().lower()
    if fill == "none" and stroke in ("", "none"):
        return False
    return True


def sample_quad(p0, p1, p2, steps=14):
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1 - t
        out.append((mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0], mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]))
    return out


def sample_cubic(p0, p1, p2, p3, steps=18):
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1 - t
        out.append((
            mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0],
            mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1],
        ))
    return out


class SvgContourPen:
    def __init__(self, transform):
        self.transform = transform
        self.contours = []
        self.current = []
        self.current_pos = None
        self.start_pos = None

    def _add(self, point):
        x, y = point
        self.current.append(transform_point(self.transform, x, y))
        self.current_pos = (x, y)

    def moveTo(self, point):
        if len(self.current) >= 3:
            self.contours.append(self.current)
        self.current = []
        self.start_pos = tuple(point)
        self._add(tuple(point))

    def lineTo(self, point):
        self._add(tuple(point))

    def qCurveTo(self, *points):
        if self.current_pos is None or not points:
            return
        pts = [tuple(p) for p in points if p is not None]
        if len(pts) == 1:
            self.lineTo(pts[0])
            return
        p0 = self.current_pos
        for idx in range(len(pts) - 1):
            p1 = pts[idx]
            p2 = pts[idx + 1] if idx == len(pts) - 2 else ((pts[idx][0] + pts[idx + 1][0]) / 2, (pts[idx][1] + pts[idx + 1][1]) / 2)
            for sampled in sample_quad(p0, p1, p2):
                self._add(sampled)
            p0 = p2

    def curveTo(self, *points):
        if self.current_pos is None or len(points) < 3:
            return
        pts = [tuple(p) for p in points]
        p0 = self.current_pos
        for idx in range(0, len(pts) - 2, 3):
            p1, p2, p3 = pts[idx], pts[idx + 1], pts[idx + 2]
            for sampled in sample_cubic(p0, p1, p2, p3):
                self._add(sampled)
            p0 = p3

    def closePath(self):
        if self.start_pos and self.current_pos != self.start_pos:
            self._add(self.start_pos)
        if len(self.current) >= 3:
            self.contours.append(self.current)
        self.current = []
        self.current_pos = None
        self.start_pos = None

    def endPath(self):
        if len(self.current) >= 3:
            self.contours.append(self.current)
        self.current = []
        self.current_pos = None
        self.start_pos = None


def svg_path_to_contours(d, transform):
    try:
        from fontTools.svgLib.path import parse_path
        pen = SvgContourPen(transform)
        parse_path(d or "", pen)
        pen.endPath()
        return pen.contours
    except Exception:
        return []


def _svg_direct_contours(path, upm, ascent, descent, advance):
    root = ET.parse(path).getroot()
    id_map = {elem.get("id"): elem for elem in root.iter() if elem.get("id")}
    contours = []
    seen = set()

    def walk(elem, parent_transform):
        if not svg_element_visible(elem):
            return
        transform = combine_transform(parent_transform, parse_transform_matrix(elem.get("transform", "")))
        tag = elem.tag.split("}")[-1].lower()
        if tag in ("defs", "style", "metadata", "title", "desc"):
            return
        if tag == "use":
            href = elem.get("href") or elem.get("{http://www.w3.org/1999/xlink}href") or ""
            target = id_map.get(href[1:] if href.startswith("#") else href)
            if target is not None and id(target) not in seen:
                x = float(elem.get("x", "0") or 0)
                y = float(elem.get("y", "0") or 0)
                seen.add(id(target))
                walk(target, combine_transform(transform, [1.0, 0.0, 0.0, 1.0, x, y]))
                seen.discard(id(target))
            return
        if tag in ("polygon", "polyline"):
            raw = [float(n) for n in re.findall(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?", elem.get("points", "") or "")]
            points = [transform_point(transform, raw[i], raw[i + 1]) for i in range(0, len(raw) - 1, 2)]
            if len(points) >= 3:
                contours.append(points)
        elif tag == "rect":
            x = float(elem.get("x", "0") or 0)
            y = float(elem.get("y", "0") or 0)
            w = float(elem.get("width", "0") or 0)
            h = float(elem.get("height", "0") or 0)
            if w and h:
                contours.append([transform_point(transform, x, y), transform_point(transform, x + w, y), transform_point(transform, x + w, y + h), transform_point(transform, x, y + h)])
        elif tag in ("circle", "ellipse"):
            cx = float(elem.get("cx", "0") or 0)
            cy = float(elem.get("cy", "0") or 0)
            rx = float(elem.get("r", elem.get("rx", "0")) or 0)
            ry = float(elem.get("r", elem.get("ry", "0")) or 0)
            if rx and ry:
                contours.append([transform_point(transform, cx + rx * math.cos(i * math.tau / 48), cy + ry * math.sin(i * math.tau / 48)) for i in range(48)])
        elif tag == "line":
            x1 = float(elem.get("x1", "0") or 0)
            y1 = float(elem.get("y1", "0") or 0)
            x2 = float(elem.get("x2", "0") or 0)
            y2 = float(elem.get("y2", "0") or 0)
            stroke_width = max(1.0, float(elem.get("stroke-width", "1") or 1))
            dx, dy = x2 - x1, y2 - y1
            length = math.hypot(dx, dy) or 1.0
            nx, ny = -dy / length * stroke_width / 2, dx / length * stroke_width / 2
            contours.append([transform_point(transform, x1 + nx, y1 + ny), transform_point(transform, x2 + nx, y2 + ny), transform_point(transform, x2 - nx, y2 - ny), transform_point(transform, x1 - nx, y1 - ny)])
        elif tag == "path":
            contours.extend(svg_path_to_contours(elem.get("d", ""), transform))
        for child in list(elem):
            walk(child, transform)

    walk(root, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    return normalize_import_contours(contours, upm, ascent, descent, advance)

def svg_file_to_contours(path, upm, ascent, descent, advance):
    errors = []
    try:
        import cairosvg
        import io
        png_data = cairosvg.svg2png(url=path, output_width=2048, output_height=2048)
        img = Image.open(io.BytesIO(png_data))
        result = pil_image_to_contours(img, upm, ascent, descent, advance)
        if result:
            return {"contours": result, "method": "svg-raster-cairosvg"}
    except ImportError as exc:
        errors.append(f"cairosvg unavailable: {exc}")
    except Exception as exc:
        errors.append(f"cairosvg failed: {exc}")
    try:
        from wand.image import Image as WandImage
        from wand.color import Color as WandColor
        import io as wand_io
        with WandImage(filename=path, resolution=450) as wi:
            wi.background_color = WandColor('white')
            wi.alpha_channel = 'remove'
            wi.format = 'png'
            png_bytes = wi.make_blob()
        img = Image.open(wand_io.BytesIO(png_bytes))
        result = pil_image_to_contours(img, upm, ascent, descent, advance)
        if result:
            return {"contours": result, "method": "svg-raster-wand"}
    except ImportError as exc:
        errors.append(f"wand unavailable: {exc}")
    except Exception as exc:
        errors.append(f"wand failed: {exc}")
    result = _svg_direct_contours(path, upm, ascent, descent, advance)
    if result:
        return {"contours": result, "method": "svg-direct", "warnings": errors}
    raise ValueError("SVG import failed; " + "; ".join(errors or ["no supported visible contours"]))


def _eps_direct_contours(path, upm, ascent, descent, advance):
    text = open(path, "r", encoding="latin1", errors="ignore").read()
    text = re.sub(r"%.*", " ", text)
    tokens = re.findall(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z*]+", text)
    stack, current, contours = [], [], []
    cursor = [0.0, 0.0]
    start_point = None

    def pop_point(relative=False):
        if len(stack) < 2:
            return None
        y, x = stack.pop(), stack.pop()
        if relative:
            x += cursor[0]
            y += cursor[1]
        return [x, y]

    def flush():
        nonlocal current
        if len(current) >= 3:
            contours.append(current)
        current = []

    for token in tokens:
        low = token.lower()
        if re.match(r"[-+]?\d|\.\d", token):
            stack.append(float(token))
            continue
        if low in ("newpath", "n"):
            flush()
            stack.clear()
        elif low in ("moveto", "m"):
            point = pop_point(False)
            if point is None:
                continue
            flush()
            cursor = point
            start_point = point[:]
            current = [{"x": point[0], "y": point[1], "on": True}]
        elif low in ("rmoveto",):
            point = pop_point(True)
            if point is None:
                continue
            flush()
            cursor = point
            start_point = point[:]
            current = [{"x": point[0], "y": point[1], "on": True}]
        elif low in ("lineto", "l"):
            point = pop_point(False)
            if point is None:
                continue
            cursor = point
            current.append({"x": point[0], "y": point[1], "on": True})
        elif low in ("rlineto",):
            point = pop_point(True)
            if point is None:
                continue
            cursor = point
            current.append({"x": point[0], "y": point[1], "on": True})
        elif low in ("curveto", "c") and len(stack) >= 6:
            y3, x3 = stack.pop(), stack.pop()
            y2, x2 = stack.pop(), stack.pop()
            y1, x1 = stack.pop(), stack.pop()
            p0 = (cursor[0], cursor[1])
            for x, y in sample_cubic(p0, (x1, y1), (x2, y2), (x3, y3), 22):
                current.append({"x": x, "y": y, "on": True})
            cursor = [x3, y3]
        elif low in ("rcurveto",) and len(stack) >= 6:
            dy3, dx3 = stack.pop(), stack.pop()
            dy2, dx2 = stack.pop(), stack.pop()
            dy1, dx1 = stack.pop(), stack.pop()
            p0 = (cursor[0], cursor[1])
            p1 = (cursor[0] + dx1, cursor[1] + dy1)
            p2 = (cursor[0] + dx1 + dx2, cursor[1] + dy1 + dy2)
            p3 = (cursor[0] + dx1 + dx2 + dx3, cursor[1] + dy1 + dy2 + dy3)
            for x, y in sample_cubic(p0, p1, p2, p3, 22):
                current.append({"x": x, "y": y, "on": True})
            cursor = [p3[0], p3[1]]
        elif low in ("closepath", "h"):
            if start_point and current:
                current.append({"x": start_point[0], "y": start_point[1], "on": True})
            flush()
            start_point = None
        elif low in ("fill", "eofill", "stroke", "s", "f", "f*"):
            flush()
            start_point = None
        elif low in ("setlinewidth", "setlinejoin", "setlinecap", "setgray", "setrgbcolor", "setcmykcolor"):
            stack.clear()
    flush()
    return normalize_import_contours(contours, upm, ascent, descent, advance)

def eps_file_to_contours(path, upm, ascent, descent, advance):
    errors = []
    try:
        img = Image.open(path)
        result = pil_image_to_contours(img, upm, ascent, descent, advance)
        if result:
            return {"contours": result, "method": "eps-raster-pillow"}
    except Exception as exc:
        errors.append(f"pillow/ghostscript failed: {exc}")
    try:
        from wand.image import Image as WandImage
        from wand.color import Color as WandColor
        import io as wand_io
        with WandImage(filename=path, resolution=450) as wi:
            wi.background_color = WandColor('white')
            wi.alpha_channel = 'remove'
            wi.format = 'png'
            png_bytes = wi.make_blob()
        img = Image.open(wand_io.BytesIO(png_bytes))
        result = pil_image_to_contours(img, upm, ascent, descent, advance)
        if result:
            return {"contours": result, "method": "eps-raster-wand"}
    except ImportError as exc:
        errors.append(f"wand unavailable: {exc}")
    except Exception as exc:
        errors.append(f"wand failed: {exc}")
    result = _eps_direct_contours(path, upm, ascent, descent, advance)
    if result:
        return {"contours": result, "method": "eps-direct", "warnings": errors}
    raise ValueError("EPS import failed; " + "; ".join(errors or ["no supported visible contours"]))


def import_glyph_asset(path, upm, ascent, descent, advance):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".png", ".jpg", ".jpeg", ".bmp"):
        contours = image_file_to_contours(path, upm, ascent, descent, advance)
        return {"contours": contours, "method": "bitmap-trace"}
    if ext == ".svg":
        return svg_file_to_contours(path, upm, ascent, descent, advance)
    if ext == ".eps":
        return eps_file_to_contours(path, upm, ascent, descent, advance)
    raise ValueError("Unsupported import format. Use PNG, JPG, BMP, SVG, or EPS.")


def apply_name_records(font, metadata):
    name_table = font["name"]
    target_ids = [int(key) for key in metadata.keys()]
    name_table.names = [record for record in name_table.names if record.nameID not in target_ids]
    lang_configs = {
        "en": [
            {"platformID": 3, "platEncID": 1, "langID": 0x0409, "encoding": "utf-16-be"},
            {"platformID": 1, "platEncID": 0, "langID": 0, "encoding": "latin1"},
        ],
        "zh": [
            {"platformID": 3, "platEncID": 1, "langID": 0x0804, "encoding": "utf-16-be"},
            {"platformID": 1, "platEncID": 0, "langID": 33, "encoding": "gbk"},
        ],
    }
    for name_id, lang_dict in metadata.items():
        for lang_key, text_value in lang_dict.items():
            if not text_value:
                continue
            for cfg in lang_configs.get(lang_key, []):
                record = NameRecord()
                record.nameID = int(name_id)
                record.platformID = cfg["platformID"]
                record.platEncID = cfg["platEncID"]
                record.langID = cfg["langID"]
                record.string = str(text_value).encode(cfg["encoding"], "ignore")
                name_table.names.append(record)
    return len(target_ids)


def default_project_metadata(family, upm, ascent, descent):
    family = str(family or "Zoomla Font")
    ps_name = re.sub(r"[^A-Za-z0-9-]", "", family) or "ZoomlaFont"
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    return {
        "schema": 1,
        "names": {
            "familyEn": family,
            "familyZh": family,
            "styleEn": "Regular",
            "styleZh": "常规",
            "fullNameEn": f"{family} Regular",
            "fullNameZh": f"{family} 常规",
            "postScriptName": f"{ps_name}-Regular",
            "version": "Version 1.000",
            "uniqueId": f"{ps_name};{now}",
        },
        "legal": {
            "copyrightEn": "",
            "copyrightZh": "",
            "trademarkEn": "",
            "trademarkZh": "",
            "manufacturerEn": "",
            "manufacturerZh": "",
            "designerEn": "",
            "designerZh": "",
            "descriptionEn": "This font was created using ZoomlaXizhi.",
            "descriptionZh": "此字体由逐浪字库工具创建。",
            "vendorUrl": "",
            "designerUrl": "",
            "licenseEn": "",
            "licenseZh": "",
            "licenseUrl": "",
            "sampleTextEn": "Zoomla Font",
            "sampleTextZh": "汉字之美逐浪而来",
            "vendorId": "Z01",
        },
        "metrics": {
            "unitsPerEm": int(upm),
            "ascender": int(ascent),
            "descender": int(descent),
            "lineGap": 0,
            "winAscent": max(0, int(ascent)),
            "winDescent": max(0, -int(descent)),
            "xHeight": int(round(int(upm) * 0.48)),
            "capHeight": int(round(int(upm) * 0.70)),
            "italicAngle": 0,
            "underlinePosition": int(round(-int(upm) * 0.10)),
            "underlineThickness": max(1, int(round(int(upm) * 0.05))),
        },
        "publish": {
            "colorOffsetX": 0,
            "colorOffsetY": 0,
        },
        "axes": [],
        "masters": [{"name": "Regular", "includeMetrics": True}],
        "instances": [{"name": "Regular", "coordinates": {}}],
        "notes": "",
    }


def extract_project_metadata(font, fallback_family=""):
    name_table = font["name"]
    upm, ascent, descent = font_metrics(font)
    base = default_project_metadata(fallback_family or name_table.getDebugName(1), upm, ascent, descent)
    records = []
    by_id = {}
    zh_lang_ids = {0x0004, 0x0404, 0x0804, 0x0C04, 0x1004, 19, 33}
    en_lang_ids = {0x0000, 0x0409, 0x0809, 0x0C09, 0x1009, 0x1409, 0x1809, 0x1C09, 0x2009, 0x2409, 0x2809, 0x2C09, 0x3009, 0x3409}

    for record in name_table.names:
        try:
            text = record.toUnicode().strip()
        except Exception:
            continue
        if not text:
            continue
        language = "zh" if record.langID in zh_lang_ids else "en" if record.langID in en_lang_ids else "other"
        item = {
            "nameId": int(record.nameID),
            "language": language,
            "text": text,
            "platformId": int(record.platformID),
            "encodingId": int(record.platEncID),
            "languageId": int(record.langID),
        }
        records.append(item)
        by_id.setdefault(int(record.nameID), {"en": [], "zh": [], "other": []})[language].append(item)

    def pick(name_id, language, fallback=""):
        options = by_id.get(name_id, {}).get(language, [])
        if options:
            preferred = sorted(options, key=lambda item: (
                0 if item["platformId"] == 3 else 1,
                0 if item["languageId"] in ({0x0804, 0x0404} if language == "zh" else {0x0409}) else 1,
            ))
            return preferred[0]["text"]
        return fallback

    names = base["names"]
    legal = base["legal"]
    family_en = pick(16, "en", pick(1, "en", names["familyEn"]))
    family_zh = pick(16, "zh", pick(1, "zh", ""))
    style_en = pick(17, "en", pick(2, "en", names["styleEn"]))
    style_zh = pick(17, "zh", pick(2, "zh", ""))
    names.update({
        "familyEn": family_en,
        "familyZh": family_zh,
        "styleEn": style_en,
        "styleZh": style_zh,
        "fullNameEn": pick(4, "en", family_en),
        "fullNameZh": pick(4, "zh", family_zh),
        "postScriptName": pick(6, "en", names["postScriptName"]),
        "version": pick(5, "en", pick(5, "zh", names["version"])),
        "uniqueId": pick(3, "en", pick(3, "zh", names["uniqueId"])),
    })
    legal.update({
        "copyrightEn": pick(0, "en", ""),
        "copyrightZh": pick(0, "zh", ""),
        "trademarkEn": pick(7, "en", ""),
        "trademarkZh": pick(7, "zh", ""),
        "manufacturerEn": pick(8, "en", ""),
        "manufacturerZh": pick(8, "zh", ""),
        "designerEn": pick(9, "en", ""),
        "designerZh": pick(9, "zh", ""),
        "descriptionEn": pick(10, "en", ""),
        "descriptionZh": pick(10, "zh", ""),
        "vendorUrl": pick(11, "en", pick(11, "zh", "")),
        "designerUrl": pick(12, "en", pick(12, "zh", "")),
        "licenseEn": pick(13, "en", ""),
        "licenseZh": pick(13, "zh", ""),
        "licenseUrl": pick(14, "en", pick(14, "zh", "")),
        "sampleTextEn": pick(19, "en", ""),
        "sampleTextZh": pick(19, "zh", ""),
    })
    if "OS/2" in font:
        os2 = font["OS/2"]
        legal["vendorId"] = str(getattr(os2, "achVendID", "") or "").strip()
        base["metrics"].update({
            "winAscent": int(getattr(os2, "usWinAscent", max(0, ascent))),
            "winDescent": int(getattr(os2, "usWinDescent", max(0, -descent))),
            "xHeight": int(getattr(os2, "sxHeight", 0) or 0),
            "capHeight": int(getattr(os2, "sCapHeight", 0) or 0),
        })
    base["metrics"]["lineGap"] = int(getattr(font["hhea"], "lineGap", 0) or 0)
    if "post" in font:
        post = font["post"]
        base["metrics"].update({
            "italicAngle": float(getattr(post, "italicAngle", 0) or 0),
            "underlinePosition": int(getattr(post, "underlinePosition", 0) or 0),
            "underlineThickness": int(getattr(post, "underlineThickness", 0) or 0),
        })
    base["sourceNameRecords"] = records
    base.setdefault("publish", {"colorOffsetX": 0, "colorOffsetY": 0})
    return base


def merge_project_metadata(data, font=None):
    upm = int(data.get("upm", font["head"].unitsPerEm if font else 1024))
    ascent = int(data.get("ascent", font["hhea"].ascent if font else 880))
    descent = int(data.get("descent", font["hhea"].descent if font else -144))
    base = extract_project_metadata(font, data.get("family", "")) if font else default_project_metadata(data.get("family", ""), upm, ascent, descent)
    saved = data.get("font_metadata") or data.get("metadata") or {}

    def deep_merge(dst, src):
        if not isinstance(src, dict):
            return dst
        for key, value in src.items():
            if isinstance(value, dict) and isinstance(dst.get(key), dict):
                deep_merge(dst[key], value)
            else:
                dst[key] = value
        return dst

    return deep_merge(base, saved)


def metadata_name_records(meta):
    names = meta.get("names", {})
    legal = meta.get("legal", {})
    return {
        "0": {"en": legal.get("copyrightEn", ""), "zh": legal.get("copyrightZh", "")},
        "1": {"en": names.get("familyEn", ""), "zh": names.get("familyZh", "")},
        "2": {"en": names.get("styleEn", "Regular"), "zh": names.get("styleZh", "常规")},
        "3": {"en": names.get("uniqueId", "")},
        "4": {"en": names.get("fullNameEn", ""), "zh": names.get("fullNameZh", "")},
        "5": {"en": names.get("version", "")},
        "6": {"en": names.get("postScriptName", "")},
        "7": {"en": legal.get("trademarkEn", ""), "zh": legal.get("trademarkZh", "")},
        "8": {"en": legal.get("manufacturerEn", ""), "zh": legal.get("manufacturerZh", "")},
        "9": {"en": legal.get("designerEn", ""), "zh": legal.get("designerZh", "")},
        "10": {"en": legal.get("descriptionEn", ""), "zh": legal.get("descriptionZh", "")},
        "11": {"en": legal.get("vendorUrl", "")},
        "12": {"en": legal.get("designerUrl", "")},
        "13": {"en": legal.get("licenseEn", ""), "zh": legal.get("licenseZh", "")},
        "14": {"en": legal.get("licenseUrl", "")},
        "16": {"en": names.get("familyEn", ""), "zh": names.get("familyZh", "")},
        "17": {"en": names.get("styleEn", "Regular"), "zh": names.get("styleZh", "常规")},
        "19": {"en": legal.get("sampleTextEn", ""), "zh": legal.get("sampleTextZh", "")},
    }


def apply_project_metadata(font, data):
    meta = merge_project_metadata(data, font)
    apply_name_records(font, metadata_name_records(meta))
    metrics = meta.get("metrics", {})
    upm = int(metrics.get("unitsPerEm") or data.get("upm") or font["head"].unitsPerEm)
    ascent = int(metrics.get("ascender") or data.get("ascent") or font["hhea"].ascent)
    descent = int(metrics.get("descender") or data.get("descent") or font["hhea"].descent)
    sync_font_vertical_metrics(font, upm, ascent, descent)
    font["hhea"].lineGap = int(metrics.get("lineGap", 0) or 0)
    if "OS/2" in font:
        os2 = font["OS/2"]
        os2.usWinAscent = max(0, int(metrics.get("winAscent", ascent) or ascent))
        os2.usWinDescent = max(0, int(metrics.get("winDescent", -descent) or -descent))
        if hasattr(os2, "sxHeight"):
            os2.sxHeight = int(metrics.get("xHeight", getattr(os2, "sxHeight", 0)) or 0)
        if hasattr(os2, "sCapHeight"):
            os2.sCapHeight = int(metrics.get("capHeight", getattr(os2, "sCapHeight", 0)) or 0)
        vendor_id = str(meta.get("legal", {}).get("vendorId", "") or "Z01")[:4]
        os2.achVendID = vendor_id.ljust(4)
    if "post" in font:
        font["post"].italicAngle = float(metrics.get("italicAngle", getattr(font["post"], "italicAngle", 0)) or 0)
        font["post"].underlinePosition = int(metrics.get("underlinePosition", getattr(font["post"], "underlinePosition", 0)) or 0)
        font["post"].underlineThickness = int(metrics.get("underlineThickness", getattr(font["post"], "underlineThickness", 0)) or 0)
    return meta


def date_to_font_time(value):
    epoch = calendar.timegm(time.strptime(value.strip(), "%Y-%m-%d %H:%M:%S"))
    return epoch + 2082844800


def contours_to_glyph(contours):
    coords, flags, end_pts = [], [], []
    for contour in contours:
        if len(contour) < 2:
            continue
        for point in contour:
            coords.append((int(round(point["x"])), int(round(point["y"]))))
            flags.append(1 if point.get("on", True) else 0)
        end_pts.append(len(coords) - 1)
    glyph = Glyph()
    glyph.numberOfContours = len(end_pts)
    glyph.coordinates = GlyphCoordinates(coords)
    glyph.flags = bytearray(flags)
    glyph.endPtsOfContours = end_pts
    glyph.program = ttProgram.Program()
    glyph.program.fromBytecode(b"")
    return glyph, [point[0] for point in coords] or [0]


def project_metrics(data, font):
    ascent = int(data.get("ascent", font["hhea"].ascent))
    descent = int(data.get("descent", font["hhea"].descent))
    upm = int(data.get("upm", font["head"].unitsPerEm))
    if ascent <= descent:
        ascent, descent = font_metrics(font)[1:]
    return upm, ascent, descent


def sync_font_vertical_metrics(font, upm, ascent, descent):
    font["head"].unitsPerEm = int(upm)
    font["hhea"].ascent = int(ascent)
    font["hhea"].descent = int(descent)
    font["hhea"].lineGap = 0
    if "OS/2" in font:
        os2 = font["OS/2"]
        os2.sTypoAscender = int(ascent)
        os2.sTypoDescender = int(descent)
        os2.sTypoLineGap = 0
        os2.usWinAscent = max(0, int(ascent))
        os2.usWinDescent = max(0, -int(descent))
        if getattr(os2, "version", 0) >= 4 and hasattr(os2, "fsSelection"):
            os2.fsSelection |= 1 << 7


def normalize_color(value):
    text = str(value or "#111111").strip()
    if text.lower() in ("black", "#000", "#000000"):
        return "#000000"
    if text.startswith("#"):
        hex_text = text[1:]
        if len(hex_text) == 3:
            hex_text = "".join(ch * 2 for ch in hex_text)
        if len(hex_text) == 6 and re.fullmatch(r"[0-9a-fA-F]{6}", hex_text):
            return "#" + hex_text.upper()
    return "#111111"


def color_to_rgba(color):
    color = normalize_color(color).lstrip("#")
    return (
        int(color[0:2], 16) / 255,
        int(color[2:4], 16) / 255,
        int(color[4:6], 16) / 255,
        1.0,
    )


def grouped_color_contours(glyph_data):
    valid = color_contour_items(glyph_data)
    groups = {}
    order = []
    for item in valid:
        contour = item["contour"]
        color = item["color"]
        parent = item["parent"]
        if parent and item["area"] * parent["area"] < 0 and color == "#111111":
            color = parent["color"]
        if color not in groups:
            groups[color] = []
            order.append(color)
        groups[color].append(contour)
    return [(color, groups[color]) for color in order]


def color_contour_items(glyph_data):
    contours = glyph_data.get("contours", []) or []
    colors = glyph_data.get("contourColors", []) or []
    valid = []
    for index, contour in enumerate(contours):
        if len(contour) < 3:
            continue
        color = normalize_color(colors[index] if index < len(colors) else "#111111")
        valid.append({"index": index, "contour": contour, "color": color, "area": contour_signed_area(contour), "parent": None})
    for child in valid:
        best_parent = None
        best_area = None
        for parent in valid:
            if parent["index"] == child["index"]:
                continue
            area_abs = abs(parent["area"])
            if area_abs <= abs(child["area"]):
                continue
            if contour_inside_contour(child["contour"], parent["contour"]):
                if best_area is None or area_abs < best_area:
                    best_parent = parent
                    best_area = area_abs
        child["parent"] = best_parent
    return valid


def grouped_color_components(glyph_data):
    valid = color_contour_items(glyph_data)
    by_index = {item["index"]: item for item in valid}
    children = {}
    order = []
    for item in valid:
        parent = item["parent"]
        color = item["color"]
        if parent and item["area"] * parent["area"] < 0 and color == "#111111":
            color = parent["color"]
        item["effectiveColor"] = color
        if parent:
            children.setdefault(parent["index"], []).append(item)
        if not parent or parent["index"] not in by_index:
            order.append(item)
    components = []
    for root in order:
        color = root.get("effectiveColor", root["color"])
        contours = [root["contour"]]
        for child in children.get(root["index"], []):
            if child.get("effectiveColor") == color and child["area"] * root["area"] < 0:
                contours.append(child["contour"])
        components.append((color, contours))
    for item in valid:
        if item in order:
            continue
        parent = item["parent"]
        if parent and item.get("effectiveColor") == parent.get("effectiveColor") and item["area"] * parent["area"] < 0:
            continue
        components.append((item.get("effectiveColor", item["color"]), [item["contour"]]))
    return components


def contour_signed_area(contour):
    area = 0.0
    for index, point in enumerate(contour):
        nxt = contour[(index + 1) % len(contour)]
        area += float(point["x"]) * float(nxt["y"]) - float(nxt["x"]) * float(point["y"])
    return area / 2.0


def contour_sample_point(contour):
    return (
        sum(float(point["x"]) for point in contour) / max(1, len(contour)),
        sum(float(point["y"]) for point in contour) / max(1, len(contour)),
    )


def point_in_contour(point, contour):
    x, y = point
    inside = False
    count = len(contour)
    for index in range(count):
        a = contour[index]
        b = contour[(index + 1) % count]
        ax, ay = float(a["x"]), float(a["y"])
        bx, by = float(b["x"]), float(b["y"])
        if (ay > y) != (by > y):
            cross_x = (bx - ax) * (y - ay) / ((by - ay) or 1e-9) + ax
            if x < cross_x:
                inside = not inside
    return inside


def contour_inside_contour(inner, outer):
    if not inner or not outer:
        return False
    samples = []
    step = max(1, len(inner) // 24)
    for index in range(0, len(inner), step):
        point = inner[index]
        samples.append((float(point["x"]), float(point["y"])))
    samples.append(contour_sample_point(inner))
    return all(point_in_contour(point, outer) for point in samples)


def svg_path_from_contour(contour):
    if len(contour) < 2:
        return ""

    def mid(a, b):
        return {"x": round((float(a["x"]) + float(b["x"])) / 2), "y": round((float(a["y"]) + float(b["y"])) / 2), "on": True}

    expanded = []
    for index, point in enumerate(contour):
        nxt = contour[(index + 1) % len(contour)]
        expanded.append(point)
        if not point.get("on", True) and not nxt.get("on", True):
            expanded.append(mid(point, nxt))
    start_index = next((idx for idx, point in enumerate(expanded) if point.get("on", True)), -1)
    if start_index < 0:
        return ""
    ordered = expanded[start_index:] + expanded[:start_index]
    start = ordered[0]
    d = f"M {float(start['x']):.2f} {float(start['y']):.2f}"
    seq = ordered[1:] + [start]
    idx = 0
    while idx < len(seq):
        point = seq[idx]
        if not point.get("on", True):
            next_point = seq[idx + 1] if idx + 1 < len(seq) else start
            d += f" Q {float(point['x']):.2f} {float(point['y']):.2f} {float(next_point['x']):.2f} {float(next_point['y']):.2f}"
            idx += 2
        else:
            d += f" L {float(point['x']):.2f} {float(point['y']):.2f}"
            idx += 1
    return d + " Z"


def offset_color_contours(contours, units_per_em, font_height, offset_x_percent=0.0, offset_y_percent=0.0):
    x_offset = float(units_per_em) * float(offset_x_percent) / 100.0
    y_offset = float(font_height) * float(offset_y_percent) / 100.0
    return [[
        {
            "x": float(point["x"]) + x_offset,
            "y": float(point["y"]) - y_offset,
            "on": point.get("on", True),
        }
        for point in contour
    ] for contour in contours]


def svg_path_from_font_contour(contour, ascent):
    if len(contour) < 2:
        return ""
    return svg_path_from_contour([
        {"x": float(point["x"]), "y": -float(point["y"]), "on": point.get("on", True)}
        for point in contour
    ])


def build_svg_doc(glyph_data, advance, ascent, descent, glyph_id, use_palette=False, palette_lookup=None, offset_x_percent=0.0, offset_y_percent=0.0, units_per_em=None):
    height = max(1, int(ascent) - int(descent))
    upm = int(units_per_em or advance or height)
    parts = []
    for color, contours in grouped_color_components(glyph_data):
        shifted = offset_color_contours(contours, upm, height, offset_x_percent, offset_y_percent)
        d = " ".join(svg_path_from_font_contour(contour, ascent) for contour in shifted).strip()
        if d:
            fill = color
            if use_palette and palette_lookup:
                fill = f"var(--color{palette_lookup(color)}, {color})"
            parts.append(f'<path d="{d}" fill="{fill}" fill-rule="evenodd"/>')
    body = "".join(parts) or ""
    # OpenType-SVG defines the initial viewport from font metrics and aligns the
    # SVG origin with the glyph origin: y=0 is the text baseline and positive y
    # points downward. Do not add a root viewBox/width/height transform here;
    # Adobe hosts can apply it as an extra viewport mapping and shift the glyph.
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" id="glyph{glyph_id}">'
        f'{body}'
        f'</svg>'
    )


def clear_color_tables(font):
    for tag in ("COLR", "CPAL", "SVG "):
        if tag in font:
            del font[tag]


def clear_variable_tables(font):
    # Publishing edits concrete glyf outlines and may add hidden color-layer glyphs.
    # Existing variable-font tables then reference the old glyph count/variation data.
    for tag in ("gvar", "fvar", "avar", "HVAR", "VVAR", "MVAR", "STAT"):
        if tag in font:
            del font[tag]


def sync_font_glyph_tables(font, preferred_order=None, default_advance=0):
    glyf = font["glyf"]
    hmtx = font["hmtx"]
    vmtx = font["vmtx"] if "vmtx" in font else None
    order = []
    seen = set()
    for name in (preferred_order or font.getGlyphOrder()):
        if name and name not in seen:
            order.append(name)
            seen.add(name)
    for name in list(getattr(glyf, "glyphs", {}).keys()):
        if name not in seen:
            order.append(name)
            seen.add(name)
    for name in list(getattr(hmtx, "metrics", {}).keys()):
        if name not in seen:
            order.append(name)
            seen.add(name)
    if vmtx is not None:
        for name in list(getattr(vmtx, "metrics", {}).keys()):
            if name not in seen:
                order.append(name)
                seen.add(name)
    for name in order:
        if name not in glyf.glyphs:
            empty, _xs = contours_to_glyph([])
            glyf[name] = empty
        if name not in hmtx.metrics:
            hmtx.metrics[name] = (int(default_advance or font["head"].unitsPerEm), 0)
        if vmtx is not None and name not in vmtx.metrics:
            default_v_advance = int(getattr(font.get("vhea"), "ascent", 0) - getattr(font.get("vhea"), "descent", 0)) if "vhea" in font else int(default_advance or font["head"].unitsPerEm)
            if default_v_advance <= 0:
                default_v_advance = int(default_advance or font["head"].unitsPerEm)
            vmtx.metrics[name] = (default_v_advance, 0)
    font.setGlyphOrder(order)
    # Some large CJK fonts lazy-load tables while setGlyphOrder/save runs. Re-read
    # hmtx after changing glyph order so newly added color layers cannot disappear
    # from the metrics table and fail save() with KeyError: zclNNNN.
    hmtx = font["hmtx"]
    for name in order:
        if name not in hmtx.metrics:
            hmtx.metrics[name] = (int(default_advance or font["head"].unitsPerEm), 0)
    if vmtx is not None:
        vmtx = font["vmtx"]
        for name in order:
            if name not in vmtx.metrics:
                default_v_advance = int(getattr(font.get("vhea"), "ascent", 0) - getattr(font.get("vhea"), "descent", 0)) if "vhea" in font else int(default_advance or font["head"].unitsPerEm)
                if default_v_advance <= 0:
                    default_v_advance = int(default_advance or font["head"].unitsPerEm)
                vmtx.metrics[name] = (default_v_advance, 0)
    if "maxp" in font:
        font["maxp"].numGlyphs = len(order)
    return order


def normalize_color_mode(value):
    raw = str(value or "").strip()
    key = re.sub(r"[\s_]+", "-", raw.lower())
    aliases = {
        "": "compatible",
        "no": "mono",
        "none": "mono",
        "black-white": "mono",
        "black-and-white": "mono",
        "mono": "mono",
        "monochrome": "mono",
        "one-color": "mono",
        "1-color": "mono",
        "colr": "colr",
        "layered": "colr",
        "layered-glyphs": "colr",
        "colr-layered-glyphs": "colr",
        "two-color": "colr",
        "2-color": "colr",
        "svg-fixed": "svg-fixed",
        "svg-without-color-palettes": "svg-fixed",
        "svg-no-palette": "svg-fixed",
        "three-color": "svg-fixed",
        "3-color": "svg-fixed",
        "svg-palette": "svg-palette",
        "svg-with-color-palettes": "svg-palette",
        "svg-with-palettes": "svg-palette",
        "four-color": "svg-palette",
        "4-color": "svg-palette",
        "compatible": "compatible",
        "both": "compatible",
        "both-colr-and-svg": "compatible",
        "colr-and-svg": "compatible",
        "full-compatible": "compatible",
        "full-color": "compatible",
        "five-color": "compatible",
        "5-color": "compatible",
    }
    if key in aliases:
        return aliases[key]
    if "one-color" in key or "1-color" in key:
        return "mono"
    if "two-color" in key or "2-color" in key:
        return "colr"
    if "three-color" in key or "3-color" in key:
        return "svg-fixed"
    if "four-color" in key or "4-color" in key:
        return "svg-palette"
    if "five-color" in key or "5-color" in key:
        return "compatible"
    if "both" in key and "colr" in key and "svg" in key:
        return "compatible"
    if "colr" in key and "svg" in key:
        return "compatible"
    if "svg" in key and "palette" in key:
        return "svg-palette"
    if "svg" in key:
        return "svg-fixed"
    if "colr" in key or "layer" in key:
        return "colr"
    return raw if raw in ("mono", "colr", "svg-fixed", "svg-palette", "compatible") else "compatible"


def apply_color_tables(font, cmap, data, color_mode, offset_x_percent=0.0, offset_y_percent=0.0):
    color_mode = normalize_color_mode(color_mode)
    clear_color_tables(font)
    if color_mode in ("mono", "no", "NO", ""):
        return {"colrGlyphs": 0, "svgGlyphs": 0, "paletteColors": 0}

    glyphs = data.get("publishedGlyphs") or data.get("glyphs", {}) or {}
    glyf = font["glyf"]
    hmtx = font["hmtx"]
    glyph_order = font.getGlyphOrder()
    used_names = set(glyph_order)
    palette = []
    palette_index = {}
    colr_map = {}
    svg_docs = []
    svg_jobs = []
    color_layer_metrics = {}
    upm, ascent, descent = project_metrics(data, font)

    def get_palette_index(color):
        color = normalize_color(color)
        if color not in palette_index:
            palette_index[color] = len(palette)
            palette.append(color_to_rgba(color))
        return palette_index[color]

    # Photoshop and several Adobe hosts do not reliably resolve SVG-in-OpenType
    # CSS palette variables. Keep CPAL for palette-aware tools, but write
    # literal colors in SVG documents for practical rendering compatibility.
    use_svg_palette = False
    for code_text, glyph_data in glyphs.items():
        code = int(code_text)
        base_name = cmap.get(code)
        if not base_name:
            continue
        aligned_glyph_data = glyph_data if data.get("publishedGlyphs") else {**glyph_data, "contours": align_glyph_contours_for_publish(data, code, glyph_data)}
        groups = grouped_color_contours(aligned_glyph_data)
        if not groups:
            continue
        layers = []
        if len(groups) == 1:
            color, contours = groups[0]
            if contours:
                # For a single color there is no need to create a hidden zcl*
                # layer. Reusing the base glyph avoids hmtx/glyph-order churn
                # and preserves holes because the base outline is already saved.
                layers.append((base_name, get_palette_index(color)))
        else:
            for layer_index, (color, contours) in enumerate(groups):
                if not contours:
                    continue
                suffix = len(glyph_order)
                layer_name = f"zcl{suffix:05d}"
                while layer_name in used_names:
                    suffix += 1
                    layer_name = f"zcl{suffix:05d}"
                used_names.add(layer_name)
                glyph_order.append(layer_name)
                layer_contours = offset_color_contours(contours, upm, ascent - descent, offset_x_percent, offset_y_percent)
                layer_glyph, xs = contours_to_glyph(layer_contours)
                advance = int(aligned_glyph_data.get("advance") or hmtx[base_name][0])
                glyf[layer_name] = layer_glyph
                try:
                    layer_glyph.recalcBounds(glyf)
                except Exception:
                    pass
                layer_lsb = int(getattr(layer_glyph, "xMin", hmtx[base_name][1]))
                hmtx.metrics[layer_name] = (advance, layer_lsb)
                color_layer_metrics[layer_name] = (advance, layer_lsb)
                layers.append((layer_name, get_palette_index(color)))
        if layers and color_mode in ("colr", "compatible"):
            colr_map[base_name] = layers
        if color_mode in ("svg-fixed", "svg-palette", "compatible"):
            advance = int(aligned_glyph_data.get("advance") or hmtx[base_name][0])
            svg_jobs.append((base_name, aligned_glyph_data, advance))

    glyph_order = sync_font_glyph_tables(font, glyph_order, upm)
    if color_layer_metrics:
        hmtx = font["hmtx"]
        for layer_name, metrics in color_layer_metrics.items():
            hmtx.metrics[layer_name] = metrics
        glyph_order = sync_font_glyph_tables(font, glyph_order, upm)
    if colr_map:
        glyph_map = {name: index for index, name in enumerate(glyph_order)}
        font["COLR"] = buildCOLR(colr_map, version=0, glyphMap=glyph_map)
    if colr_map or (color_mode == "svg-palette" and palette):
        font["CPAL"] = buildCPAL([palette or [(0, 0, 0, 1)]])
    if svg_jobs:
        final_glyph_order = font.getGlyphOrder()
        final_glyph_map = {name: index for index, name in enumerate(final_glyph_order)}
        for base_name, glyph_data, advance in svg_jobs:
            gid = final_glyph_map.get(base_name)
            if gid is None:
                continue
            svg_docs.append((build_svg_doc(glyph_data, advance, ascent, descent, gid, use_svg_palette, get_palette_index, offset_x_percent, offset_y_percent, upm), gid, gid, False))
    if svg_docs:
        svg_table = newTable("SVG ")
        svg_docs.sort(key=lambda item: (item[1], item[2]))
        svg_table.docList = svg_docs
        font["SVG "] = svg_table
    return {"colrGlyphs": len(colr_map), "svgGlyphs": len(svg_docs), "paletteColors": len(palette)}


def validate_published_font(output, color_mode, font_type):
    color_mode = normalize_color_mode(color_mode)
    font = TTFont(output)
    def validate_svg_table():
        docs = getattr(font["SVG "], "docList", [])
        if not docs:
            raise ValueError("SVG table is empty.")
        for doc in docs:
            data = str(doc.data)
            glyph_id = int(getattr(doc, "startGlyphID", -1))
            if f'id="glyph{glyph_id}"' not in data:
                raise ValueError("SVG table documents must include glyphN id for Adobe rendering.")
            if "transform=" in data or "scale(1,-1)" in data:
                raise ValueError("SVG table documents must use direct SVG coordinates without global transforms.")
            try:
                ET.fromstring(data)
            except Exception as exc:
                raise ValueError(f"SVG table document is not valid XML: {exc}") from exc
    try:
        if font_type == "woff" and font.flavor != "woff":
            raise ValueError("WOFF flavor was not written correctly.")
        if font_type == "woff2" and font.flavor != "woff2":
            raise ValueError("WOFF2 flavor was not written correctly.")
        for tag in ("gvar", "fvar", "avar", "HVAR", "VVAR", "MVAR"):
            if tag in font:
                raise ValueError(f"Published static font must not contain stale variable table {tag}.")
        if color_mode in ("mono", "no", "NO", ""):
            for tag in ("COLR", "CPAL", "SVG "):
                if tag in font:
                    raise ValueError(f"Mono mode must not contain {tag} table.")
        elif color_mode == "colr":
            if "COLR" not in font or "CPAL" not in font:
                raise ValueError("COLR mode requires both COLR and CPAL tables.")
        elif color_mode == "svg-fixed":
            if "SVG " not in font:
                raise ValueError("SVG fixed color mode requires SVG table.")
            validate_svg_table()
        elif color_mode == "svg-palette":
            if "SVG " not in font or "CPAL" not in font:
                raise ValueError("SVG palette mode requires both SVG and CPAL tables.")
            validate_svg_table()
        elif color_mode == "compatible":
            for tag in ("COLR", "CPAL", "SVG "):
                if tag not in font:
                    raise ValueError(f"Compatible color mode requires {tag} table.")
            validate_svg_table()
        return True
    finally:
        font.close()


def read_outline(font, code):
    cmap = font.getBestCmap()
    name = cmap.get(code)
    if not name:
        return 0, [], 0, None
    advance, lsb = font["hmtx"][name]
    bounds = glyph_bounds(font, name)
    glyph = font["glyf"][name]
    if glyph.isComposite():
        from fontTools.pens.recordingPen import DecomposingRecordingPen

        glyph_set = font.getGlyphSet()
        rec = DecomposingRecordingPen(glyph_set)
        glyph_set[name].draw(rec)
        pen = TTGlyphPen(glyph_set)
        rec.replay(pen)
        glyph = pen.glyph()
    contours = []
    if getattr(glyph, "numberOfContours", 0) > 0:
        start = 0
        for end in glyph.endPtsOfContours:
            points = []
            for idx in range(start, end + 1):
                x, y = glyph.coordinates[idx]
                points.append({"x": int(round(x)), "y": int(round(y)), "on": bool(glyph.flags[idx] & 1)})
            contours.append(points)
            start = end + 1
    return advance, contours, lsb, bounds


def preserve_source_advance_code(code):
    """返回 True 表示该字符为窄宽/比例宽度字符，发布时应保留原始 advance width 和 LSB。
    CJK 统一表意文字、韩文音节等全角区块不在此列——它们使用 UPM 统一宽度。"""
    c = int(code)
    return (
        # Basic Latin + Latin-1 Supplement
        0x0020 <= c <= 0x00FF
        # Latin Extended-A, Latin Extended-B
        or 0x0100 <= c <= 0x024F
        # IPA Extensions
        or 0x0250 <= c <= 0x02AF
        # Spacing Modifier Letters
        or 0x02B0 <= c <= 0x02FF
        # Combining Diacritical Marks
        or 0x0300 <= c <= 0x036F
        # Greek and Coptic
        or 0x0370 <= c <= 0x03FF
        # Cyrillic
        or 0x0400 <= c <= 0x04FF
        # Cyrillic Supplement
        or 0x0500 <= c <= 0x052F
        # Armenian
        or 0x0530 <= c <= 0x058F
        # Hebrew
        or 0x0590 <= c <= 0x05FF
        # Arabic
        or 0x0600 <= c <= 0x06FF
        # Syriac, Thaana
        or 0x0700 <= c <= 0x074F
        # Devanagari through Malayalam
        or 0x0900 <= c <= 0x0DFF
        # Thai
        or 0x0E00 <= c <= 0x0E7F
        # Lao
        or 0x0E80 <= c <= 0x0EFF
        # Tibetan
        or 0x0F00 <= c <= 0x0FFF
        # Georgian
        or 0x10A0 <= c <= 0x10FF
        # Phonetic Extensions
        or 0x1D00 <= c <= 0x1D7F
        # Latin Extended Additional
        or 0x1E00 <= c <= 0x1EFF
        # General Punctuation
        or 0x2000 <= c <= 0x206F
        # Superscripts and Subscripts
        or 0x2070 <= c <= 0x209F
        # Currency Symbols
        or 0x20A0 <= c <= 0x20CF
        # Letterlike Symbols
        or 0x2100 <= c <= 0x214F
        # Number Forms
        or 0x2150 <= c <= 0x218F
        # Arrows
        or 0x2190 <= c <= 0x21FF
        # Mathematical Operators
        or 0x2200 <= c <= 0x22FF
        # Miscellaneous Technical
        or 0x2300 <= c <= 0x23FF
        # Control Pictures
        or 0x2400 <= c <= 0x243F
        # Optical Character Recognition
        or 0x2440 <= c <= 0x245F
        # Enclosed Alphanumerics
        or 0x2460 <= c <= 0x24FF
        # Box Drawing
        or 0x2500 <= c <= 0x257F
        # Block Elements
        or 0x2580 <= c <= 0x259F
        # Geometric Shapes
        or 0x25A0 <= c <= 0x25FF
        # Miscellaneous Symbols
        or 0x2600 <= c <= 0x26FF
        # Dingbats
        or 0x2700 <= c <= 0x27BF
        # Supplemental Arrows-A/B
        or 0x2900 <= c <= 0x297F
        # Latin Extended-C
        or 0x2C60 <= c <= 0x2C7F
        # Supplemental Punctuation
        or 0x2E00 <= c <= 0x2E7F
        # Mathematical Alphanumeric Symbols
        or 0x1D400 <= c <= 0x1D7FF
        # Halfwidth and Fullwidth Forms
        or 0xFF00 <= c <= 0xFFEF
    )


def glyph_advance_metrics(code, glyph_data, base_hmtx, xs=None, units_per_em=None):
    source_advance = glyph_data.get("sourceAdvance")
    source_lsb = glyph_data.get("sourceLsb")
    raw_advance = glyph_data.get("advance")
    outline_lsb = int(min(xs)) if xs else None
    if preserve_source_advance_code(code):
        if source_advance is not None and not glyph_data.get("advanceModified"):
            return int(source_advance), int(outline_lsb if outline_lsb is not None else (source_lsb if source_lsb is not None else base_hmtx[1]))
    elif not glyph_data.get("advanceModified"):
        raw_advance = int(units_per_em or raw_advance or source_advance or base_hmtx[0])
    advance = int(raw_advance if raw_advance is not None else base_hmtx[0])
    lsb = int(outline_lsb if outline_lsb is not None else (source_lsb if source_lsb is not None else base_hmtx[1]))
    return advance, lsb


def contour_bounds(contours):
    points = [point for contour in contours or [] for point in contour]
    if not points:
        return None
    xs = [float(point.get("x", 0)) for point in points]
    ys = [float(point.get("y", 0)) for point in points]
    return {
        "xMin": min(xs),
        "yMin": min(ys),
        "xMax": max(xs),
        "yMax": max(ys),
    }


def transform_contours(contours, dx=0.0, dy=0.0):
    if not dx and not dy:
        return contours
    return [[
        {
            "x": int(round(float(point.get("x", 0)) + dx)),
            "y": int(round(float(point.get("y", 0)) + dy)),
            "on": point.get("on", True),
        }
        for point in contour
    ] for contour in contours or []]


def shift_glyf_glyph(glyph, dx=0, dy=0):
    if not dx and not dy:
        return glyph
    if getattr(glyph, "numberOfContours", 0) > 0 and getattr(glyph, "coordinates", None) is not None:
        glyph.coordinates.translate((int(round(dx)), int(round(dy))))
    elif glyph.isComposite():
        for component in getattr(glyph, "components", []) or []:
            try:
                component.x += int(round(dx))
                component.y += int(round(dy))
            except Exception:
                pass
    return glyph


def final_align_published_glyph(font, cmap, data, code, glyph_data):
    name = cmap.get(int(code))
    if not name or "glyf" not in font or name not in font["glyf"]:
        return None
    source = source_glyph_metrics(data, code, glyph_data)
    source_bounds = source.get("bounds") or {}
    current_bounds = glyph_bounds(font, name)
    if not current_bounds:
        return None
    dx = 0.0
    if "xMin" in source_bounds and not glyph_data.get("advanceModified"):
        dx = float(source_bounds["xMin"]) - float(current_bounds["xMin"])
    if abs(dx) >= 1:
        shift_glyf_glyph(font["glyf"][name], dx, 0.0)
        try:
            font["glyf"][name].recalcBounds(font["glyf"])
        except Exception:
            pass
    return glyph_bounds(font, name)


def source_glyph_metrics(data, code, glyph_data):
    profile = data.get("metricsProfile") or {}
    profile_glyph = (profile.get("glyphs") or {}).get(str(int(code))) or {}
    # 优先使用 glyph_data 中保存的 sourceBounds，否则从 metricsProfile 提取纯边界框
    bounds = glyph_data.get("sourceBounds")
    if not isinstance(bounds, dict) or not bounds:
        bounds = {k: profile_glyph.get(k) for k in ("xMin", "yMin", "xMax", "yMax") if k in profile_glyph}
    return {
        "advance": int(glyph_data.get("sourceAdvance") or profile_glyph.get("advance") or glyph_data.get("advance") or data.get("upm", 1024)),
        "lsb": int(glyph_data.get("sourceLsb") if glyph_data.get("sourceLsb") is not None else profile_glyph.get("lsb", 0)),
        "bounds": bounds if isinstance(bounds, dict) else {},
        "verticalCenter": float(profile.get("verticalCenter", (int(data.get("ascent", 880)) + int(data.get("descent", -144))) / 2)),
    }


def align_glyph_contours_for_publish(data, code, glyph_data):
    contours = glyph_data.get("contours", []) or []
    bounds = contour_bounds(contours)
    if not bounds:
        return contours
    source = source_glyph_metrics(data, code, glyph_data)
    source_bounds = source.get("bounds") or {}
    target_advance = int(glyph_data.get("advance") or source["advance"] or data.get("upm", 1024))
    if preserve_source_advance_code(code) and not glyph_data.get("advanceModified"):
        target_advance = int(source["advance"])

    dx = 0.0
    if source_bounds and "xMin" in source_bounds and "xMax" in source_bounds:
        if not glyph_data.get("advanceModified"):
            dx = float(source_bounds["xMin"]) - float(bounds["xMin"])
        else:
            source_center_x = (float(source_bounds["xMin"]) + float(source_bounds["xMax"])) / 2
            current_center_x = (bounds["xMin"] + bounds["xMax"]) / 2
            source_advance = float(source.get("advance") or target_advance or 1)
            if source_advance > 0:
                target_center_x = source_center_x * (float(target_advance) / source_advance)
                dx = target_center_x - current_center_x

    return transform_contours(contours, dx, 0.0)


def align_glyph_to_source_baseline(data, code, glyph_data):
    contours = glyph_data.get("contours", []) or []
    bounds = contour_bounds(contours)
    if not bounds:
        return contours
    source = source_glyph_metrics(data, code, glyph_data)
    source_bounds = source.get("bounds") or {}
    dx = 0.0
    if source_bounds and "xMin" in source_bounds:
        dx = float(source_bounds["xMin"]) - float(bounds["xMin"])
    return transform_contours(contours, dx, 0.0)


def optimize_existing_font_glyphs(font, cmap, data, project_codes):
    """对发布字体中的非设计字形进行完整的水平+垂直校优。

    垂直方向：将字形平移至源字形的视觉中心位置。
    水平方向：窄宽字符（拉丁、数字、标点等）保留源 advance 和 LSB，
              并对齐至源 xMin；宽字符（CJK）使用统一 UPM 宽度。
    本函数仅处理非设计字形——已设计字形由主循环单独处理。"""
    profile = data.get("metricsProfile") or {}
    profile_glyphs = profile.get("glyphs") or {}
    glyf = font["glyf"]
    hmtx = font["hmtx"]
    upm = int(data.get("upm", 1024))
    optimized = 0
    target_center = float(profile.get("verticalCenter", (int(data.get("ascent", 880)) + int(data.get("descent", -144))) / 2))
    for code in project_codes:
        name = cmap.get(int(code))
        if not name or name not in glyf:
            continue
        source = profile_glyphs.get(str(int(code))) or {}
        narrow = preserve_source_advance_code(code)
        current_bounds = glyph_bounds(font, name)
        if not current_bounds:
            optimized += 1
            continue

        # --- 恢复源字形的 advance 和 LSB ---
        source_advance = int(source.get("advance", hmtx[name][0]))
        source_lsb = int(source.get("lsb", hmtx[name][1]))
        if narrow:
            # 窄宽字符：保留源字形的个性化 advance 和 LSB
            hmtx[name] = (source_advance, source_lsb)
        else:
            # 宽字符（CJK）：使用统一 UPM 宽度，LSB 见后续实际 xMin
            hmtx[name] = (upm, int(current_bounds["xMin"]))

        # --- 垂直校正：将字形中心对齐至源字形中心 ---
        source_has_bounds = all(key in source for key in ("yMin", "yMax"))
        source_bounds = source if source_has_bounds else current_bounds
        dy = float(source_bounds["yMin"]) - float(current_bounds["yMin"]) if source_bounds and "yMin" in source_bounds else 0.0
        needs_vertical = abs(dy) >= 1

        # --- 水平校正：窄宽字符对齐至源 xMin ---
        dx = 0.0
        if narrow and all(key in source for key in ("xMin", "xMax")):
            desired_x_min = float(source["xMin"])
            current_x_min = float(current_bounds["xMin"])
            dx = desired_x_min - current_x_min
        needs_horizontal = abs(dx) >= 1

        # --- 执行平移 ---
        if needs_vertical or needs_horizontal:
            shift_glyf_glyph(glyf[name], dx, dy)
            try:
                glyf[name].recalcBounds(glyf)
            except Exception:
                pass

        # --- 平移后更新度量 ---
        updated_bounds = glyph_bounds(font, name)
        if updated_bounds:
            if narrow:
                # 窄宽字符：advance 和 LSB 均保留源值（不受平移影响）
                hmtx[name] = (source_advance, source_lsb)
            else:
                # 宽字符：advance 保持 UPM，LSB 取自实际 xMin
                hmtx[name] = (upm, int(updated_bounds["xMin"]))
        optimized += 1
    return optimized


def cmd_scan_materials(args):
    items = []
    skipped = 0
    pattern = args.pattern or "*"
    for filename in sorted(os.listdir(args.dir)):
        stem, ext = os.path.splitext(filename)
        if ext.lower() not in (".png", ".jpg", ".jpeg"):
            continue
        if not fnmatch.fnmatch(filename, pattern):
            continue
        code = char_code_from_stem(stem)
        if code is None:
            skipped += 1
            continue
        full_path = os.path.join(args.dir, filename)
        try:
            with Image.open(full_path) as image:
                size = f"{image.size[0]}x{image.size[1]}"
        except Exception:
            skipped += 1
            continue
        items.append({"path": full_path, "name": filename, "char": chr(code), "code": code, "size": size})
    emit({"success": True, "items": items, "skipped": skipped})


def cmd_export_bitmap(args):
    from PIL import ImageFont

    size = int(args.size)
    font = ImageFont.truetype(args.font, int(size * 0.8))
    image = Image.new("RGB", (size, size), "white")
    draw = ImageDraw.Draw(image)
    draw.text((size // 2, size // 2), chr(int(args.code)), font=font, fill="black", anchor="mm")
    if args.format.upper() == "JPG":
        image.save(args.output, "JPEG", quality=95)
    else:
        image.save(args.output, "PNG")
    emit({"success": True, "outputPath": args.output})


def project_glyph_color_groups(glyph_data):
    contours = glyph_data.get("contours", []) or []
    colors = effective_contour_colors_for_export(contours, glyph_data.get("contourColors", []) or [])
    groups = {}
    order = []
    for index, contour in enumerate(contours):
        if len(contour) < 3:
            continue
        color = normalize_color(colors[index] if index < len(colors) else "#111111")
        if color not in groups:
            groups[color] = []
            order.append(color)
        groups[color].append(contour)
    return [(color, groups[color]) for color in order]


def effective_contour_colors_for_export(contours, contour_colors):
    areas = [contour_signed_area(contour) for contour in contours]
    result = []
    for index, contour in enumerate(contours):
        color = normalize_color(contour_colors[index] if index < len(contour_colors) else "#111111")
        parent_index = -1
        parent_area = None
        for candidate_index, candidate in enumerate(contours):
            if candidate_index == index:
                continue
            area_abs = abs(areas[candidate_index])
            if area_abs <= abs(areas[index]):
                continue
            if contour_inside_contour(contour, candidate) and (parent_area is None or area_abs < parent_area):
                parent_index = candidate_index
                parent_area = area_abs
        if parent_index >= 0 and areas[index] * areas[parent_index] < 0 and color == "#111111":
            color = normalize_color(contour_colors[parent_index] if parent_index < len(contour_colors) else "#111111")
        result.append(color)
    return result


def project_glyph_bounds(contours):
    points = [point for contour in contours or [] for point in contour]
    if not points:
        return None
    return {
        "xMin": min(float(point.get("x", 0)) for point in points),
        "yMin": min(float(point.get("y", 0)) for point in points),
        "xMax": max(float(point.get("x", 0)) for point in points),
        "yMax": max(float(point.get("y", 0)) for point in points),
    }


def project_glyph_svg(glyph_data, size):
    contours = glyph_data.get("contours", []) or []
    bounds = project_glyph_bounds(contours)
    if not bounds:
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}"></svg>'
    width = max(1.0, bounds["xMax"] - bounds["xMin"])
    height = max(1.0, bounds["yMax"] - bounds["yMin"])
    scale = 0.82 * float(size) / max(width, height)
    tx = (float(size) - width * scale) / 2 - bounds["xMin"] * scale
    ty = (float(size) - height * scale) / 2 + bounds["yMax"] * scale
    parts = []
    for color, group_contours in project_glyph_color_groups(glyph_data):
        d = " ".join(svg_path_from_contour(contour) for contour in group_contours).strip()
        if d:
            parts.append(f'<path d="{d}" fill="{color}" fill-rule="nonzero"/>')
    body = "".join(parts)
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}"><g transform="translate({tx:.3f} {ty:.3f}) scale({scale:.6f} {-scale:.6f})">{body}</g></svg>'


def project_glyph_transform(glyph_data, size, flip_y=True):
    bounds = project_glyph_bounds(glyph_data.get("contours", []) or [])
    if not bounds:
        return None
    width = max(1.0, bounds["xMax"] - bounds["xMin"])
    height = max(1.0, bounds["yMax"] - bounds["yMin"])
    scale = 0.82 * float(size) / max(width, height)
    tx = (float(size) - width * scale) / 2 - bounds["xMin"] * scale
    ty = (float(size) - height * scale) / 2 + bounds["yMax"] * scale
    return scale, tx, ty, flip_y


def transform_project_point(point, transform):
    scale, tx, ty, flip_y = transform
    y = ty - float(point.get("y", 0)) * scale if flip_y else float(point.get("y", 0)) * scale + ty
    return (float(point.get("x", 0)) * scale + tx, y)


def contour_parent_indexes(contours):
    areas = [contour_signed_area(contour) for contour in contours]
    parents = [-1] * len(contours)
    for index, contour in enumerate(contours):
        parent_index = -1
        parent_area = None
        for candidate_index, candidate in enumerate(contours):
            if candidate_index == index:
                continue
            area_abs = abs(areas[candidate_index])
            if area_abs <= abs(areas[index]):
                continue
            if contour_inside_contour(contour, candidate) and (parent_area is None or area_abs < parent_area):
                parent_index = candidate_index
                parent_area = area_abs
        parents[index] = parent_index
    return parents, areas


def render_project_glyph_image(glyph_data, size):
    aa = 4
    render_size = int(size) * aa
    image = Image.new("RGBA", (render_size, render_size), (255, 255, 255, 0))
    contours = glyph_data.get("contours", []) or []
    transform = project_glyph_transform(glyph_data, render_size)
    if not transform:
        return image
    parents, areas = contour_parent_indexes(contours)
    colors = effective_contour_colors_for_export(contours, glyph_data.get("contourColors", []) or [])
    order = sorted(range(len(contours)), key=lambda index: abs(areas[index]), reverse=True)
    draw = ImageDraw.Draw(image)
    for index in order:
        contour = contours[index]
        if len(contour) < 3:
            continue
        parent = parents[index]
        is_hole = parent >= 0 and areas[index] * areas[parent] < 0
        color = (255, 255, 255, 0) if is_hole else color_to_rgba255(colors[index] if index < len(colors) else "#111111")
        polygon = [transform_project_point(point, transform) for point in contour]
        draw.polygon(polygon, fill=color)
    resample = getattr(Image, "Resampling", Image).LANCZOS
    return image.resize((int(size), int(size)), resample)


def color_to_rgba255(color):
    rgba = color_to_rgba(color)
    return tuple(int(round(channel * 255)) for channel in rgba)


def project_contour_to_eps(contour, transform):
    if len(contour) < 2:
        return ""
    expanded = []
    for index, point in enumerate(contour):
        nxt = contour[(index + 1) % len(contour)]
        expanded.append(point)
        if not point.get("on", True) and not nxt.get("on", True):
            expanded.append(midpoint_export(point, nxt))
    start_index = next((idx for idx, point in enumerate(expanded) if point.get("on", True)), -1)
    if start_index < 0:
        return ""
    ordered = expanded[start_index:] + expanded[:start_index]
    sx, sy = transform_project_point(ordered[0], transform)
    lines = [f"{sx:.3f} {sy:.3f} moveto"]
    seq = ordered[1:] + [ordered[0]]
    idx = 0
    while idx < len(seq):
        point = seq[idx]
        if not point.get("on", True):
            next_point = seq[idx + 1] if idx + 1 < len(seq) else ordered[0]
            cx, cy = transform_project_point(point, transform)
            ex, ey = transform_project_point(next_point, transform)
            lines.append(f"{cx:.3f} {cy:.3f} {ex:.3f} {ey:.3f} {ex:.3f} {ey:.3f} curveto")
            idx += 2
        else:
            x, y = transform_project_point(point, transform)
            lines.append(f"{x:.3f} {y:.3f} lineto")
            idx += 1
    lines.append("closepath")
    return "\n".join(lines)


def project_glyph_eps_fill_blocks(glyph_data, transform):
    contours = glyph_data.get("contours", []) or []
    colors = effective_contour_colors_for_export(contours, glyph_data.get("contourColors", []) or [])
    parents, areas = contour_parent_indexes(contours)
    blocks = []
    for index, contour in enumerate(contours):
        if len(contour) < 3:
            continue
        parent = parents[index]
        is_hole = parent >= 0 and areas[index] * areas[parent] < 0
        if is_hole:
            continue
        color = normalize_color(colors[index] if index < len(colors) else "#111111")
        path_parts = [project_contour_to_eps(contour, transform)]
        for child_index, child in enumerate(contours):
            if parents[child_index] != index or len(child) < 3:
                continue
            if areas[child_index] * areas[index] >= 0:
                continue
            child_color = normalize_color(colors[child_index] if child_index < len(colors) else color)
            if child_color != color:
                continue
            child_path = project_contour_to_eps(child, transform)
            if child_path:
                path_parts.append(child_path)
        body = "\n".join(part for part in path_parts if part).strip()
        if not body:
            continue
        r, g, b, _a = color_to_rgba(color)
        blocks.append(f"{r:.4f} {g:.4f} {b:.4f} setrgbcolor\nnewpath\n{body}\nfill")
    return blocks


def midpoint_export(a, b):
    return {"x": round((float(a["x"]) + float(b["x"])) / 2), "y": round((float(a["y"]) + float(b["y"])) / 2), "on": True}


def cmd_project_export_glyph(args):
    data = load_project(args.project)
    code = int(args.code)
    glyph_data = (data.get("glyphs") or {}).get(str(code))
    if not glyph_data:
        font = TTFont(data["source_ttf"])
        advance, contours, lsb, bounds = read_outline(font, code)
        font.close()
        glyph_data = {"advance": advance or data.get("upm", 1024), "sourceLsb": lsb, "sourceBounds": bounds, "contours": contours}
    size = int(float(args.size or 1000))
    fmt = str(args.format or os.path.splitext(args.output)[1].lstrip(".") or "png").upper()
    svg = project_glyph_svg(glyph_data, size)
    if fmt == "SVG":
        with open(args.output, "w", encoding="utf-8") as fp:
            fp.write('<?xml version="1.0" encoding="UTF-8"?>\n' + svg + "\n")
    elif fmt == "EPS":
        transform = project_glyph_transform(glyph_data, size, flip_y=False)
        parts = []
        if transform:
            parts = project_glyph_eps_fill_blocks(glyph_data, transform)
        eps = f"%!PS-Adobe-3.0 EPSF-3.0\n%%Creator: ZoomlaXizhi\n%%BoundingBox: 0 0 {size} {size}\n%%EndComments\n" + "\n".join(parts) + "\nshowpage\n%%EOF\n"
        with open(args.output, "w", encoding="ascii", errors="ignore") as fp:
            fp.write(eps)
    else:
        image = render_project_glyph_image(glyph_data, size)
        if fmt == "JPG":
            image.convert("RGB").save(args.output, "JPEG", quality=95)
        else:
            image.save(args.output, "PNG")
    emit({"success": True, "outputPath": args.output})


def material_files(folder, pattern="*"):
    return [
        name for name in os.listdir(folder)
        if os.path.splitext(name)[1].lower() in (".png", ".jpg", ".jpeg")
        and fnmatch.fnmatch(name, pattern or "*")
    ]


def unique_output_dir(folder, suffix):
    candidate = os.path.join(folder, suffix)
    index = 1
    while os.path.exists(candidate):
        candidate = os.path.join(folder, f"{suffix}_{index}")
        index += 1
    os.makedirs(candidate)
    return candidate


def cmd_material_convert(args):
    files = material_files(args.dir, args.pattern)
    output = unique_output_dir(args.dir, "converted")
    count = 0
    for name in files:
        source = os.path.join(args.dir, name)
        image = Image.open(source)
        target_format = args.format.upper()
        target_ext = target_format.lower()
        if target_format == "JPG":
            image = image.convert("RGB")
            image.save(os.path.join(output, os.path.splitext(name)[0] + ".jpg"), "JPEG", quality=95)
        elif target_format == "PNG":
            image.save(os.path.join(output, os.path.splitext(name)[0] + ".png"), "PNG")
        elif target_format == "EPS":
            image.convert("RGB").save(os.path.join(output, os.path.splitext(name)[0] + ".eps"), "EPS")
        else:
            raise ValueError(f"Unsupported material format: {target_format}")
        count += 1
    emit({"success": True, "outputPath": output, "count": count})


def cmd_material_resize(args):
    files = material_files(args.dir, args.pattern)
    output = unique_output_dir(args.dir, "resized")
    width = int(args.width or 0)
    height = int(args.height or 0)
    if width <= 0 and height <= 0:
        raise ValueError("Width or height is required.")
    count = 0
    for name in files:
        image = Image.open(os.path.join(args.dir, name))
        if width <= 0:
            width = max(1, round(image.width * height / image.height))
        if height <= 0:
            height = max(1, round(image.height * width / image.width))
        resized = image.resize((width, height), Image.Resampling.LANCZOS)
        resized.save(os.path.join(output, name))
        count += 1
    emit({"success": True, "outputPath": output, "count": count})


def cmd_material_element(args):
    files = material_files(args.dir, args.pattern)
    output = unique_output_dir(args.dir, "element")
    element = Image.open(args.element).convert("RGBA")
    count = 0
    for name in files:
        source = Image.open(os.path.join(args.dir, name)).convert("RGBA")
        if args.mode == "replace":
            result = element.resize(source.size, Image.Resampling.LANCZOS)
        elif args.mode == "overlay":
            result = source.copy()
            layer = element.resize(source.size, Image.Resampling.LANCZOS)
            result.alpha_composite(layer)
        else:
            result = source.copy()
            max_w, max_h = max(1, source.width // 4), max(1, source.height // 4)
            stamp = element.copy()
            stamp.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
            result.alpha_composite(stamp, (source.width - stamp.width - 8, source.height - stamp.height - 8))
        ext = os.path.splitext(name)[1].lower()
        target = os.path.join(output, name)
        result.convert("RGB").save(target, "JPEG", quality=95) if ext in (".jpg", ".jpeg") else result.save(target)
        count += 1
    emit({"success": True, "outputPath": output, "count": count})


def cmd_material_noise(args):
    import random
    from PIL import ImageChops

    files = material_files(args.dir, args.pattern)
    output = unique_output_dir(args.dir, "noise")
    dot_size = max(1, int(args.size))
    density = max(1, min(100, int(args.density)))
    shapes = [item for item in (args.shapes or args.shape or "circle").split(",") if item]
    direction = args.direction or "random"
    custom_mask = None
    if "custom" in shapes:
        if not args.custom or not os.path.isfile(args.custom):
            raise ValueError("Custom speckle element is selected but no valid image was provided.")
        custom = Image.open(args.custom)
        if "A" in custom.getbands():
            custom_mask = custom.getchannel("A").point(lambda value: 255 if value > 16 else 0)
        else:
            custom_mask = custom.convert("L").point(lambda value: 255 if value < 128 else 0)

    def make_tile(shape):
        if shape == "rect12":
            tile = Image.new("L", (dot_size, 2 * dot_size), 0)
            ImageDraw.Draw(tile).rectangle((0, 0, dot_size - 1, 2 * dot_size - 1), fill=255)
            return tile
        if shape == "ellipse12":
            tile = Image.new("L", (dot_size, 2 * dot_size), 0)
            ImageDraw.Draw(tile).ellipse((0, 0, dot_size - 1, 2 * dot_size - 1), fill=255)
            return tile
        if shape == "triangle":
            tile = Image.new("L", (dot_size, dot_size), 0)
            ImageDraw.Draw(tile).polygon([(dot_size // 2, 0), (dot_size - 1, dot_size - 1), (0, dot_size - 1)], fill=255)
            return tile
        if shape == "square":
            tile = Image.new("L", (dot_size, dot_size), 0)
            ImageDraw.Draw(tile).rectangle((0, 0, dot_size - 1, dot_size - 1), fill=255)
            return tile
        if shape == "custom" and custom_mask is not None:
            cw, ch = custom_mask.size
            scale = dot_size / max(cw, ch)
            return custom_mask.resize((max(1, int(cw * scale)), max(1, int(ch * scale))), Image.Resampling.LANCZOS)
        tile = Image.new("L", (dot_size, dot_size), 0)
        ImageDraw.Draw(tile).ellipse((0, 0, dot_size - 1, dot_size - 1), fill=255)
        return tile

    def stamp(mask, width, height):
        shape = random.choice(shapes)
        tile = make_tile(shape)
        if shape in ("circle", "square"):
            angle = 0
        elif direction == "vertical":
            angle = 0
        elif direction == "horizontal":
            angle = 90
        elif direction == "free":
            angle = random.uniform(0, 360)
        else:
            angle = random.choice([0, 90, random.uniform(0, 360)])
        if angle:
            tile = tile.rotate(angle, expand=True, resample=Image.Resampling.BILINEAR)
        tw, th = tile.size
        x = random.randint(-tw // 2, max(-tw // 2, width - tw // 2))
        y = random.randint(-th // 2, max(-th // 2, height - th // 2))
        region = mask.crop((x, y, x + tw, y + th))
        mask.paste(ImageChops.lighter(region, tile), (x, y))

    count = 0
    for name in files:
        original = Image.open(os.path.join(args.dir, name))
        mode = original.mode if original.mode in ("L", "RGB") else "RGB"
        image = original.convert(mode)
        elem = Image.new("L", image.size, 0)
        dots = min(60000, max(1, image.width * image.height * density // max(1, dot_size * dot_size * 100)))
        for _ in range(dots):
            stamp(elem, image.width, image.height)
        ink = image.convert("L").point(lambda value: 255 if value < 128 else 0)
        carve = ImageChops.multiply(ink, elem)
        white = Image.new(mode, image.size, 255 if mode == "L" else (255, 255, 255))
        result = Image.composite(white, image, carve)
        ext = os.path.splitext(name)[1].lower()
        target = os.path.join(output, name)
        result.convert("RGB").save(target, "JPEG", quality=95) if ext in (".jpg", ".jpeg") else result.save(target)
        count += 1
    emit({"success": True, "outputPath": output, "count": count})


def cmd_compose(args):
    materials_payload = json.loads(args.materials) if args.materials else None
    if materials_payload is None:
        scan_args = argparse.Namespace(dir=args.material_dir, pattern="*")
        items = []
        for filename in sorted(os.listdir(scan_args.dir)):
            stem, ext = os.path.splitext(filename)
            if ext.lower() not in (".png", ".jpg", ".jpeg"):
                continue
            code = char_code_from_stem(stem)
            if code is not None:
                items.append({"path": os.path.join(scan_args.dir, filename), "code": code, "char": chr(code)})
    else:
        items = materials_payload
    if not items:
        raise ValueError("No valid glyph materials found.")
    font = TTFont(args.base_font)
    if "glyf" not in font:
        raise ValueError("Only TrueType glyf fonts are supported for glyph injection.")
    upm, asc, desc = font_metrics(font)
    cmap = font.getBestCmap()
    glyf, hmtx = font["glyf"], font["hmtx"]
    ok = miss = fail = 0
    for item in sorted(items, key=lambda entry: entry["code"]):
        code = int(item["code"])
        name = cmap.get(code)
        if not name:
            miss += 1
            continue
        try:
            advance = hmtx[name][0]
            glyph, x_min = trace_image_to_glyph(item["path"], upm, asc, desc, advance)
            glyf[name] = glyph
            hmtx[name] = (advance, x_min)
            ok += 1
        except Exception:
            fail += 1
    if ok == 0:
        font.close()
        raise ValueError("No glyph was injected. The base font may not contain the requested Unicode characters.")
    metadata = {}
    if args.english_name or args.chinese_name:
        ename = args.english_name or "Zoomla Font"
        cname = args.chinese_name or ename
        ps_name = re.sub(r"[^A-Za-z0-9]", "", ename) or "ZoomlaFont"
        metadata = {
            "1": {"en": ename, "zh": cname},
            "4": {"en": f"{ename} Regular", "zh": f"{cname} Regular"},
            "6": {"en": f"{ps_name}-Regular"},
            "16": {"en": ename, "zh": cname},
        }
        if args.version:
            metadata["5"] = {"en": args.version, "zh": args.version}
        if args.copyright:
            metadata["0"] = {"en": args.copyright, "zh": args.copyright}
        apply_name_records(font, metadata)
    output = next_new_ttf_path(args.base_font) if not args.output else args.output
    font.save(output)
    font.close()
    emit({"success": True, "outputPath": output, "glyphCount": ok, "missing": miss, "failed": fail})


def cmd_metadata(args):
    font = TTFont(args.input)
    metadata = json.loads(args.name_metadata)
    advanced = json.loads(args.advanced_metadata or "{}")
    count = apply_name_records(font, metadata)
    if "OS/2" in font:
        if advanced.get("clear_vendor"):
            font["OS/2"].achVendID = "    "
        elif advanced.get("vendor_id"):
            font["OS/2"].achVendID = str(advanced["vendor_id"]).ljust(4)[:4]
    if "head" in font:
        if advanced.get("created"):
            font["head"].created = date_to_font_time(advanced["created"])
        if advanced.get("modified"):
            font["head"].modified = date_to_font_time(advanced["modified"])
    font.save(args.output)
    font.close()
    emit({"success": True, "outputPath": args.output, "nameIds": count})


def cmd_project_create(args):
    font = TTFont(args.source_ttf)
    if "glyf" not in font:
        raise ValueError("Only TrueType glyf fonts are supported.")
    upm, asc, desc = font_metrics(font)
    metadata = extract_project_metadata(font, os.path.basename(args.source_ttf))
    family = metadata["names"].get("familyZh") or metadata["names"].get("familyEn") or font["name"].getDebugName(1) or os.path.basename(args.source_ttf)
    cmap = font.getBestCmap()
    codes = sorted(int(code) for code in cmap.keys() if int(code) >= 0x20)
    output = args.output or os.path.splitext(args.source_ttf)[0] + ".z01"
    data = {
        "version": 1,
        "source_ttf": os.path.abspath(args.source_ttf),
        "path": output,
        "family": family,
        "upm": upm,
        "ascent": asc,
        "descent": desc,
        "codes": codes,
        "metricsProfile": font_position_profile(font, codes),
        "glyphs": {},
    }
    data["font_metadata"] = metadata
    with open(output, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=1)
    font.close()
    emit({"success": True, "project": data, "path": output})


def load_project(path):
    with open(path, "r", encoding="utf-8-sig") as fp:
        data = json.load(fp)
    if "source_ttf" not in data and "sourceTtf" in data:
        data["source_ttf"] = data["sourceTtf"]
    return data


def cmd_project_open(args):
    data = load_project(args.project)
    src = data.get("source_ttf", "")
    if not os.path.isfile(src):
        guess = os.path.splitext(args.project)[0] + ".ttf"
        if os.path.isfile(guess):
            src = guess
            data["source_ttf"] = src
        else:
            raise ValueError(f"Source font not found: {src}")
    font = TTFont(src)
    cmap = font.getBestCmap()
    if "codes" not in data:
        deleted = set(int(code) for code in data.get("deleted_codes", []))
        data["codes"] = [int(code) for code in sorted(cmap.keys()) if int(code) >= 0x20 and int(code) not in deleted]
    data["font_metadata"] = merge_project_metadata(data, font)
    if "metricsProfile" not in data:
        data["metricsProfile"] = font_position_profile(font, data.get("codes"))
    names = data["font_metadata"].get("names", {})
    data["family"] = names.get("familyZh") or names.get("familyEn") or data.get("family", "")
    data["path"] = args.project
    font.close()
    emit({"success": True, "project": data, "path": args.project})


def cmd_project_glyph(args):
    data = load_project(args.project)
    code = int(args.code)
    glyphs = data.setdefault("glyphs", {})
    if str(code) not in glyphs:
        font = TTFont(data["source_ttf"])
        advance, contours, lsb, bounds = read_outline(font, code)
        font.close()
        if not advance:
            advance = int(data.get("upm", 1024))
        glyphs[str(code)] = {"advance": advance, "sourceAdvance": advance, "sourceLsb": lsb, "sourceBounds": bounds, "contours": contours}
    emit({"success": True, "code": code, "glyph": glyphs[str(code)]})


def cmd_project_save_glyph(args):
    data = load_project(args.project)
    code = int(args.code)
    if args.glyph_file:
        with open(args.glyph_file, "r", encoding="utf-8") as fp:
            glyph = json.load(fp)
    elif args.glyph:
        glyph = json.loads(args.glyph)
    else:
        raise ValueError("Glyph data is required.")
    data.setdefault("glyphs", {})[str(code)] = glyph
    with open(args.project, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=1)
    emit({"success": True, "code": code, "glyph": glyph})


def cmd_project_update_codes(args):
    data = load_project(args.project)
    with open(args.codes_file, "r", encoding="utf-8") as fp:
        payload = json.load(fp)
    codes = []
    seen = set()
    for raw_code in payload.get("codes", []):
        code = int(raw_code)
        if 0 <= code <= 0x10FFFF and not 0xD800 <= code <= 0xDFFF and code not in seen:
            seen.add(code)
            codes.append(code)
    removed = set(int(code) for code in payload.get("removed", []))
    data["codes"] = codes
    deleted = set(int(code) for code in data.get("deleted_codes", []))
    deleted.update(removed)
    deleted.difference_update(codes)
    data["deleted_codes"] = sorted(deleted)
    glyphs = data.setdefault("glyphs", {})
    for code in removed:
        glyphs.pop(str(code), None)
    with open(args.project, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=1)
    emit({"success": True, "codes": codes, "removed": sorted(removed)})


def cmd_project_update_metadata(args):
    data = load_project(args.project)
    with open(args.metadata_file, "r", encoding="utf-8-sig") as fp:
        payload = json.load(fp)
    data["font_metadata"] = merge_project_metadata({**data, "font_metadata": payload})
    metrics = data["font_metadata"].get("metrics", {})
    if metrics.get("unitsPerEm"):
        data["upm"] = int(metrics["unitsPerEm"])
    if metrics.get("ascender"):
        data["ascent"] = int(metrics["ascender"])
    if metrics.get("descender"):
        data["descent"] = int(metrics["descender"])
    names = data["font_metadata"].get("names", {})
    if names.get("familyZh") or names.get("familyEn"):
        data["family"] = names.get("familyZh") or names.get("familyEn")
    with open(args.project, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=1)
    emit({"success": True, "project": data, "metadata": data["font_metadata"]})


def cmd_import_glyph_asset(args):
    result = import_glyph_asset(
        args.input,
        int(float(args.upm)),
        int(float(args.ascent)),
        int(float(args.descent)),
        int(float(args.advance)),
    )
    contours = result.get("contours", []) if isinstance(result, dict) else result
    emit({
        "success": True,
        "contours": contours,
        "count": len(contours),
        "method": result.get("method") if isinstance(result, dict) else "legacy",
        "warnings": result.get("warnings", []) if isinstance(result, dict) else [],
    })


def cmd_project_publish(args):
    data = load_project(args.project)
    font = TTFont(data["source_ttf"])
    if "metricsProfile" not in data:
        data["metricsProfile"] = font_position_profile(font, data.get("codes"))
    upm, ascent, descent = project_metrics(data, font)
    sync_font_vertical_metrics(font, upm, ascent, descent)
    apply_project_metadata(font, data)
    glyf, hmtx = font["glyf"], font["hmtx"]
    cmap = font.getBestCmap()
    project_codes = [int(code) for code in data.get("codes", sorted(cmap.keys()))]
    project_set = set(project_codes)
    deleted = set(int(code) for code in data.get("deleted_codes", []))
    unicode_cmaps = [table for table in font["cmap"].tables if table.isUnicode()]
    for table in unicode_cmaps:
        for code in list(table.cmap.keys()):
            if code in deleted or code not in project_set:
                table.cmap.pop(code, None)
    glyph_order = font.getGlyphOrder()
    used_names = set(glyph_order)
    for code in project_codes:
        if code in cmap:
            continue
        base_name = f"uni{code:04X}" if code <= 0xFFFF else f"u{code:X}"
        name = base_name
        suffix = 1
        while name in used_names:
            name = f"{base_name}.{suffix}"
            suffix += 1
        used_names.add(name)
        glyph_order.append(name)
        empty_glyph, _xs = contours_to_glyph([])
        glyf[name] = empty_glyph
        source = ((data.get("metricsProfile") or {}).get("glyphs") or {}).get(str(int(code))) or {}
        hmtx[name] = (int(source.get("advance") or data.get("upm", 1024)), int(source.get("lsb", 0) or 0))
        for table in unicode_cmaps:
            if code <= 0xFFFF or table.format in (10, 12, 13):
                table.cmap[code] = name
        cmap[code] = name
    font.setGlyphOrder(glyph_order)
    designed_code_set = {int(c) for c in data.get("glyphs", {})}
    nondesigned_codes = [c for c in project_codes if c not in designed_code_set]
    optimized = optimize_existing_font_glyphs(font, cmap, data, nondesigned_codes)
    published_glyphs = {}
    ok = miss = 0
    for code_text, glyph_data in data.get("glyphs", {}).items():
        code = int(code_text)
        name = cmap.get(code)
        if not name:
            miss += 1
            continue
        aligned_contours = align_glyph_to_source_baseline(data, code, glyph_data)
        aligned_glyph_data = {**glyph_data, "contours": aligned_contours}
        glyph, xs = contours_to_glyph(aligned_contours)
        glyf[name] = glyph
        try:
            glyph.recalcBounds(glyf)
        except Exception:
            pass
        final_bounds = final_align_published_glyph(font, cmap, data, code, aligned_glyph_data)
        if final_bounds:
            current_bounds = contour_bounds(aligned_contours)
            source_bounds = source_glyph_metrics(data, code, aligned_glyph_data).get("bounds") or {}
            adjust_dx = float(final_bounds["xMin"]) - float(current_bounds["xMin"]) if current_bounds and "xMin" in final_bounds else 0.0
            if abs(adjust_dx) >= 1:
                aligned_contours = transform_contours(aligned_contours, adjust_dx, 0.0)
                aligned_glyph_data = {**aligned_glyph_data, "contours": aligned_contours}
        advance, lsb = glyph_advance_metrics(code, aligned_glyph_data, hmtx[name], xs, upm)
        hmtx[name] = (advance, lsb)
        published_glyphs[str(code)] = {**aligned_glyph_data, "advance": advance, "sourceLsb": lsb, "contours": aligned_contours}
        ok += 1
    publish_meta = merge_project_metadata(data, font).get("publish", {})
    raw_offset_x = getattr(args, "color_offset_x", None)
    raw_offset_y = getattr(args, "color_offset_y", None)
    offset_x_percent = max(-300.0, min(300.0, float(publish_meta.get("colorOffsetX", 0.0) if raw_offset_x in (None, "") else raw_offset_x)))
    offset_y_percent = max(-300.0, min(300.0, float(publish_meta.get("colorOffsetY", 0.0) if raw_offset_y in (None, "") else raw_offset_y)))
    publish_data = {**data, "publishedGlyphs": published_glyphs}
    color_mode = normalize_color_mode(getattr(args, "color_mode", "compatible"))
    color_info = apply_color_tables(font, cmap, publish_data, color_mode, offset_x_percent, offset_y_percent)
    clear_variable_tables(font)
    output = args.output or next_new_ttf_path(data["source_ttf"])
    font_type = str(getattr(args, "font_type", "") or os.path.splitext(output)[1].lstrip(".") or "ttf").lower()
    if font_type == "otf":
        raise ValueError("True OTF/CFF color publishing is not supported by the current glyf-based project engine. Please publish TTF/WOFF/WOFF2, or convert the resulting TTF with a CFF-capable toolchain.")
    if font_type == "woff":
        font.flavor = "woff"
    elif font_type == "woff2":
        try:
            import brotli  # noqa: F401
        except Exception:
            raise ValueError("WOFF2 output requires the Python brotli package. Please install brotli before publishing WOFF2.")
        font.flavor = "woff2"
    else:
        font.flavor = None
    sync_font_glyph_tables(font, font.getGlyphOrder(), data.get("upm", font["head"].unitsPerEm))
    font.save(output)
    font.close()
    validate_published_font(output, color_mode, font_type)
    emit({"success": True, "outputPath": output, "glyphCount": ok, "missing": miss, "optimizedGlyphs": optimized, "colorMode": color_mode, "colorOffsetX": offset_x_percent, "colorOffsetY": offset_y_percent, **color_info})


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    scan = sub.add_parser("scan-materials")
    scan.add_argument("--dir", required=True)
    scan.add_argument("--pattern", default="*")
    scan.set_defaults(func=cmd_scan_materials)

    bitmap = sub.add_parser("export-bitmap")
    bitmap.add_argument("--font", required=True)
    bitmap.add_argument("--code", required=True)
    bitmap.add_argument("--size", required=True)
    bitmap.add_argument("--format", required=True)
    bitmap.add_argument("--output", required=True)
    bitmap.set_defaults(func=cmd_export_bitmap)

    project_export = sub.add_parser("project-export-glyph")
    project_export.add_argument("--project", required=True)
    project_export.add_argument("--code", required=True)
    project_export.add_argument("--size", default="1000")
    project_export.add_argument("--format", default="PNG")
    project_export.add_argument("--output", required=True)
    project_export.set_defaults(func=cmd_project_export_glyph)

    convert = sub.add_parser("material-convert")
    convert.add_argument("--dir", required=True)
    convert.add_argument("--pattern", default="*")
    convert.add_argument("--format", required=True)
    convert.set_defaults(func=cmd_material_convert)

    resize = sub.add_parser("material-resize")
    resize.add_argument("--dir", required=True)
    resize.add_argument("--pattern", default="*")
    resize.add_argument("--width", default="")
    resize.add_argument("--height", default="")
    resize.set_defaults(func=cmd_material_resize)

    element = sub.add_parser("material-element")
    element.add_argument("--dir", required=True)
    element.add_argument("--pattern", default="*")
    element.add_argument("--element", required=True)
    element.add_argument("--mode", choices=["overlay", "replace", "stamp"], default="stamp")
    element.set_defaults(func=cmd_material_element)

    noise = sub.add_parser("material-noise")
    noise.add_argument("--dir", required=True)
    noise.add_argument("--pattern", default="*")
    noise.add_argument("--shape", choices=["circle", "square", "triangle"], default="circle")
    noise.add_argument("--shapes", default="")
    noise.add_argument("--direction", choices=["random", "vertical", "horizontal", "free"], default="random")
    noise.add_argument("--custom", default="")
    noise.add_argument("--size", default="10")
    noise.add_argument("--density", default="8")
    noise.set_defaults(func=cmd_material_noise)

    compose = sub.add_parser("compose")
    compose.add_argument("--base-font", required=True)
    compose.add_argument("--material-dir")
    compose.add_argument("--materials")
    compose.add_argument("--output")
    compose.add_argument("--english-name", default="")
    compose.add_argument("--chinese-name", default="")
    compose.add_argument("--version", default="")
    compose.add_argument("--copyright", default="")
    compose.set_defaults(func=cmd_compose)

    metadata = sub.add_parser("metadata")
    metadata.add_argument("--input", required=True)
    metadata.add_argument("--output", required=True)
    metadata.add_argument("--name-metadata", required=True)
    metadata.add_argument("--advanced-metadata", default="{}")
    metadata.set_defaults(func=cmd_metadata)

    create = sub.add_parser("project-create")
    create.add_argument("--source-ttf", required=True)
    create.add_argument("--output")
    create.set_defaults(func=cmd_project_create)

    open_project = sub.add_parser("project-open")
    open_project.add_argument("--project", required=True)
    open_project.set_defaults(func=cmd_project_open)

    glyph = sub.add_parser("project-glyph")
    glyph.add_argument("--project", required=True)
    glyph.add_argument("--code", required=True)
    glyph.set_defaults(func=cmd_project_glyph)

    save_glyph = sub.add_parser("project-save-glyph")
    save_glyph.add_argument("--project", required=True)
    save_glyph.add_argument("--code", required=True)
    save_glyph.add_argument("--glyph")
    save_glyph.add_argument("--glyph-file")
    save_glyph.set_defaults(func=cmd_project_save_glyph)

    update_codes = sub.add_parser("project-update-codes")
    update_codes.add_argument("--project", required=True)
    update_codes.add_argument("--codes-file", required=True)
    update_codes.set_defaults(func=cmd_project_update_codes)

    update_metadata = sub.add_parser("project-update-metadata")
    update_metadata.add_argument("--project", required=True)
    update_metadata.add_argument("--metadata-file", required=True)
    update_metadata.set_defaults(func=cmd_project_update_metadata)

    import_asset = sub.add_parser("import-glyph-asset")
    import_asset.add_argument("--input", required=True)
    import_asset.add_argument("--upm", required=True)
    import_asset.add_argument("--ascent", required=True)
    import_asset.add_argument("--descent", required=True)
    import_asset.add_argument("--advance", required=True)
    import_asset.set_defaults(func=cmd_import_glyph_asset)

    publish = sub.add_parser("project-publish")
    publish.add_argument("--project", required=True)
    publish.add_argument("--output")
    publish.add_argument("--font-type", default="ttf")
    publish.add_argument("--color-mode", default="compatible")
    publish.add_argument("--color-offset-x")
    publish.add_argument("--color-offset-y")
    publish.set_defaults(func=cmd_project_publish)

    args = parser.parse_args()
    try:
        args.func(args)
    except Exception as exc:
        emit({"success": False, "error": str(exc), "traceback": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
