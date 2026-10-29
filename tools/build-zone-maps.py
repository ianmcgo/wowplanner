import glob
import json
import os
import sys

from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else 'wow.export/maps'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'static/maps'
BOUNDS = 'static/map-bounds.json'
LOC = 'static/loc'
TILE = 533.33333
PX = 512
ZONE_W = 1000
INST_MAX = 1000

ZONES = [
    (4720, [174], 'lostisles'),
    (4737, [194], 'lostisles'),
    (4714, [179], 'gilneas'),
    (4755, [202], 'gilneas'),
    (5736, [378], 'newracestartzone'),
    (5861, [407], 'darkmoonfaire'),
    (2597, [91], 'pvpzone01'),
    (2437, [213], 'orgrimmarinstance'),
    (6052, [431, 432], 'scarletsanctuaryarmoryandlibrary'),
    (6109, [435, 436], 'scarletmonasterycathedralgy'),
]

INSTANCES = {
    'Ragefire Chasm': 'orgrimmarinstance',
    'Wailing Caverns': 'wailingcaverns',
    'Shadowfang Keep': 'shadowfang',
    'The Stockade': 'stormwindjail',
    'Blackfathom Deeps': 'blackfathom',
    'Razorfen Kraul': 'razorfenkraulinstance',
    'Uldaman': 'uldaman',
    'Maraudon': 'mauradon',
    'Blackrock Depths': 'blackrockdepths',
    'Blackrock Spire': 'blackrockspire',
    'Stratholme': 'stratholme',
    'Molten Core': 'moltencore',
    "Zul'Gurub": "zul'gurub",
    'Scarlet Halls': 'scarletsanctuaryarmoryandlibrary',
    'Scarlet Monastery': 'scarletmonasterycathedralgy',
}

bounds = json.load(open(BOUNDS))


def region(ui):
    rows = [a for a in bounds['assign'] if a[0] == ui]
    rows.sort(key=lambda a: a[3])
    a = rows[0]
    u0, v0, u1, v1 = a[6:10]
    minx, miny, maxx, maxy = a[10], a[11], a[13], a[14]
    sx = (maxx - minx) / ((v1 - v0) or 1)
    sy = (maxy - miny) / ((u1 - u0) or 1)
    top = maxx + v0 * sx
    left = maxy + u0 * sy
    return {'top': top, 'bottom': top - sx, 'left': left, 'right': left - sy}


def mosaic(folder):
    tiles = {}
    for p in glob.glob(os.path.join(folder, 'minimap', 'map*_*.png')):
        a, b = os.path.basename(p)[3:-4].split('_')
        tiles[(int(a), int(b))] = p
    if not tiles:
        return None
    xs = [k[0] for k in tiles]
    ys = [k[1] for k in tiles]
    x0, y0 = min(xs), min(ys)
    img = Image.new('RGBA', ((max(xs) - x0 + 1) * PX, (max(ys) - y0 + 1) * PX), (0, 0, 0, 0))
    for (a, b), p in tiles.items():
        t = Image.open(p).convert('RGBA')
        if t.size != (PX, PX):
            t = t.resize((PX, PX))
        img.paste(t, ((a - x0) * PX, (b - y0) * PX))
    return img, x0, y0


def wmo(folder):
    js = glob.glob(os.path.join(folder, '*_wmo_minimap.json'))
    if not js:
        return None
    meta = json.load(open(js[0]))
    img = Image.open(js[0].replace('.json', '.png')).convert('RGBA')
    c = meta['corners']
    return img, c['top_left']['world_x'], c['bottom_right']['world_x'], c['top_left']['world_y'], c['bottom_right']['world_y']


