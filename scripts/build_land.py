"""Construit data/land.json (polygones de terre) à partir du trait de côte OpenStreetMap.

Usage : python scripts/build_land.py coast.json data/land.json
coast.json = réponse Overpass de :
  [out:json];way["natural"="coastline"](45.3,-2.0,46.6,-0.85);out geom;
Le trait de côte OSM a la terre à gauche : les chaînes ouvertes sont refermées en suivant
le bord du cadre dans le sens trigonométrique. Données © contributeurs OpenStreetMap (ODbL).
"""
import json
import math
import sys

X0, Y0, X1, Y1 = -2.0, 45.3, -0.85, 46.6
W, H = X1 - X0, Y1 - Y0
P = 2 * W + 2 * H
sys.setrecursionlimit(100000)


def chains_from(ways):
    by_start = {}
    for i, (n, _) in enumerate(ways):
        by_start.setdefault(n[0], []).append(i)
    used, chains = set(), []
    for i, (n, g) in enumerate(ways):
        if i in used:
            continue
        used.add(i)
        nodes, pts = list(n), list(g)
        while nodes[-1] != nodes[0]:
            nxt = [j for j in by_start.get(nodes[-1], []) if j not in used]
            if not nxt:
                break
            j = nxt[0]
            used.add(j)
            nodes += ways[j][0][1:]
            pts += ways[j][1][1:]
        chains.append([nodes, pts])
    merged = True
    while merged:
        merged = False
        for a in range(len(chains)):
            if chains[a][0][0] == chains[a][0][-1]:
                continue
            for b in range(len(chains)):
                if a != b and chains[a][0][-1] == chains[b][0][0]:
                    chains[a] = [chains[a][0] + chains[b][0][1:], chains[a][1] + chains[b][1][1:]]
                    chains.pop(b)
                    merged = True
                    break
            if merged:
                break
    return chains


def inside(p):
    return X0 <= p[0] <= X1 and Y0 <= p[1] <= Y1


def crossings(p, q):
    out = []
    dx, dy = q[0] - p[0], q[1] - p[1]
    for x in (X0, X1):
        if dx:
            t = (x - p[0]) / dx
            y = p[1] + t * dy
            if 0 <= t <= 1 and Y0 - 1e-12 <= y <= Y1 + 1e-12:
                out.append((t, (x, y)))
    for y in (Y0, Y1):
        if dy:
            t = (y - p[1]) / dy
            x = p[0] + t * dx
            if 0 <= t <= 1 and X0 - 1e-12 <= x <= X1 + 1e-12:
                out.append((t, (x, y)))
    return sorted(out)


def perim(p):
    x, y = p
    if abs(y - Y0) < 1e-9:
        return x - X0
    if abs(x - X1) < 1e-9:
        return W + (y - Y0)
    if abs(y - Y1) < 1e-9:
        return W + H + (X1 - x)
    if abs(x - X0) < 1e-9:
        return 2 * W + H + (Y1 - y)
    return None


def simplify(pts, tol):
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy)
    best, idx = 0, 0
    for i in range(1, len(pts) - 1):
        if L < 1e-12:
            d = math.hypot(pts[i][0] - a[0], pts[i][1] - a[1])
        else:
            d = abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / L
        if d > best:
            best, idx = d, i
    if best > tol:
        return simplify(pts[: idx + 1], tol)[:-1] + simplify(pts[idx:], tol)
    return [a, b]


def main(src, dst, tol=0.0003):
    d = json.load(open(src, encoding="utf-8"))
    ways = [(e["nodes"], [(p["lon"], p["lat"]) for p in e["geometry"]]) for e in d["elements"] if "geometry" in e]
    chains = chains_from(ways)
    closed = [c[1] for c in chains if c[0][0] == c[0][-1]]
    opened = [c[1] for c in chains if c[0][0] != c[0][-1]]
    islands = [c for c in closed if all(inside(p) for p in c)]
    segs = []
    for pts in opened + [c for c in closed if not all(inside(p) for p in c)]:
        cur = [pts[0]] if inside(pts[0]) else []
        for i in range(1, len(pts)):
            q, p = pts[i - 1], pts[i]
            iq, ip = inside(q), inside(p)
            if iq and ip:
                cur.append(p)
            elif iq:
                cur.append(crossings(q, p)[0][1])
                segs.append(cur)
                cur = []
            elif ip:
                cur = [crossings(q, p)[-1][1], p]
            else:
                c = crossings(q, p)
                if len(c) >= 2:
                    segs.append([c[0][1], c[-1][1]])
        if len(cur) > 1:
            segs.append(cur)
    bsegs = [s for s in segs if perim(s[0]) is not None and perim(s[-1]) is not None]
    corners = [(W, (X1, Y0)), (W + H, (X1, Y1)), (2 * W + H, (X0, Y1)), (P, (X0, Y0))]
    rings, used = [], set()
    for k in range(len(bsegs)):
        if k in used:
            continue
        ring, cur = [], k
        while True:
            used.add(cur)
            ring += bsegs[cur]
            e = perim(bsegs[cur][-1])
            dist, j = min(((perim(bsegs[m][0]) - e) % P, m) for m in range(len(bsegs)))
            for cp, pt in sorted(corners, key=lambda c: (c[0] - e) % P):
                if 0 < (cp - e) % P < dist:
                    ring.append(pt)
            if j == k or j in used:
                break
            cur = j
        rings.append(ring)
    out = []
    for r in rings + islands:
        if r[0] == r[-1]:
            r = r[:-1]
        half = len(r) // 2
        s = simplify(r[: half + 1], tol)[:-1] + simplify(r[half:] + [r[0]], tol)[:-1]
        if len(s) >= 3:
            out.append([[round(x, 4), round(y, 4)] for x, y in s])
    json.dump(out, open(dst, "w"), separators=(",", ":"))
    print(f"{len(rings)} côtes ouvertes refermées, {len(islands)} îles, {len(out)} polygones, {sum(len(r) for r in out)} points")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
