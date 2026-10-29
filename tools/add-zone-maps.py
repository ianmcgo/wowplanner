import glob
import json
import os
import re
import sys

from PIL import Image, ImageDraw

SRC = sys.argv[1] if len(sys.argv) > 1 else 'wow.export/zones'
OUT = 'static/maps'
CHECK = sys.argv[2] if len(sys.argv) > 2 else None
LOC = 'static/loc'
INSTANCES = 'static/instance-drops.json'


def norm(s):
    return re.sub(r'[^a-z0-9]', '', s.lower().replace('the ', ''))


index_path = os.path.join(OUT, 'index.json')
index = json.load(open(index_path)) if os.path.exists(index_path) else {'zones': {}, 'instances': {}}
inst_names = [i[0] for i in json.load(open(INSTANCES))['instances']]
inst_by_norm = {norm(n): n for n in inst_names}

files = sorted(glob.glob(os.path.join(SRC, 'Zone_*.png')))
pts = {}
if CHECK:
    for f in glob.glob(os.path.join(LOC, '[0-9]*.json')):
        d = json.load(open(f))
        for v in d['npcs'].values():
            for a, p in v[5].items():
                pts.setdefault(a, []).extend(p)
        for v in d['objects'].values():
            for a, p in v[1].items():
                pts.setdefault(a, []).extend(p)

sheet = []
for path in files:
    m = re.match(r'Zone_(\d+)_(.+)\.png$', os.path.basename(path))
    if not m:
        continue
    area = m.group(1)
    name = m.group(2).rsplit('_', 1)[0].replace('_', ' ')
    img = Image.open(path).convert('RGBA')
    bg = Image.new('RGBA', img.size, (24, 32, 49, 255))
    bg.alpha_composite(img)
    rgb = bg.convert('RGB')
    key = f'z{area}'
    out = os.path.join(OUT, key + '.webp')
    rgb.save(out, 'WEBP', quality=80, method=6)
    kb = os.path.getsize(out) // 1024
    index['zones'][area] = {'w': img.size[0], 'h': img.size[1], 'src': 'zone', 'name': name, 'kb': kb}
    inst = inst_by_norm.get(norm(name))
    cur = index['instances'].get(inst) if inst else None
    if inst and (not cur or cur.get('src') == 'zone'):
        index['instances'][inst] = {'img': key, 'w': img.size[0], 'h': img.size[1], 'src': 'zone', 'kb': kb}
    if CHECK:
        c = rgb.copy()
        dr = ImageDraw.Draw(c)
        W, H = c.size
        for x, y in pts.get(area, []):
            X, Y = x / 100 * W, y / 100 * H
            dr.ellipse([X - 3, Y - 3, X + 3, Y + 3], fill=(255, 40, 40))
        dr.rectangle([0, 0, 330, 26], fill=(0, 0, 0))
        dr.text((6, 6), f'{area} {name} {len(pts.get(area, []))} pts', fill=(255, 255, 0))
        sheet.append(c.resize((501, 334)))
    print(area, name, kb, 'KB', 'instance: ' + inst if inst else '')

json.dump(index, open(index_path, 'w'), indent=1)
if CHECK and sheet:
    cols = 2
    rows = (len(sheet) + cols - 1) // cols
    s = Image.new('RGB', (501 * cols, 334 * rows))
    for i, t in enumerate(sheet):
        s.paste(t, ((i % cols) * 501, (i // cols) * 334))
    s.save(CHECK)
