# -*- coding: utf-8 -*-
import glob, os, base64, io, re, json
from PIL import Image

def slugify(name):
    s = name.lower()
    for a, b in [('é','e'),('è','e'),('ê','e'),('à','a'),('ç','c'),
                 ('û','u'),('ô','o'),('î','i'),('ï','i')]:
        s = s.replace(a, b)
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')

root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
files = sorted(glob.glob(os.path.join(root, 'assets', 'arrows', '*.jpg')))
entries = []
for f in files:
    base = os.path.splitext(os.path.basename(f))[0]
    slug = slugify(base)
    im = Image.open(f).convert('RGBA')
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if min(r, g, b) > 240:
                px[x, y] = (255, 255, 255, 0)
    bbox = im.getbbox()
    if bbox:
        l, t, rr, bb = bbox
        pad = 2
        im = im.crop((max(0, l - pad), max(0, t - pad),
                      min(w, rr + pad), min(h, bb + pad)))
    iw, ih = im.size
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True)
    im.save(os.path.join(root, 'assets', 'arrows', slug + '.png'), 'PNG', optimize=True)
    uri = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
    label = base.strip()
    label = label[0].upper() + label[1:]
    entries.append((slug, label, iw, ih, uri))

L = []
L.append("// accessArrows.js — flèches d'accès (PNG transparents, base64 inline)")
L.append("// Généré depuis assets/arrows/*.jpg par assets/arrows/_gen.py")
L.append("// (le fond blanc des JPEG est rendu transparent). Régénérer plutôt qu'éditer à la main.")
L.append("// Le slug = usage métier, dérivé du nom du fichier source.")
L.append("")
L.append("export const ACCESS_ARROWS = {")
for slug, label, iw, ih, uri in entries:
    L.append("  " + json.dumps(slug) + ": { label: " + json.dumps(label)
             + ", w: " + str(iw) + ", h: " + str(ih)
             + ", src: " + json.dumps(uri) + " },")
L.append("};")
L.append("")
L.append("// Flèche par défaut de l'accès principal du site (placée juste après le périmètre).")
L.append('export const DEFAULT_SITE_ACCESS_ARROW = "site-vehicule-principal";')
L.append("")
L.append("export const ACCESS_ARROW_KEYS = Object.keys(ACCESS_ARROWS);")
L.append("")
L.append("export function accessArrowSrc(key) {")
L.append("  return (ACCESS_ARROWS[key] || ACCESS_ARROWS[DEFAULT_SITE_ACCESS_ARROW]).src;")
L.append("}")
L.append("")
L.append("export function accessArrowAspect(key) {")
L.append("  const a = ACCESS_ARROWS[key] || ACCESS_ARROWS[DEFAULT_SITE_ACCESS_ARROW];")
L.append("  return a.w / a.h;")
L.append("}")
L.append("")
out = os.path.join(root, 'accessArrows.js')
open(out, 'w', encoding='utf-8', newline='\n').write('\n'.join(L))
print('written', os.path.getsize(out), 'bytes,', len(entries), 'entries')
for e in entries:
    print(' ', e[0], '->', repr(e[1]), e[2], 'x', e[3])