def render(folder, r, width):
    w = width
    h = max(1, round(width * (r['top'] - r['bottom']) / (r['left'] - r['right'])))
    m = wmo(folder)
    if m:
        img, xa, xb, ya, yb = m
        W, H = img.size
        a = 0
        b = -(r['top'] - r['bottom']) / h * W / (xb - xa)
        c = (r['top'] - xa) * W / (xb - xa)
        d = -(r['left'] - r['right']) / w * H / (yb - ya)
        e = 0
        f = (r['left'] - ya) * H / (yb - ya)
        return img.transform((w, h), Image.AFFINE, (a, b, c, d, e, f), resample=Image.BILINEAR)
    m = mosaic(folder)
    if not m:
        return None
    img, x0, y0 = m
    left = (32 - r['left'] / TILE - x0) * PX
    right = (32 - r['right'] / TILE - x0) * PX
    top = (32 - r['top'] / TILE - y0) * PX
    bottom = (32 - r['bottom'] / TILE - y0) * PX
    return img.transform((w, h), Image.EXTENT, (left, top, right, bottom), resample=Image.BILINEAR)


def area_points(area):
    pts = []
    for f in glob.glob(os.path.join(LOC, '[0-9]*.json')):
        d = json.load(open(f))
        for v in d['npcs'].values():
            pts += v[5].get(str(area), [])
        for v in d['objects'].values():
            pts += v[1].get(str(area), [])
    return pts


def coverage(img):
    a = img.getchannel('A').point(lambda v: 255 if v > 24 else 0)
    return sum(a.histogram()[255:]) / (img.size[0] * img.size[1])


def score(img, pts):
    if not pts:
        return 0
    a = img.getchannel('A')
    w, h = img.size
    hit = 0
    for x, y in pts:
        px, py = int(x / 100 * (w - 1)), int(y / 100 * (h - 1))
        if 0 <= px < w and 0 <= py < h and a.getpixel((px, py)) > 24:
            hit += 1
    return hit / len(pts)


def save(img, name):
    bg = Image.new('RGBA', img.size, (24, 32, 49, 255))
    bg.alpha_composite(img)
    path = os.path.join(OUT, name + '.webp')
    bg.convert('RGB').save(path, 'WEBP', quality=72, method=6)
    return os.path.getsize(path)


os.makedirs(OUT, exist_ok=True)
index = {'zones': {}, 'instances': {}}
report = []
for area, uis, d in ZONES:
    folder = os.path.join(SRC, d)
    if not os.path.isdir(folder):
        continue
    pts = area_points(area)
    best = None
    for ui in uis:
        img = render(folder, region(ui), ZONE_W)
        if img is None:
            continue
        cov, hit = coverage(img), score(img, pts)
        report.append((area, ui, round(cov, 3), round(hit, 3), len(pts)))
        if best is None or (hit, cov) > (best[2], best[1]):
            best = (img, cov, hit, ui)
    if not best or best[1] < 0.15 or best[2] < 0.8:
        continue
    size = save(best[0], f'z{area}')
    index['zones'][str(area)] = {'w': best[0].size[0], 'h': best[0].size[1], 'ui': best[3], 'hit': round(best[2], 3), 'kb': size // 1024}

for name, d in INSTANCES.items():
    folder = os.path.join(SRC, d)
    if not os.path.isdir(folder):
        continue
    mid = bounds['maps'].get(d, [0])[0]
    uis = sorted({a[0] for a in bounds['assign'] if a[1] == mid})
    regs = [region(u) for u in uis]
    if not regs:
        continue
    r = {'top': max(x['top'] for x in regs), 'bottom': min(x['bottom'] for x in regs), 'left': max(x['left'] for x in regs), 'right': min(x['right'] for x in regs)}
    img = render(folder, r, 2000)
    if img is None:
        continue
    box = img.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
    if not box:
        continue
    img = img.crop(box)
    s = INST_MAX / max(img.size)
    if s < 1:
        img = img.resize((round(img.size[0] * s), round(img.size[1] * s)), Image.LANCZOS)
    if coverage(img) < 0.05:
        continue
    key = 'i' + ''.join(ch for ch in name.lower() if ch.isalnum())
    size = save(img, key)
    index['instances'][name] = {'img': key, 'w': img.size[0], 'h': img.size[1], 'kb': size // 1024}

json.dump(index, open(os.path.join(OUT, 'index.json'), 'w'), indent=1)
for r in report:
    print('zone', *r)
print(json.dumps(index, indent=1))
