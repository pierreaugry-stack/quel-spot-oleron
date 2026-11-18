"""Houle côtière haute résolution : WaveWatch III Météo-France (WW3-WARP, maillage côtier Atlantique).

Télécharge le dernier run (un fichier NetCDF de ~200 Mo, ~3 jours au pas horaire), puis produit :
- data/ww3.json : grille régulière de 0,01° (≈1 km) sur Ré, Oléron et la Côte Sauvage, pour la carte ;
  valeurs codées sur un octet et en base64 (hs par 5 cm, direction par 360/256°, période par 0,1 s) ;
- data/ww3_spots.json : séries horaires au point de modèle le plus proche de chaque spot
  (hauteur totale, houle principale, mer du vent, directions et périodes).
Clé : secret MF_API_KEY (API « Package Modèles de vague et surcote »).
"""
import base64
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
import netCDF4
from scipy.interpolate import LinearNDInterpolator

BASE = "https://public-api.meteofrance.fr/previnum/DPPaquetWAVESMODELS/v1"
KEY = os.environ.get("MF_API_KEY", "").strip()
BOX = dict(lat0=45.55, lat1=46.45, lon0=-1.95, lon1=-0.95, d=0.01)


def api(path, raw=False):
    req = urllib.request.Request(BASE + path, headers={"apikey": KEY, "accept": "*/*", "User-Agent": "quel-spot-oleron/ww3"})
    with urllib.request.urlopen(req, timeout=600) as r:
        b = r.read()
    return b if raw else json.loads(b.decode("utf-8"))


def latest_ref():
    pk = api("/models/WW3-WARP/grids/0.01/packages/SP1")
    refs = sorted(l["href"].split("referencetime=")[-1] for l in pk.get("links", []) if "referencetime=" in l.get("href", ""))
    return refs[-1]


def b64(arr, scale, cap=255):
    a = np.nan_to_num(np.asarray(arr, dtype="float64") / scale, nan=cap + 1)
    a = np.clip(np.round(a), 0, 255).astype(np.uint8)
    a[np.isnan(np.asarray(arr, dtype="float64"))] = 255  # 255 = pas de donnée (terre)
    return base64.b64encode(a.tobytes()).decode()


def main(out_dir="data"):
    if not KEY:
        print("MF_API_KEY absente"); return 0
    ref = latest_ref()
    print("run", ref)
    raw = api(f"/productWWARP?grid=0.01&package=SP1&referencetime={ref}&time=000H999H&format=nc", raw=True)
    fn = "/tmp/ww3.nc"
    open(fn, "wb").write(raw)
    print(f"{len(raw) / 1e6:.0f} Mo")
    ds = netCDF4.Dataset(fn)
    lat, lon = ds["latitude"][:].astype("float64"), ds["longitude"][:].astype("float64")
    t = ds["time"][:]
    t0 = datetime(1990, 1, 1, tzinfo=timezone.utc)
    times = [(t0 + timedelta(days=float(x))).replace(minute=0, second=0, microsecond=0) for x in t]
    m = (lat > BOX["lat0"] - 0.1) & (lat < BOX["lat1"] + 0.1) & (lon > BOX["lon0"] - 0.1) & (lon < BOX["lon1"] + 0.1)
    idx = np.where(m)[0]
    print(len(idx), "nœuds dans la zone sur", len(lat))
    pts = np.column_stack([lon[idx], lat[idx]])
    glat = np.round(np.arange(BOX["lat0"], BOX["lat1"] + 1e-9, BOX["d"]), 3)
    glon = np.round(np.arange(BOX["lon0"], BOX["lon1"] + 1e-9, BOX["d"]), 3)
    GX, GY = np.meshgrid(glon, glat)

    def var(name):
        v = ds[name][:, idx] if name in ds.variables else None
        return None if v is None else np.ma.filled(v.astype("float64"), np.nan)

    hs, dirm, tp = var("hs"), var("dir"), var("ptp")
    out = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "model": "WW3-WARP (Météo-France)", "run": ref,
           "lat0": float(glat[0]), "lon0": float(glon[0]), "d": BOX["d"], "nr": len(glat), "nc": len(glon),
           "times": [x.strftime("%Y-%m-%dT%H:%M:%SZ") for x in times], "hs": [], "dir": [], "tp": []}
    tri = None
    for k in range(len(times)):
        interp = LinearNDInterpolator(pts if tri is None else tri, hs[k]); tri = interp.tri
        H = interp(GX, GY)
        rad = np.deg2rad(dirm[k])
        S = LinearNDInterpolator(tri, np.sin(rad))(GX, GY); C = LinearNDInterpolator(tri, np.cos(rad))(GX, GY)
        D = (np.rad2deg(np.arctan2(S, C)) + 360) % 360
        T = LinearNDInterpolator(tri, tp[k])(GX, GY)
        out["hs"].append(b64(H, 0.05)); out["dir"].append(b64(D, 360 / 256)); out["tp"].append(b64(T, 0.1))
    with open(f"{out_dir}/ww3.json", "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("grille", len(glat), "x", len(glon), "sur", len(times), "h")

    # séries au point de modèle le plus proche de chaque spot (en mer)
    spots = json.load(open("spots.json", encoding="utf-8"))["spots"]
    sea = ds["MAPSTA"][:][idx] if "MAPSTA" in ds.variables else np.ones(len(idx))
    res = {"generated": out["generated"], "run": ref, "times": out["times"], "spots": {}}
    names = {"hs": "hs", "tp": "ptp", "dir": "dir", "hs0": "phs0", "tp0": "ptp0", "dir0": "pdir0", "hs1": "phs1", "tp1": "ptp1", "dir1": "pdir1", "hs2": "phs2", "tp2": "ptp2", "dir2": "pdir2"}
    for s in spots:
        dkm = np.hypot((lat[idx] - s["lat"]) * 111.3, (lon[idx] - s["lon"]) * 111.3 * np.cos(np.deg2rad(s["lat"])))
        dkm = np.where(np.asarray(sea) > 0, dkm, 1e9)
        j = int(np.argmin(dkm))
        node = int(idx[j])
        ser = {"lat": round(float(lat[node]), 4), "lon": round(float(lon[node]), 4), "dist_km": round(float(dkm[j]), 2)}
        for key, nm in names.items():
            if nm in ds.variables:
                v = np.ma.filled(ds[nm][:, node].astype("float64"), np.nan)
                ser[key] = [None if np.isnan(x) else round(float(x), 2) for x in v]
        res["spots"][s["id"]] = ser
        print(f"{s['id']}: nœud à {ser['dist_km']} km, Hs max {np.nanmax(ser['hs']) if ser.get('hs') else '–'} m")
    with open(f"{out_dir}/ww3_spots.json", "w", encoding="utf-8") as f:
        json.dump(res, f, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "data"))
