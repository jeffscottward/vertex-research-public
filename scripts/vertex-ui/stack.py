"""Vertical before/after review card: dark frame, red boxes on changed areas, caption.

Usage: python3 scripts/vertex-ui/stack.py <before> <after> <out> <title> <caption>
Called by scripts/vertex-ui/review.ts. Ported from the owner-approved
~/Documents/reports/vertex-ui-input-audit/stack.py (same layout and diff rule).
Needs Pillow (PIL). Prints "<out> <n> boxes".
"""
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageFilter

b_path, a_path, out, title, caption = sys.argv[1:6]
W = 1080
BG, FG, RED, MUTED = (17, 18, 20), (235, 236, 239), (237, 66, 69), (160, 165, 175)


def load(p):
    im = Image.open(p).convert("RGB")
    return im.resize((W, int(im.height * W / im.width)))


def font(sz):
    for f in (
        "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ):
        try:
            return ImageFont.truetype(f, sz)
        except OSError:
            pass
    return ImageFont.load_default(size=sz)


b, a = load(b_path), load(a_path)
h = max(b.height, a.height)
pb, pa = Image.new("RGB", (W, h), "white"), Image.new("RGB", (W, h), "white")
pb.paste(b, (0, 0)); pa.paste(a, (0, 0))
diff = ImageChops.difference(pb, pa).convert("L").point(lambda v: 255 if v > 40 else 0)
diff = diff.filter(ImageFilter.MaxFilter(25))
# connected boxes via coarse grid
boxes, step = [], 20
mask = diff.load()
seen = set()
cells = {(x // step, y // step) for y in range(0, h, step) for x in range(0, W, step) if mask[x, y]}
for c in cells:
    if c in seen:
        continue
    stack, comp = [c], []
    seen.add(c)
    while stack:
        cx, cy = stack.pop(); comp.append((cx, cy))
        for n in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
            if n in cells and n not in seen:
                seen.add(n); stack.append(n)
    xs = [p[0] for p in comp]; ys = [p[1] for p in comp]
    if len(comp) >= 4:
        boxes.append((min(xs) * step, min(ys) * step, (max(xs) + 1) * step, (max(ys) + 1) * step))


def mark(img):
    d = ImageDraw.Draw(img)
    for x0, y0, x1, y1 in boxes:
        if y0 < img.height:
            d.rectangle((x0, y0, min(x1, W - 2), min(y1, img.height - 2)), outline=RED, width=5)
    return img


b, a = mark(b), mark(a)
tf, lf, cf = font(44), font(34), font(30)
words, lines, cur = caption.split(), [], ""
for w in words:
    t = (cur + " " + w).strip()
    if ImageDraw.Draw(Image.new("RGB", (1, 1))).textlength(t, font=cf) > W - 80:
        lines.append(cur); cur = w
    else:
        cur = t
lines.append(cur)
H = 110 + 60 + b.height + 30 + 60 + a.height + 40 + 46 * len(lines) + 60
out_im = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(out_im)
y = 40
d.text((40, y), title, fill=FG, font=tf); y += 90
d.text((40, y), "BEFORE", fill=MUTED, font=lf); y += 50
out_im.paste(b, (0, y)); y += b.height + 30
d.text((40, y), "AFTER  (red boxes = what changed)", fill=MUTED, font=lf); y += 50
out_im.paste(a, (0, y)); y += a.height + 40
for ln in lines:
    d.text((40, y), ln, fill=FG, font=cf); y += 46
out_im.save(out, quality=85)
print(out, len(boxes), "boxes")
