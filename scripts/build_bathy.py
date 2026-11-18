"""Construit data/bathy.json (profondeurs) à partir de la bathymétrie EMODnet (GeoTIFF float32).

Téléchargement :
  https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=1.0.0&request=GetCoverage
    &coverage=emodnet:mean&crs=EPSG:4326&BBOX=-2.0,45.3,-0.85,46.6&format=GeoTIFF&width=230&height=260
Usage : python scripts/build_bathy.py bathy.tif data/bathy.json
Sortie : grille 0,005°, profondeur en décimètres (positive vers le bas), 32767 = terre / pas de donnée,
encodée en Int16 petit-boutiste puis base64. Données © EMODnet Bathymetry Consortium.
"""
import base64
import json
import struct
import sys

BBOX = (-2.0, 45.3, -0.85, 46.6)
TYPES = {1: ("B", 1), 3: ("H", 2), 4: ("I", 4), 11: ("f", 4), 12: ("d", 8), 16: ("Q", 8)}


def read_tiff(path):
    b = open(path, "rb").read()
    bo = "<" if b[:2] == b"II" else ">"
    off = struct.unpack(bo + "I", b[4:8])[0]
    n = struct.unpack(bo + "H", b[off:off + 2])[0]
    tags = {}
    for i in range(n):
        e = b[off + 2 + 12 * i: off + 14 + 12 * i]
        tag, typ, cnt = struct.unpack(bo + "HHI", e[:8])
        if typ not in TYPES:
            continue
        f, s = TYPES[typ]
        data = e[8:12] if s * cnt <= 4 else b[struct.unpack(bo + "I", e[8:12])[0]:][: s * cnt]
        tags[tag] = struct.unpack(bo + f * cnt, data[: s * cnt])
    w, h = tags[256][0], tags[257][0]
    assert tags[259][0] == 1 and tags[258][0] == 32, "TIFF non compressé float32 attendu"
    grid = [[None] * w for _ in range(h)]
    if 324 in tags:  # tuiles
        tw, th = tags[322][0], tags[323][0]
        across = (w + tw - 1) // tw
        for k, o in enumerate(tags[324]):
            ty, tx = divmod(k, across)
            vals = struct.unpack(bo + "f" * (tw * th), b[o: o + 4 * tw * th])
            for r in range(th):
                y = ty * th + r
                if y >= h:
                    break
                for c in range(tw):
                    x = tx * tw + c
                    if x < w:
                        grid[y][x] = vals[r * tw + c]
    else:  # bandes
        rps = tags[278][0]
        for k, o in enumerate(tags[273]):
            rows = min(rps, h - k * rps)
            vals = struct.unpack(bo + "f" * (w * rows), b[o: o + 4 * w * rows])
            for r in range(rows):
                grid[k * rps + r] = list(vals[r * w:(r + 1) * w])
    return w, h, grid


def main(src, dst):
    w, h, g = read_tiff(src)
    out = bytearray()
    sea = 0
    for y in range(h - 1, -1, -1):  # ligne 0 = sud
        for x in range(w):
            v = g[y][x]
            if v is None or v != v or v > -0.2 or v < -9000:
                d = 32767
            else:
                d = int(round(-v * 10))
                sea += 1
            out += struct.pack("<h", min(d, 32767))
    dx = (BBOX[2] - BBOX[0]) / w
    dy = (BBOX[3] - BBOX[1]) / h
    json.dump({"x0": BBOX[0] + dx / 2, "y0": BBOX[1] + dy / 2, "dx": dx, "dy": dy, "nx": w, "ny": h,
               "unit": "dm", "land": 32767, "depth": base64.b64encode(bytes(out)).decode()},
              open(dst, "w"), separators=(",", ":"))
    print(f"{w}x{h}, {sea} cellules en mer ({100 * sea // (w * h)} %)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
